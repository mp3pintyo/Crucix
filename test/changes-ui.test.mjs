import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { CHANGE_CAPS, buildChanges, mergeChanges } from '../lib/sweeps/changes.mjs';
import { DOMAIN_IDS } from '../lib/domains.mjs';

// The "What changed" panel and the header chip (changes.js) in a vm realm with a small fake DOM. panelHtml()/chipHtml() return
// markup; the fake DOM parses that markup into nodes so the delegated clicks, the in-place redraw and the focus code run for real.
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('dashboard/public/jarvis.html');
const tick = () => new Promise(resolve => setImmediate(resolve));
const count = (text, pattern) => (text.match(pattern) || []).length;
const flatten = (value, prefix) => Object.entries(value || {}).flatMap(([key, item]) => item && typeof item === 'object' ? flatten(item, `${prefix}.${key}`) : [[`${prefix}.${key}`, item]]);
const strings = lang => { const data = JSON.parse(read(`locales/${lang}.json`)); return new Map(['changes', 'lenses', 'inspector', 'matrix', 'panels'].flatMap(group => flatten(data[group], group))); };
const localT = lang => { const table = strings(lang); return (key, fallback) => table.has(key) ? table.get(key) : (fallback ?? key); };
const EN = strings('en');

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
const decode = text => text.replace(/&(?:lt|gt|quot|#39|amp);/g, entity => ENTITIES[entity]);
function parseMarkup(markup, doc, root) {
  const holder = { kids: [] }, stack = [holder];
  const token = /<(\/?)([a-zA-Z][\w]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*>|([^<]+)/g;
  for (let match; (match = token.exec(markup));) {
    const top = stack[stack.length - 1], parent = top === holder ? root : top;
    if (match[4] !== undefined) { const text = new Node('#text', doc); text.textContent = decode(match[4]); text.parentNode = parent; top.kids.push(text); continue; }
    if (match[1]) { while (stack.length > 1 && stack.pop().tag !== match[2]); continue; }
    const node = new Node(match[2], doc);
    for (const attribute of match[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attribute[1], decode(attribute[2] ?? ''));
    node.parentNode = parent; top.kids.push(node); stack.push(node);
  }
  return holder.kids;
}
class Node {
  constructor(tag, doc) { Object.assign(this, { tag, doc, attrs: new Map(), kids: [], parentNode: null, markup: '', listeners: {}, own: '', focused: 0, focusOptions: [], scrolled: [] }); }
  get textContent() { return this.own; }
  set textContent(value) { this.own = String(value); this.kids = []; }
  get id() { return this.attrs.get('id') || ''; }
  get innerHTML() { return this.markup; }
  set innerHTML(value) { this.markup = String(value); this.kids = parseMarkup(this.markup, this.doc, this); }
  set outerHTML(value) { const parent = this.parentNode, fresh = parseMarkup(String(value), this.doc, parent); parent.kids.splice(parent.kids.indexOf(this), 1, ...fresh); parent.swaps = (parent.swaps || 0) + 1; if (parent.kids.length === 1) parent.markup = String(value); this.parentNode = null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  focus(options) { this.focused++; this.focusOptions.push(options); this.doc.activeElement = this; }
  scrollIntoView(options) { this.scrolled.push(options); }
  contains(node) { for (let at = node; at; at = at.parentNode) if (at === this) return true; return false; }
  matches(selector) {
    const [, tag, rest] = /^([\w-]*)(.*)$/.exec(selector);
    if (tag && this.tag !== tag) return false;
    for (const part of rest.match(/\.[\w-]+|#[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) || []) {
      if (part[0] === '.') { if (!(this.attrs.get('class') || '').split(' ').includes(part.slice(1))) return false; continue; }
      if (part[0] === '#') { if (this.id !== part.slice(1)) return false; continue; }
      const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
      if (!this.attrs.has(name) || (value !== undefined && this.attrs.get(name) !== value)) return false;
    }
    return true;
  }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.tag !== '#text' && node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { return all(this).slice(1).filter(node => node.tag !== '#text' && selector.split(',').some(part => node.matches(part.trim()))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  text() { return this.own + this.kids.map(kid => kid.text()).join(''); }
}
function all(node) { return [node, ...node.kids.flatMap(all)]; }

const NOW = Date.parse('2026-10-03T10:00:00.000Z');
// The rows each list shows until its "Show all" button is used (SHOW in changes.js, checked below): a layout-independent bound on the panel's height.
const SHOW = 3;
const ID = number => 'event-' + number.toString(16).padStart(32, '0');
const defer = () => { const out = {}; out.promise = new Promise((resolve, reject) => { out.resolve = resolve; out.reject = reject; }); return out; };

function realm({ lens = 'all', replay = false, t = localT('en'), locale = 'en-US', changes, fetchJson = url => Promise.reject(new Error('no route for ' + url)), openEvent = () => {}, openMatrix = () => {}, panelShown = true, records = true } = {}) {
  const errors = [];
  const doc = { activeElement: null, listeners: {} };
  doc.body = new Node('body', doc);
  doc.createElement = tag => new Node(tag, doc);
  doc.getElementById = id => all(doc.body).find(node => node.id === id) || null;
  doc.addEventListener = (type, fn) => { (doc.listeners[type] ||= []).push(fn); };
  doc.fire = (type, event) => { for (const fn of doc.listeners[type] || []) fn(event); };
  const rail = new Node('div', doc); rail.attrs.set('id', 'rightRail'); rail.parentNode = doc.body; doc.body.kids.push(rail);
  const bar = new Node('div', doc); bar.attrs.set('id', 'topbar'); bar.parentNode = doc.body; doc.body.kids.push(bar);
  const state = { lens, replay, changes, now: NOW, shown: panelShown };
  const window = { document: doc, matchMedia: () => ({ matches: false }) };
  const context = vm.createContext({ window, document: doc, console: { error: (...args) => errors.push(args) }, Date, Object, Array, Number, JSON, Set, Map, String, Promise, Math });
  for (const file of records ? ['domains.js', 'lens-core.js', 'record-core.js'] : ['domains.js', 'lens-core.js']) vm.runInContext(read('dashboard/public/' + file), context);
  window.CrucixLens = { get: () => state.lens };
  vm.runInContext(read('dashboard/public/changes.js'), context);
  const api = window.CrucixChanges;
  const options = { t, locale, now: () => state.now, getChanges: () => state.changes, panelShown: () => state.shown, isReplay: () => state.replay, fetchJson, openEvent, openMatrix };
  const draw = () => { rail.innerHTML = api.panelHtml(state.changes); };
  const strip = () => { bar.innerHTML = api.chipHtml(state.changes, state.lens); };
  return { api, window, doc, rail, bar, state, errors, options, draw, strip, mount: extra => api.mount({ ...options, ...extra }), panel: () => doc.getElementById('changesPanel') };
}
const mounted = (settings, extra) => { const r = realm(settings); r.mount(extra); return r; };
const click = (r, node) => r.doc.fire('click', { target: node });
const win = (r, id) => r.rail.querySelector(`[data-changes-window="${id}"]`);
const pressed = r => r.rail.querySelectorAll('[data-changes-window]').filter(node => node.getAttribute('aria-pressed') === 'true').map(node => node.getAttribute('data-changes-window'));
const titles = r => r.rail.querySelectorAll('.ch-title').map(node => node.text());

const FULL = {
  since: '2026-10-03T09:45:00.000Z', at: '2026-10-03T10:00:00.000Z', baseline: false,
  events: { new: [
    { id: ID(1), title: 'Strong earthquake near Kobe', kind: 'earthquake', source: 'USGS', domain: 'hazards', severity: 'critical', observedAt: '2026-10-03T09:57:00.000Z' },
    { id: ID(2), title: 'Port congestion rising', kind: 'maritime', source: 'IMF-PortWatch', domain: 'supply', severity: 'watch', observedAt: '2026-10-03T08:00:00.000Z' },
    { id: ID(3), title: 'Headline without a source or a level', kind: 'news', source: '', domain: null, severity: null, observedAt: null },
  ], newTotal: 3, expiredTotal: 1 },
  sources: [{ source: 'GDELT', domain: 'security', from: 'ok', to: 'error' }, { source: 'NOAA-SWPC', domain: 'space', from: 'stale', to: 'ok' }],
  signals: [{ key: 'vix', label: 'VIX', direction: 'up', severity: 'high', type: 'escalated' }, { key: 'tg_urgent:1', label: 'Urgent post', direction: null, severity: null, type: 'new' }],
  domains: { security: 1, hazards: 1, space: 1, supply: 1 },
};
const MERGED = {
  since: '2026-10-03T03:45:00.000Z', at: '2026-10-03T10:00:00.000Z', baseline: false,
  events: { new: [{ id: ID(9), title: 'Older flood warning', kind: 'disaster', source: 'GDACS', domain: 'hazards', severity: 'high', observedAt: '2026-10-03T05:00:00.000Z' }], newTotal: 57, expiredTotal: 4 },
  sources: [{ source: 'USGS', domain: 'hazards', from: 'ok', to: 'stale' }], signals: [], domains: { hazards: 20, security: 3 },
};
const BASELINE = { since: null, at: '2026-10-03T10:00:00.000Z', baseline: true, events: { new: [], newTotal: 0, expiredTotal: 0 }, sources: [], signals: [], domains: {} };
const EMPTY = { since: '2026-10-03T09:45:00.000Z', at: '2026-10-03T10:00:00.000Z', baseline: false, events: { new: [], newTotal: 0, expiredTotal: 0 }, sources: [], signals: [], domains: {} };

// An event-handler attribute in the name position of a tag (attribute values are skipped whole, so escaped text is not a handler).
const HANDLER = /<[a-z][\w-]*(?:\s+[\w:-]+(?:="[^"]*")?)*?\s+on\w+(?:=|[\s>])/i;

test('the handler matcher flags a real handler and not escaped text inside a value', () => {
  assert.ok(HANDLER.test('<img src="x" onerror="alert(1)">') && HANDLER.test('<button class="a" onclick=alert(1)>'));
  assert.ok(!HANDLER.test('<button data-x="&lt;img src=x onerror=alert(1)&gt;"><span>onerror=1</span></button>'));
});

// ===== panelHtml =====

test('panelHtml: a full object renders the three sections, the window buttons, the since time and the domain chips', () => {
  const { api } = mounted({ changes: FULL });
  const out = api.panelHtml(FULL);
  assert.match(out, /^<div class="g-panel changes-panel" id="changesPanel" role="region" aria-labelledby="changesTitle"/);
  assert.match(out, /<h3 id="changesTitle" tabindex="-1">What changed<\/h3>/);
  assert.ok(out.includes('<time datetime="2026-10-03T09:45:00.000Z">') && out.includes('Since '), 'the since time');
  assert.deepEqual([...out.matchAll(/data-changes-window="([^"]+)" aria-pressed="(\w+)"[^>]*>([^<]+)</g)].map(match => [match[1], match[2], match[3]]),
    [['last', 'true', 'Last sweep'], ['1h', 'false', '1 h'], ['6h', 'false', '6 h'], ['24h', 'false', '24 h']]);
  assert.deepEqual([...out.matchAll(/<section class="ch-sec" data-changes-section="(\w+)"/g)].map(match => match[1]), ['records', 'sources', 'signals']);
  assert.ok(out.includes('New records') && out.includes('Source changes') && out.includes('Signals'));
  assert.deepEqual([...out.matchAll(/class="ch-dom" data-domain="(\w+)"><span class="ch-dom-name">([^<]+)<\/span> <span class="ch-dom-n">(\d+)<\/span>/g)].map(match => [match[1], match[2], match[3]]),
    [['security', 'Security and conflict', '1'], ['hazards', 'Natural hazards and weather', '1'], ['space', 'Space', '1'], ['supply', 'Energy and supply chain', '1']], 'registry order, named from the lenses group');
  assert.ok(!out.includes('ch-cap'), 'nothing is capped, so there is no cap note');
  assert.ok(!out.includes('role="status"') && !out.includes('aria-busy'), 'no loading or error line');
  assert.ok(!out.includes('aria-disabled'), 'live: every window is available');
});

test('panelHtml: a record row has the severity glyph AND word, the title, the source and the age, and opens the record by its id', () => {
  const { api } = mounted({ changes: FULL });
  const out = api.panelHtml(FULL);
  const rows = [...out.matchAll(/<li class="ch-item"><button type="button" class="ch-row" id="changes-ev-([^"]+)" data-changes-event="([^"]+)">(.*?)<\/button><\/li>/g)];
  assert.deepEqual(rows.map(match => match[2]), [ID(1), ID(2), ID(3)]);
  assert.deepEqual(rows.map(match => match[1]), rows.map(match => match[2]), 'the button id is changes-ev-<event id>');
  assert.match(rows[0][3], /<span class="ch-sev sev-critical"><i aria-hidden="true">◆<\/i> Critical<\/span><span class="ch-title">Strong earthquake near Kobe<\/span>/);
  assert.match(rows[0][3], /<span class="ch-source">USGS<\/span><span class="ch-age" data-changes-time="2026-10-03T09:57:00.000Z" title="2026-10-03 09:57:00 UTC">3m<\/span>/, 'the age from the page clock');
  assert.match(rows[1][3], /<span class="ch-sev sev-watch"><i aria-hidden="true">●<\/i> Watch<\/span>/);
  assert.ok(rows[1][3].includes('>2h</span>'), 'two hours old');
  assert.match(rows[2][3], /<span class="ch-sev sev-unknown"><i aria-hidden="true">–<\/i> Unknown<\/span>/, 'a null severity is the unknown dash');
  assert.ok(!rows[2][3].includes('ch-source'), 'no source, no source label');
  assert.match(rows[2][3], /<span class="ch-age"[^>]*>—<\/span>/, 'an unknown time is a dash');
  assert.equal(count(out, /data-changes-event=/g), 3);
});

test('panelHtml: a source change shows from and to as glyph and word, and opens the matrix; a signal shows its level and type', () => {
  const { api } = mounted({ changes: FULL, openMatrix: () => {} });
  const out = api.panelHtml(FULL);
  const rows = [...out.matchAll(/<li class="ch-item"><button type="button" class="ch-row ch-src" data-changes-source="([^"]+)">(.*?)<\/button><\/li>/g)];
  assert.deepEqual(rows.map(match => match[1]), ['GDELT', 'NOAA-SWPC']);
  assert.ok(rows[0][2].includes('<span class="ch-name">GDELT</span>'));
  assert.ok(rows[0][2].includes('<span class="ch-state" data-state="ok"><i aria-hidden="true">✓</i> OK</span>'));
  assert.ok(rows[0][2].includes('<span class="ch-state" data-state="error"><i aria-hidden="true">✕</i> Error</span>'));
  assert.ok(rows[0][2].includes('<span class="ch-sr">changed to</span>'), 'the arrow is hidden from screen readers, which hear the words');
  assert.ok(rows[1][2].includes('data-state="stale"><i aria-hidden="true">◔</i> Stale') && rows[1][2].includes('data-state="ok"'));
  const signals = [...out.matchAll(/<li class="ch-item ch-sig" data-signal="([^"]+)">(.*?)<\/li>/g)];
  assert.deepEqual(signals.map(match => match[1]), ['vix', 'tg_urgent:1']);
  assert.ok(signals[0][2].includes('<span class="ch-sev sev-high"><i aria-hidden="true">▲</i> High</span><span class="ch-title">VIX</span>'));
  assert.ok(signals[0][2].includes('<span class="ch-type" data-type="escalated"><i aria-hidden="true">▲</i> Escalated</span>'));
  assert.ok(signals[1][2].includes('sev-unknown') && signals[1][2].includes('data-type="new"><i aria-hidden="true">+</i> New'), 'a null severity and a new signal');
});

test('panelHtml: a source change is plain text without an openMatrix hook, a record without an openEvent hook', () => {
  const r = mounted({ changes: FULL, openEvent: null, openMatrix: null });
  const out = r.api.panelHtml(FULL);
  assert.ok(!out.includes('data-changes-source') && !out.includes('data-changes-event'));
  assert.ok(out.includes('GDELT') && out.includes('Strong earthquake near Kobe'));
  assert.equal(count(out, /<button /g), 4, 'only the four window buttons');
  const hooked = mounted({ changes: FULL, openEvent: null, openMatrix: () => {} }).api.panelHtml(FULL);
  assert.ok(hooked.includes('data-changes-source') && !hooked.includes('data-changes-event'));
});

test('panelHtml: a baseline object says "first sweep, nothing to compare" and lists nothing', () => {
  const { api } = mounted({ changes: BASELINE, openEvent() {}, openMatrix() {} });
  const out = api.panelHtml(BASELINE);
  assert.match(out, /<p class="ch-note ch-calm" data-changes-state="baseline">First sweep, nothing to compare yet\./);
  assert.ok(!out.includes('ch-sec') && !out.includes('ch-domains') && !out.includes('<time') && !out.includes('badge'));
  assert.ok(out.includes('data-changes-window="last"'), 'the window buttons stay');
  const stray = api.panelHtml({ ...FULL, baseline: true });
  assert.ok(!stray.includes('ch-sec') && !stray.includes('ch-domains') && !stray.includes('badge') && stray.includes('data-changes-state="baseline"'), 'a baseline lists nothing, whatever else the object holds');
  assert.ok(!stray.includes('<time'), 'and compares with nothing, so it names no since time');
  assert.equal(api.chipHtml({ ...FULL, baseline: true }, 'all'), '', 'and has no chip');
});

test('panelHtml: an empty object (no new records, transitions or signals) is a calm "nothing changed" line', () => {
  const { api } = mounted({ changes: EMPTY, openEvent() {}, openMatrix() {} });
  const out = api.panelHtml(EMPTY);
  assert.match(out, /<p class="ch-note ch-calm" data-changes-state="nothing">Nothing changed since the previous sweep\.<\/p>/);
  assert.ok(!out.includes('ch-sec') && !out.includes('ch-domains'));
  assert.ok(out.includes('<time datetime="2026-10-03T09:45:00.000Z">'), 'the since time stays');
});

test('panelHtml: no changes object (undefined, null, a non-object) is "appears after the first sweep"; it never throws', () => {
  const { api } = mounted({ changes: undefined });
  for (const value of [undefined, null, 'x', 42, [], true]) {
    const out = api.panelHtml(value);
    assert.match(out, /data-changes-state="waiting">Changes appear once the first sweep has finished\./, String(value));
    assert.ok(!out.includes('ch-sec'));
  }
  assert.ok(api.panelHtml(undefined).includes('id="changesTitle"'), 'the heading stays, so the chip has a target');
  const odd = { since: 5, at: {}, baseline: 'yes', events: { new: [null, 'x', 7, { id: ID(1) }, { id: 'bad', title: 'x' }], newTotal: -4, expiredTotal: 'a' }, sources: [null, 3, { source: 'USGS', from: 'ok', to: 'weird' }, { source: 9 }], signals: 'nope', domains: [1, 2] };
  assert.doesNotThrow(() => api.panelHtml(odd));
  assert.doesNotThrow(() => api.panelHtml({ events: null, sources: null, signals: null, domains: null }));
  assert.doesNotThrow(() => api.chipHtml(odd, 'all'));
  const weird = api.panelHtml(odd);
  assert.ok(!weird.includes('data-changes-event="bad"'), 'a record id that is not an event id opens nothing');
});

test('panelHtml: escapes every dynamic string (titles, sources, keys, labels, ids, domains, state words)', () => {
  const evil = '<img src=x onerror=alert(1)>', quote = '"><script>alert(2)</script>';
  const hostile = {
    since: '2026-10-03T09:45:00.000Z', at: quote, baseline: false,
    events: { new: [{ id: ID(1), title: evil, kind: quote, source: quote, domain: evil, severity: evil, observedAt: quote }, { id: quote, title: 'x', source: 'USGS', severity: 'high' }, { id: ID(3), title: evil, source: 'GDELT', severity: 'high', observedAt: '2026-10-03T09:57:00.000Z' }], newTotal: 3, expiredTotal: 0 },
    sources: [{ source: evil, domain: quote, from: 'ok', to: quote }, { source: quote, domain: 'hazards', from: evil, to: 'error' }],
    signals: [{ key: quote, label: evil, direction: quote, severity: evil, type: 'new' }, { key: 'k', label: evil, direction: null, severity: 'high', type: quote }],
    domains: { [evil]: 5, hazards: evil, security: 2 },
  };
  const { api } = mounted({ changes: hostile, openEvent() {}, openMatrix() {}, t: (key, fallback) => (key.startsWith('changes.') || key.startsWith('lenses.') || key.startsWith('inspector.') || key.startsWith('matrix.')) ? '<b>' + fallback + '</b>' : fallback });
  for (const lens of ['all', 'security']) {
    const out = api.panelHtml(hostile, { lens });
    assert.ok(!/<img|<script|<b>/.test(out), `${lens}: no raw tag from any dynamic string or locale string`);
    assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'), `${lens}: shown as text`);
  }
  const out = api.panelHtml(hostile);
  assert.ok(!out.includes('data-changes-event="&quot;'), 'a hostile record id is not a hook');
  assert.equal(count(out, /data-changes-event="event-[0-9a-f]{32}"/g), 2, 'only the two real event ids are hooks');
  assert.ok(!/data-domain="[^"]*(?:&lt;|<)/.test(out) && !out.includes('data-domain="__proto__"'), 'a hostile domain is not echoed');
  assert.ok(!HANDLER.test(out), 'no tag carries an event-handler attribute');
  const chip = api.chipHtml(hostile, 'all');
  assert.ok(!/<img|<script|<b>/.test(chip), 'the chip too');
  assert.ok(api.chipHtml(hostile, 'security').includes('&lt;b&gt;Domain lens: &lt;b&gt;security&lt;/b&gt;&lt;/b&gt;'), 'the lens phrase in the label is escaped too');
});

// ===== lens =====

test('lens: records, transitions and signals narrow to the domain; items without a domain appear only under "all"', () => {
  const { api } = mounted({ changes: FULL, openEvent() {}, openMatrix() {} });
  const events = out => [...out.matchAll(/data-changes-event="([^"]+)"/g)].map(match => match[1]);
  const sources = out => [...out.matchAll(/data-changes-source="([^"]+)"/g)].map(match => match[1]);
  const signals = out => [...out.matchAll(/data-signal="([^"]+)"/g)].map(match => match[1]);
  const names = out => [...out.matchAll(/data-domain="(\w+)"/g)].map(match => match[1]);
  const all = api.panelHtml(FULL, { lens: 'all' });
  assert.deepEqual([events(all), sources(all), signals(all)], [[ID(1), ID(2), ID(3)], ['GDELT', 'NOAA-SWPC'], ['vix', 'tg_urgent:1']]);
  const hazards = api.panelHtml(FULL, { lens: 'hazards' });
  assert.deepEqual([events(hazards), sources(hazards), signals(hazards)], [[ID(1)], [], []]);
  assert.deepEqual(names(hazards), ['hazards'], 'only the active domain has a chip');
  assert.ok(!hazards.includes('data-changes-section="signals"') && !hazards.includes('data-changes-section="sources"'));
  const space = api.panelHtml(FULL, { lens: 'space' });
  assert.deepEqual([events(space), sources(space), signals(space)], [[], ['NOAA-SWPC'], []]);
  assert.ok(!events(api.panelHtml(FULL, { lens: 'security' })).includes(ID(3)), 'a headline without a domain never shows under a domain lens');
  const none = api.panelHtml(FULL, { lens: 'cyber' });
  assert.match(none, /data-changes-state="nothingLens">Nothing changed in this domain\./);
  assert.ok(!none.includes('ch-sec') && !none.includes('ch-domains'));
  assert.equal(api.panelHtml(FULL, { lens: 'nonsense' }), api.panelHtml(FULL, { lens: 'all' }), 'an unknown lens is "all"');
});

test('lens: the lens of the page (CrucixLens) is used when no option names one, and it follows a change', () => {
  const r = mounted({ changes: FULL, lens: 'hazards' });
  assert.deepEqual([...r.api.panelHtml(FULL).matchAll(/data-domain="(\w+)"/g)].map(match => match[1]), ['hazards']);
  r.state.lens = 'all';
  assert.equal(count(r.api.panelHtml(FULL), /class="ch-dom"/g), 4);
});

// ===== the header chip =====

test('chip: "Δ N" counts new records, transitions and signals; the aria-label is the full phrase', () => {
  const { api } = mounted({ changes: FULL });
  const out = api.chipHtml(FULL, 'all');
  assert.match(out, /^<button type="button" class="guide-btn ch-chip" id="changesChip" data-changes-chip aria-label="7 changes since the previous sweep" title="7 changes since the previous sweep"><span class="ch-delta" aria-hidden="true">Δ<\/span> <span class="ch-n">7<\/span><\/button>$/);
  const one = api.chipHtml({ ...EMPTY, events: { new: [FULL.events.new[0]], newTotal: 1, expiredTotal: 0 } }, 'all');
  assert.ok(one.includes('aria-label="1 change since the previous sweep"') && one.includes('<span class="ch-n">1</span>'));
});

test('chip: it counts the real total of new records (newTotal), not just the capped list', () => {
  const { api } = mounted({ changes: FULL });
  const big = { ...FULL, events: { ...FULL.events, newTotal: 123 } };
  assert.ok(api.chipHtml(big, 'all').includes('<span class="ch-n">127</span>'), '123 + 2 transitions + 2 signals');
});

test('chip: a capped transition or signal list says "at least"', () => {
  const { api } = mounted({ changes: FULL });
  const sources = Array.from({ length: CHANGE_CAPS.sources }, (_, index) => ({ source: 'S' + index, domain: null, from: 'ok', to: 'error' }));
  const out = api.chipHtml({ ...EMPTY, sources }, 'all');
  assert.ok(out.includes(`aria-label="At least ${CHANGE_CAPS.sources} changes since the previous sweep"`) && out.includes(`<span class="ch-n">${CHANGE_CAPS.sources}+</span>`));
  const signals = Array.from({ length: CHANGE_CAPS.signals }, (_, index) => ({ key: 'k' + index, label: 'L', direction: null, severity: null, type: 'new' }));
  assert.ok(api.chipHtml({ ...EMPTY, signals }, 'all').includes(`${CHANGE_CAPS.signals}+`));
  assert.ok(!api.chipHtml({ ...EMPTY, sources: sources.slice(1) }, 'all').includes('+</span>'), 'just below the cap is exact');
});

test('chip: under a lens it counts the domain (new records and transitions, signals have no domain); the phrase names the lens', () => {
  const { api } = mounted({ changes: FULL });
  const out = api.chipHtml(FULL, 'hazards');
  assert.ok(out.includes('<span class="ch-n">1</span>') && out.includes('aria-label="1 change since the previous sweep (Domain lens: Natural hazards and weather)"'), out);
  const many = { ...FULL, domains: { ...FULL.domains, hazards: 17 } };
  assert.ok(api.chipHtml(many, 'hazards').includes('<span class="ch-n">17</span>'), 'domains counts records beyond the capped list');
  assert.ok(api.chipHtml(FULL, 'space').includes('<span class="ch-n">1</span>'), 'a transition in the domain');
  assert.equal(api.chipHtml(FULL, 'cyber'), '', 'nothing in this domain: hidden');
  assert.equal(api.chipHtml(FULL, 'bogus'), api.chipHtml(FULL, 'all'), 'an unknown lens is "all"');
});

test('chip: hidden at zero, on a baseline, without a changes object, without the panel, before mount', () => {
  const r = mounted({ changes: FULL });
  for (const value of [EMPTY, BASELINE, undefined, null, 'x', {}]) assert.equal(r.api.chipHtml(value, 'all'), '', JSON.stringify(value));
  assert.notEqual(r.api.chipHtml(FULL, 'all'), '');
  r.state.shown = false;
  assert.equal(r.api.chipHtml(FULL, 'all'), '', 'the user removed the panel from the layout: nothing to scroll to');
  assert.equal(realm({ changes: FULL }).api.chipHtml(FULL, 'all'), '', 'not mounted');
  const throwing = mounted({ changes: FULL }, { panelShown: () => { throw new Error('layout not ready'); } });
  assert.equal(throwing.api.chipHtml(FULL, 'all'), '');
});

test('chip: the aria-label and the visible text come from the page language (hu, fr)', () => {
  for (const [lang, phrase] of [['hu', '7 változás az előző lekérdezés óta'], ['fr', '7 changements depuis le scan précédent']]) {
    const { api } = mounted({ changes: FULL, t: localT(lang) });
    assert.ok(api.chipHtml(FULL, 'all').includes(`aria-label="${phrase}"`), lang);
  }
});

// ===== the chip click =====

test('chip click: scrolls to the panel and focuses its heading; no panel, no error', () => {
  const r = mounted({ changes: FULL });
  r.draw(); r.strip();
  const chip = r.bar.querySelector('[data-changes-chip]');
  click(r, chip);
  const heading = r.rail.querySelector('#changesTitle');
  assert.equal(r.panel().scrolled.length, 1, 'the panel is scrolled into view');
  assert.ok(r.doc.activeElement === heading, 'the heading takes the focus');
  assert.deepEqual(JSON.parse(JSON.stringify(r.panel().scrolled[0])), { block: 'start', behavior: 'smooth' });
  assert.deepEqual(JSON.parse(JSON.stringify(heading.focusOptions[0])), { preventScroll: true });
  const reduced = mounted({ changes: FULL }); reduced.window.matchMedia = () => ({ matches: true }); reduced.draw(); reduced.strip();
  click(reduced, reduced.bar.querySelector('[data-changes-chip]'));
  assert.equal(reduced.panel().scrolled[0].behavior, 'auto', 'prefers-reduced-motion: no smooth scrolling');
  const bare = mounted({ changes: FULL }); bare.strip();
  assert.doesNotThrow(() => click(bare, bare.bar.querySelector('[data-changes-chip]')));
  assert.equal(bare.errors.length, 0);
});

test('focus(): the command palette goes to the panel the way the chip does; false while the panel is not on the page', () => {
  const r = mounted({ changes: FULL });
  assert.equal(r.api.focus(), false, 'not drawn (not in the layout)');
  r.draw();
  assert.equal(r.api.focus(), true);
  assert.ok(r.doc.activeElement === r.rail.querySelector('#changesTitle'), 'the heading takes the focus');
  assert.equal(r.panel().scrolled.length, 1, 'scrolled into view');
  assert.deepEqual(r.errors, []);
});

// ===== clicks on rows =====

test('a record row calls the open-record hook with the event id; a source row opens the matrix', async () => {
  const opened = [], matrix = [];
  const r = mounted({ changes: FULL, openEvent: id => { opened.push(id); }, openMatrix: () => { matrix.push(1); } });
  r.draw();
  click(r, r.rail.querySelector(`[data-changes-event="${ID(2)}"]`));
  click(r, r.rail.querySelectorAll('.ch-title')[2]);
  assert.deepEqual(opened, [ID(2), ID(3)], 'the row button is found from a click on its title too');
  assert.equal(matrix.length, 0);
  click(r, r.rail.querySelector('[data-changes-source="GDELT"]'));
  assert.equal(matrix.length, 1);
  click(r, r.rail.querySelector('.ch-name'));
  assert.equal(matrix.length, 2);
  click(r, r.rail.querySelector('.ch-since'));
  click(r, { tag: 'x' });
  click(r, null);
  r.doc.fire('click', {});
  assert.equal(opened.length, 2, 'only the two row clicks opened a record');
  assert.equal(matrix.length, 2);
  assert.equal(r.errors.length, 0);
});

test('a hook that throws or rejects is logged, never thrown into the page', async () => {
  const r = mounted({ changes: FULL, openEvent: () => { throw new Error('sync'); }, openMatrix: () => Promise.reject(new Error('async')) });
  r.draw();
  assert.doesNotThrow(() => click(r, r.rail.querySelector('[data-changes-event]')));
  assert.doesNotThrow(() => click(r, r.rail.querySelector('[data-changes-source]')));
  await tick();
  assert.equal(r.errors.length, 2);
});

test('a tampered record id (not an event id) in the markup opens nothing', () => {
  const opened = [];
  const r = mounted({ changes: FULL, openEvent: id => opened.push(id) });
  r.draw();
  const button = r.rail.querySelector('[data-changes-event]');
  button.setAttribute('data-changes-event', '../../etc/passwd');
  click(r, button);
  assert.deepEqual(opened, []);
});

// ===== the windows =====

test('windows: "last" uses the snapshot\'s own changes and makes no request', () => {
  const calls = [];
  const r = mounted({ changes: FULL, fetchJson: url => { calls.push(url); return Promise.resolve(MERGED); } });
  r.draw();
  assert.deepEqual(pressed(r), ['last']);
  click(r, win(r, 'last'));
  assert.deepEqual(calls, [], 'the pressed window and the snapshot need no request');
  assert.deepEqual(titles(r), ['Strong earthquake near Kobe', 'Port congestion rising', 'Headline without a source or a level', 'VIX', 'Urgent post']);
});

test('windows: a non-"last" window asks GET /api/changes?window= (relative URL), shows a loading line, then the answer', async () => {
  const calls = [], later = defer();
  const r = mounted({ changes: FULL, fetchJson: url => { calls.push(url); return later.promise; } });
  r.draw();
  click(r, win(r, '6h'));
  assert.deepEqual(calls, ['/api/changes?window=6h']);
  assert.deepEqual(pressed(r), ['6h'], 'the pressed button follows the choice at once');
  assert.match(r.panel().attrs.get('aria-busy'), /true/);
  assert.ok(r.rail.querySelector('.ch-status[role="status"]').text().includes('Loading changes…'), 'a loading line');
  assert.equal(r.rail.querySelectorAll('.ch-error').length, 0);
  later.resolve(MERGED);
  await tick();
  assert.equal(r.panel().attrs.has('aria-busy'), false);
  assert.ok(r.rail.querySelector('.ch-status') === null, 'the loading line is gone');
  assert.deepEqual(titles(r), ['Older flood warning']);
  assert.deepEqual(pressed(r), ['6h']);
  assert.equal(r.panel().attrs.get('data-window'), '6h');
  assert.ok(r.rail.querySelector('time').attrs.get('datetime') === '2026-10-03T03:45:00.000Z', 'the window\'s own since time');
  click(r, win(r, 'last'));
  assert.deepEqual(calls, ['/api/changes?window=6h'], 'back to "last": no new request');
  assert.deepEqual(pressed(r), ['last']);
  assert.ok(titles(r).includes('Strong earthquake near Kobe'), 'the snapshot\'s own list again');
  click(r, win(r, '6h'));
  assert.deepEqual(calls, ['/api/changes?window=6h', '/api/changes?window=6h'], 'each choice of a merged window reads the archive again');
});

test('windows: merged totals are never an exact claim ("up to"), and the exact "last" totals are', async () => {
  const r = mounted({ changes: { ...FULL, events: { ...FULL.events, newTotal: 123 } }, fetchJson: () => Promise.resolve(MERGED) });
  r.draw();
  const last = r.rail.innerHTML;
  assert.match(last, /<h4 id="changesRecords">New records <span class="ch-n">123<\/span><\/h4>/, 'exact for the last sweep');
  assert.ok(last.includes('Showing 3 of 123 new records, most severe first.'), 'a capped list says how many of the real total');
  assert.ok(!last.includes('up to') && !last.includes('≤'));
  click(r, win(r, '24h'));
  await tick();
  const merged = r.rail.innerHTML;
  assert.match(merged, /<h4 id="changesRecords">New records <span class="ch-n"><span aria-hidden="true">≤57<\/span><span class="ch-sr">up to 57<\/span><\/span><\/h4>/, 'an upper bound, spoken as "up to"');
  assert.ok(merged.includes('Showing 1 of up to 57 new records, most severe first.'));
  assert.deepEqual([...merged.matchAll(/class="ch-dom-n">(.*?)<\/span><\/li>/g)].map(match => match[1]),
    ['<span aria-hidden="true">≤3</span><span class="ch-sr">up to 3</span>', '<span aria-hidden="true">≤20</span><span class="ch-sr">up to 20</span>'], 'the domain counts of a merged window are bounds too');
  assert.ok(!merged.includes('class="badge"'), 'no badge for a merged window: it would mix an upper bound with capped lists');
  assert.ok(last.includes('<span class="badge">127</span>'), 'the snapshot\'s own object has one: 123 + 2 transitions + 2 signals');
});

test('windows: a merged list that is complete (newTotal equals what is listed) is exact', async () => {
  const complete = { ...MERGED, events: { ...MERGED.events, newTotal: 1 } };
  const r = mounted({ changes: FULL, fetchJson: () => Promise.resolve(complete) });
  r.draw(); click(r, win(r, '1h')); await tick();
  assert.match(r.rail.innerHTML, /<h4 id="changesRecords">New records <span class="ch-n">1<\/span><\/h4>/);
  assert.ok(!r.rail.innerHTML.includes('ch-cap'));
});

test('windows: a failing request keeps the last good content, shows one error line and moves the pressed button back', async () => {
  const calls = [];
  let fail = true;
  const r = mounted({ changes: FULL, fetchJson: url => { calls.push(url); return fail ? Promise.reject(new Error('HTTP 503')) : Promise.resolve(MERGED); } });
  r.draw();
  click(r, win(r, '1h'));
  await tick();
  assert.deepEqual(titles(r), ['Strong earthquake near Kobe', 'Port congestion rising', 'Headline without a source or a level', 'VIX', 'Urgent post'], 'the last good content (the snapshot\'s own) stays');
  const lines = r.rail.querySelectorAll('.ch-status');
  assert.equal(lines.length, 1, 'one error line, not a pile');
  assert.equal(lines[0].text(), 'Could not load the 1 h changes. Showing Last sweep instead.');
  assert.deepEqual(pressed(r), ['last'], 'the pressed button matches what is shown');
  assert.equal(r.panel().attrs.has('aria-busy'), false);
  assert.equal(r.errors.length, 0, 'a failed request is expected, not a console error');
  // A second failure does not stack lines.
  click(r, win(r, '6h')); await tick();
  assert.equal(r.rail.querySelectorAll('.ch-status').length, 1);
  assert.ok(r.rail.querySelector('.ch-status').text().includes('6 h'));
  // Retry works, and the error goes away.
  fail = false;
  click(r, win(r, '6h')); await tick();
  assert.equal(r.rail.querySelectorAll('.ch-status').length, 0);
  assert.deepEqual(titles(r), ['Older flood warning']);
  // The next failure keeps the earlier window's good content.
  fail = true;
  click(r, win(r, '24h')); await tick();
  assert.deepEqual(titles(r), ['Older flood warning'], 'the 6 h content is the last good one');
  assert.deepEqual(pressed(r), ['6h']);
  assert.equal(r.rail.querySelector('.ch-status').text(), 'Could not load the 24 h changes. Showing 6 h instead.');
  // Garbage answers are failures too.
  fail = false;
  const bad = mounted({ changes: FULL, fetchJson: () => Promise.resolve('<html>') }); bad.draw(); click(bad, win(bad, '1h')); await tick();
  assert.equal(bad.rail.querySelectorAll('.ch-status').length, 1);
  assert.ok(titles(bad).includes('VIX'));
  const nothing = mounted({ changes: FULL, fetchJson: () => { throw new Error('sync'); } }); nothing.draw(); click(nothing, win(nothing, '1h')); await tick();
  assert.equal(nothing.rail.querySelectorAll('.ch-status').length, 1, 'a synchronous throw is a failure too');
});

test('windows: a late answer for an older choice is dropped (sequence guard)', async () => {
  const pending = {};
  const r = mounted({ changes: FULL, fetchJson: url => (pending[url.split('=')[1]] = defer()).promise });
  r.draw();
  click(r, win(r, '6h'));
  click(r, win(r, '24h'));
  pending['24h'].resolve({ ...MERGED, events: { ...MERGED.events, new: [{ ...MERGED.events.new[0], title: 'The 24 h answer' }] } });
  await tick();
  pending['6h'].resolve({ ...MERGED, events: { ...MERGED.events, new: [{ ...MERGED.events.new[0], title: 'The late 6 h answer' }] } });
  await tick();
  assert.ok(titles(r).includes('The 24 h answer') && !titles(r).includes('The late 6 h answer'));
  assert.deepEqual(pressed(r), ['24h']);
  // A late failure of an older choice is dropped as well, and "last" cancels what is in flight.
  const second = {};
  const q = mounted({ changes: FULL, fetchJson: url => (second[url.split('=')[1]] = defer()).promise });
  q.draw(); click(q, win(q, '1h')); click(q, win(q, 'last'));
  second['1h'].resolve(MERGED); await tick();
  assert.deepEqual(pressed(q), ['last']);
  assert.ok(titles(q).includes('VIX') && !titles(q).includes('Older flood warning'), 'an answer after "last" was chosen is not applied');
  assert.equal(q.panel().attrs.has('aria-busy'), false);
});

test('windows: a late failure of an older choice, or of one left for "last", writes no error line', async () => {
  const pending = {};
  const r = mounted({ changes: FULL, fetchJson: url => (pending[url.split('=')[1]] = defer()).promise });
  r.draw();
  click(r, win(r, '6h')); click(r, win(r, '24h'));
  pending['24h'].resolve(MERGED); await tick();
  pending['6h'].reject(new Error('late')); await tick();
  assert.equal(r.rail.querySelectorAll('.ch-status').length, 0, 'the 6 h failure came after the 24 h answer');
  assert.deepEqual(pressed(r), ['24h']);
  const q = mounted({ changes: FULL, fetchJson: url => (pending[url] = defer()).promise });
  q.draw(); click(q, win(q, '1h')); click(q, win(q, 'last'));
  pending['/api/changes?window=1h'].reject(new Error('late')); await tick();
  assert.equal(q.rail.querySelectorAll('.ch-status').length, 0, 'the user had gone back to "last"');
  assert.deepEqual(pressed(q), ['last']);
});

test('windows: clicking the pressed window again does nothing; a window that failed can be asked again', async () => {
  const calls = [];
  const r = mounted({ changes: FULL, fetchJson: url => { calls.push(url); return Promise.resolve(MERGED); } });
  r.draw();
  click(r, win(r, 'last'));
  click(r, win(r, '1h')); await tick();
  click(r, win(r, '1h'));
  assert.deepEqual(calls, ['/api/changes?window=1h'], 'the pressed window needs no second request');
  const failing = mounted({ changes: FULL, fetchJson: () => Promise.reject(new Error('x')) });
  failing.draw(); click(failing, win(failing, '6h')); await tick();
  assert.equal(failing.rail.querySelectorAll('.ch-status').length, 1);
  click(failing, win(failing, 'last'));
  assert.equal(failing.rail.querySelectorAll('.ch-status').length, 0, 'a click on the pressed window dismisses the error line');
  assert.deepEqual(pressed(failing), ['last']);
});

test('windows: without a fetchJson hook (file page, offline shell) there is only the snapshot, and no window buttons', () => {
  const r = mounted({ changes: FULL, fetchJson: null });
  const out = r.api.panelHtml(FULL);
  assert.ok(!out.includes('ch-windows') && !out.includes('data-changes-window'));
  assert.ok(out.includes('Strong earthquake near Kobe'));
});

test('windows: the window buttons keep the focus across the redraw that follows a click', async () => {
  const r = mounted({ changes: FULL, fetchJson: () => Promise.resolve(MERGED) });
  r.draw();
  const button = win(r, '6h');
  button.focus();
  click(r, button);
  assert.ok(win(r, '6h') !== button, 'the panel was swapped in place');
  assert.ok(r.doc.activeElement === win(r, '6h'), 'and the focus is on the new button');
  await tick();
  assert.ok(r.doc.activeElement === win(r, '6h'), 'also after the answer');
  const heading = r.rail.querySelector('#changesTitle'); heading.focus();
  click(r, win(r, '24h'));
  assert.ok(r.doc.activeElement === r.rail.querySelector('#changesTitle'), 'the heading (the chip\'s target) keeps the focus too');
  assert.ok(r.doc.activeElement !== heading, 'the focus left the old heading');
  r.doc.activeElement = r.doc.body;
  click(r, win(r, '1h'));
  assert.ok(r.doc.activeElement === r.doc.body, 'a focus outside the panel is left alone');
});

test('windows: an answer arriving while the panel is not on the page changes nothing and does not throw', async () => {
  const later = defer();
  const r = mounted({ changes: FULL, fetchJson: () => later.promise });
  r.draw();
  click(r, win(r, '1h'));
  r.rail.innerHTML = '';
  later.resolve(MERGED);
  await tick();
  assert.equal(r.errors.length, 0);
  r.draw();
  assert.deepEqual(pressed(r), ['1h'], 'the next render shows the answer');
  assert.ok(titles(r).includes('Older flood warning'));
});

test('windows: a window whose answer is a baseline or empty says so in the window\'s words', async () => {
  for (const [answer, state, text] of [[BASELINE, 'baselineWindow', 'No earlier sweeps to compare in this window yet.'], [EMPTY, 'nothingWindow', 'Nothing changed in this window.']]) {
    const r = mounted({ changes: FULL, fetchJson: () => Promise.resolve(answer) });
    r.draw(); click(r, win(r, '6h')); await tick();
    const note = r.rail.querySelector('.ch-calm');
    assert.equal(note.getAttribute('data-changes-state'), state);
    assert.equal(note.text(), text);
  }
});

test('windows: while the first window loads the snapshot\'s own (exact) figures stay; a window that already answered keeps its bounds while it reloads', async () => {
  const pending = [];
  const r = mounted({ changes: { ...FULL, events: { ...FULL.events, newTotal: 123 } }, fetchJson: () => { const next = defer(); pending.push(next); return next.promise; } });
  r.draw(); click(r, win(r, '6h'));
  assert.match(r.rail.innerHTML, /<h4 id="changesRecords">New records <span class="ch-n">123<\/span>/, 'still the last sweep\'s object: exact');
  assert.equal(r.panel().getAttribute('data-stale'), 'true', 'and marked as not yet the chosen window');
  pending[0].resolve(MERGED); await tick();
  assert.equal(r.panel().getAttribute('data-stale'), null);
  click(r, win(r, '24h'));
  assert.ok(r.rail.innerHTML.includes('≤57') && r.panel().getAttribute('data-stale') === 'true', 'the 6 h answer (a bound) stays while 24 h loads');
  pending[1].resolve(MERGED); await tick();
});

test('windows: a focus outside the panel is not pulled into it by the redraw, even on a lookalike control', () => {
  const r = mounted({ changes: FULL, fetchJson: () => new Promise(() => {}) });
  r.draw();
  const stray = r.doc.createElement('button'); stray.setAttribute('data-changes-window', '24h'); stray.parentNode = r.doc.body; r.doc.body.kids.push(stray);
  stray.focus();
  click(r, win(r, '1h'));
  assert.ok(r.doc.activeElement === stray, 'the focus stays on the stray element');
});

test('mount: a second mount is refused and binds nothing again', () => {
  const r = mounted({ changes: FULL });
  assert.equal(r.mount(), false);
  assert.equal(r.doc.listeners.click.length, 1);
  assert.equal(r.api.mount(null), false);
  assert.equal(realm().api.mount('x'), false);
});

test('lists the server caps are noted: 30 transitions and 20 signals say "capped", one fewer does not', () => {
  const { api } = mounted({ changes: FULL });
  const transitions = length => Array.from({ length }, (_, index) => ({ source: 'S' + index, domain: null, from: 'ok', to: 'error' }));
  const signals = length => Array.from({ length }, (_, index) => ({ key: 'k' + index, label: 'L' + index, direction: null, severity: 'high', type: 'new' }));
  const part = (out, name) => (new RegExp(`<section class="ch-sec" data-changes-section="${name}".*?</section>`).exec(out) || [''])[0];
  const NOTE = 'The list is capped, so more may exist.', open = { expanded: { records: true, sources: true, signals: true } };
  assert.ok(part(api.panelHtml({ ...EMPTY, sources: transitions(CHANGE_CAPS.sources) }, open), 'sources').includes(`Showing ${CHANGE_CAPS.sources}. ${NOTE}`));
  assert.ok(!part(api.panelHtml({ ...EMPTY, sources: transitions(CHANGE_CAPS.sources - 1) }, open), 'sources').includes(NOTE));
  assert.ok(part(api.panelHtml({ ...EMPTY, signals: signals(CHANGE_CAPS.signals) }, open), 'signals').includes(`Showing ${CHANGE_CAPS.signals}. ${NOTE}`));
  assert.ok(!part(api.panelHtml({ ...EMPTY, signals: signals(CHANGE_CAPS.signals - 1) }, open), 'signals').includes(NOTE));
  // Until the section is opened the note counts the rows that are on screen.
  assert.ok(part(api.panelHtml({ ...EMPTY, sources: transitions(CHANGE_CAPS.sources) }), 'sources').includes(`Showing ${SHOW}. ${NOTE}`));
  assert.ok(part(api.panelHtml({ ...EMPTY, signals: signals(CHANGE_CAPS.signals) }), 'signals').includes(`Showing ${SHOW}. ${NOTE}`));
});

test('lens: records of a domain are "of N" while the transition list is complete and just "capped" once it is not', () => {
  const { api } = mounted({ changes: FULL });
  const records = Array.from({ length: CHANGE_CAPS.events }, (_, index) => ({ id: ID(100 + index), title: 'R' + index, kind: 'x', source: 'USGS', domain: 'hazards', severity: 'high', observedAt: null }));
  const quakes = length => Array.from({ length }, () => ({ source: 'USGS', domain: 'hazards', from: 'ok', to: 'stale' }));
  const object = sources => ({ ...EMPTY, events: { new: records, newTotal: 90, expiredTotal: 0 }, sources: quakes(sources), domains: { hazards: 61 + sources } });
  const open = { lens: 'hazards', expanded: { records: true } };
  const known = api.panelHtml(object(CHANGE_CAPS.sources - 1), open);
  assert.ok(known.includes(`Showing ${CHANGE_CAPS.events} of 61 new records, most severe first.`), 'domain total minus the listed transitions');
  assert.ok(api.panelHtml(object(CHANGE_CAPS.sources - 1), { lens: 'hazards' }).includes(`Showing ${SHOW} of 61 new records, most severe first.`), 'collapsed: the rows on screen');
  const capped = api.panelHtml(object(CHANGE_CAPS.sources), open);
  assert.ok(capped.includes(`Showing ${CHANGE_CAPS.events}. The list is capped, so more may exist.`), 'the transitions hide part of the count, so no total is claimed');
  assert.ok(!capped.includes('new records, most severe first'));
  assert.ok(api.panelHtml(object(CHANGE_CAPS.sources), { lens: 'hazards' }).includes(`Showing ${SHOW}. The list is capped, so more may exist.`));
  assert.ok(api.panelHtml(object(0), { lens: 'all', expanded: { records: true } }).includes(`Showing ${CHANGE_CAPS.events} of 90 new records`), 'all: the real total');
});

test('without record-core.js the panel still renders: the words stay, the glyphs and the ages are left out', () => {
  const r = mounted({ changes: FULL, records: false });
  const out = r.api.panelHtml(FULL);
  assert.ok(out.includes('<i aria-hidden="true"></i> Critical') && out.includes('Strong earthquake near Kobe'));
  assert.match(out, /<span class="ch-age" data-changes-time="2026-10-03T09:57:00.000Z"[^>]*>—<\/span>/);
});

// ===== review fixes (round 1) =====

test('attribute context: a quote in a source name or a signal key cannot break out of its attribute', () => {
  const source = 'x" onmouseover="alert(1)', key = "k' onfocus='alert(2)";
  const hostile = { ...FULL, sources: [{ source, domain: null, from: 'ok', to: 'error' }], signals: [{ key, label: 'L', direction: null, severity: 'high', type: 'new' }] };
  const r = mounted({ changes: hostile, openEvent() {}, openMatrix() {} });
  const out = r.api.panelHtml(hostile);
  assert.ok(!HANDLER.test(out), 'no tag carries an event-handler attribute');
  r.rail.innerHTML = out;
  assert.deepEqual(r.rail.querySelectorAll('[data-changes-source]').map(node => node.getAttribute('data-changes-source')), [source], 'the DOM reads the name back whole');
  assert.deepEqual(r.rail.querySelectorAll('[data-signal]').map(node => node.getAttribute('data-signal')), [key]);
  assert.equal(r.rail.querySelectorAll('[onmouseover]').length + r.rail.querySelectorAll('[onfocus]').length, 0, 'no attribute of the hostile text was created');
  assert.ok(out.includes('x&quot; onmouseover=&quot;alert(1)') && out.includes('k&#39; onfocus=&#39;alert(2)'), 'both quote characters are entities in the markup');
});

const BIG = {
  since: '2026-10-03T09:45:00.000Z', at: '2026-10-03T10:00:00.000Z', baseline: false,
  events: { new: Array.from({ length: CHANGE_CAPS.events }, (_, index) => ({ id: ID(200 + index), title: 'Record ' + index, kind: 'news', source: 'USGS', domain: 'hazards', severity: 'high', observedAt: '2026-10-03T09:30:00.000Z' })), newTotal: 63, expiredTotal: 0 },
  sources: Array.from({ length: CHANGE_CAPS.sources }, (_, index) => ({ source: 'Source ' + index, domain: null, from: 'ok', to: 'error' })),
  signals: Array.from({ length: CHANGE_CAPS.signals }, (_, index) => ({ key: 'k' + index, label: 'Signal ' + index, direction: null, severity: 'high', type: 'new' })),
  domains: { hazards: 63 },
};
const rowsOf = r => [r.rail.querySelectorAll('[data-changes-event]').length, r.rail.querySelectorAll('[data-changes-source]').length, r.rail.querySelectorAll('[data-signal]').length];
const more = (r, name) => r.rail.querySelector(`[data-changes-more="${name}"]`);

test('bounded panel: every list shows its first rows until its Show all button is used, with every list at its server cap', () => {
  const r = mounted({ changes: BIG });
  r.draw();
  assert.deepEqual(rowsOf(r), [SHOW, SHOW, SHOW], 'a few records, transitions and signals');
  assert.deepEqual(r.rail.querySelectorAll('[data-changes-event]').map(node => node.getAttribute('data-changes-event')), BIG.events.new.slice(0, SHOW).map(item => item.id), 'the first ones, in the server\'s order');
  assert.deepEqual(['records', 'sources', 'signals'].map(name => more(r, name).text()), ['Show all 40', 'Show all 30', 'Show all 20']);
  for (const name of ['records', 'sources', 'signals']) {
    const button = more(r, name);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(button.tag, 'button');
    assert.equal(button.getAttribute('type'), 'button');
    assert.equal(button.closest('section').querySelector('.ch-list').id, button.getAttribute('aria-controls'), name + ': it controls the list of its own section');
  }
  assert.ok(r.rail.innerHTML.includes(`Showing ${SHOW} of 63 new records, most severe first.`), 'the note counts the rows on screen');
  assert.ok(r.rail.innerHTML.includes(`Showing ${SHOW}. The list is capped, so more may exist.`));
});

test('bounded panel: Show all opens one list, Show fewer closes it, and the choice is kept for the session', async () => {
  const r = mounted({ changes: BIG, fetchJson: () => Promise.resolve(MERGED) });
  r.draw();
  click(r, more(r, 'records'));
  assert.deepEqual(rowsOf(r), [40, SHOW, SHOW], 'only the records opened');
  assert.equal(more(r, 'records').getAttribute('aria-expanded'), 'true');
  assert.equal(more(r, 'records').text(), 'Show fewer');
  assert.ok(r.rail.innerHTML.includes('Showing 40 of 63 new records, most severe first.'));
  click(r, more(r, 'sources'));
  click(r, more(r, 'signals'));
  assert.deepEqual(rowsOf(r), [40, 30, 20]);
  // The choice survives another render, a window change and a lens change.
  r.draw();
  assert.deepEqual(rowsOf(r), [40, 30, 20], 'a render of the rails keeps the lists open');
  click(r, win(r, '6h')); await tick(); click(r, win(r, 'last'));
  assert.deepEqual(rowsOf(r), [40, 30, 20], 'a window change keeps them open');
  // A new sweep (the page calls update() with its changes and then renders the rails again) keeps them open too.
  r.state.changes = { ...BIG, at: '2026-10-03T10:15:00.000Z' };
  r.api.update(r.state.changes);
  r.draw();
  assert.deepEqual(rowsOf(r), [40, 30, 20], 'a new sweep keeps the lists open');
  click(r, more(r, 'records'));
  assert.deepEqual(rowsOf(r), [SHOW, 30, 20], 'Show fewer closes only that list');
  click(r, more(r, 'records'));
  assert.deepEqual(rowsOf(r), [40, 30, 20]);
  assert.equal(r.errors.length, 0);
});

test('bounded panel: the button keeps the keyboard focus across the swap; a list with nothing more to show has no button', () => {
  const r = mounted({ changes: BIG });
  r.draw();
  const button = more(r, 'sources');
  button.focus();
  click(r, button);
  assert.ok(more(r, 'sources') !== button, 'the panel was swapped in place');
  assert.ok(r.doc.activeElement === more(r, 'sources'), 'and the focus is on the new button');
  const small = mounted({ changes: FULL });
  small.draw();
  assert.equal(small.rail.querySelectorAll('[data-changes-more]').length, 0, 'three records, two transitions and two signals are all shown');
  const five = { ...BIG, events: { ...BIG.events, new: BIG.events.new.slice(0, SHOW) }, sources: BIG.sources.slice(0, SHOW), signals: BIG.signals.slice(0, SHOW) };
  small.rail.innerHTML = small.api.panelHtml(five);
  assert.equal(small.rail.querySelectorAll('[data-changes-more]').length, 0, 'exactly as many as the default shows: no button');
  small.rail.innerHTML = small.api.panelHtml({ ...five, events: { ...five.events, new: BIG.events.new.slice(0, SHOW + 1) } });
  assert.deepEqual(small.rail.querySelectorAll('[data-changes-more]').map(node => node.getAttribute('data-changes-more')), ['records'], 'one more than the default: a button');
});

test('bounded panel: a lens counts its own rows, a merged window keeps "up to", an exact merged list says "of N"', async () => {
  const r = mounted({ changes: BIG, lens: 'hazards' });
  r.draw();
  assert.equal(more(r, 'records').text(), 'Show all 40');
  const merged = (newTotal, length) => ({ ...MERGED, events: { new: BIG.events.new.slice(0, length), newTotal, expiredTotal: 0 }, sources: [], domains: { hazards: newTotal } });
  assert.ok(r.api.panelHtml(merged(57, 12), { window: '6h', windowChanges: merged(57, 12) }).includes(`Showing ${SHOW} of up to 57 new records, most severe first.`));
  assert.ok(r.api.panelHtml(merged(12, 12), { window: '6h', windowChanges: merged(12, 12) }).includes(`Showing ${SHOW} of 12 new records, most severe first.`), 'complete: exact');
  const other = mounted({ changes: BIG, lens: 'cyber' });
  other.draw();
  assert.equal(other.rail.querySelectorAll('[data-changes-more]').length, 0, 'nothing in the lens, nothing to open');
});

test('record rows have a stable id so the focus can be found again after the rails are rebuilt; invalid ids and plain rows get none', () => {
  const r = mounted({ changes: FULL });
  r.draw();
  const node = r.doc.getElementById('changes-ev-' + ID(2));
  assert.ok(node && node.getAttribute('data-changes-event') === ID(2));
  node.focus();
  r.draw();
  const again = r.doc.getElementById('changes-ev-' + ID(2));
  assert.ok(again && again !== node, 'the rebuilt row answers to the same id (what the event dialog\'s focus restore looks for)');
  const ids = all(r.doc.body).map(item => item.id).filter(value => value.startsWith('changes-ev-'));
  assert.deepEqual(ids, [ID(1), ID(2), ID(3)].map(id => 'changes-ev-' + id), 'one per row, unique');
  const hostile = { ...FULL, events: { ...FULL.events, new: [{ ...FULL.events.new[0], id: 'event-1" onclick="x' }, FULL.events.new[1]] } };
  assert.equal(count(r.api.panelHtml(hostile), /id="changes-ev-/g), 1, 'an id that is not an event id gets none');
  const plain = mounted({ changes: FULL, openEvent: null });
  assert.ok(!plain.api.panelHtml(FULL).includes('changes-ev-'), 'a plain row is not a control and has no id');
});

test('a failed refresh of the window on screen says the earlier data is shown', async () => {
  let fail = false;
  const r = mounted({ changes: FULL, fetchJson: () => fail ? Promise.reject(new Error('x')) : Promise.resolve(MERGED) });
  r.draw(); click(r, win(r, '6h')); await tick();
  assert.deepEqual(titles(r), ['Older flood warning']);
  fail = true;
  r.api.update({ ...FULL, at: '2026-10-03T10:15:00.000Z' });
  await tick();
  assert.equal(r.rail.querySelector('.ch-status').text(), 'Could not refresh the 6 h changes. The earlier data is shown.');
  assert.deepEqual(titles(r), ['Older flood warning'], 'the earlier answer is what is on screen');
  assert.deepEqual(pressed(r), ['6h']);
  assert.equal(r.errors.length, 0);
});

test('"Last sweep" forgets the window answer, so a later failing window falls back to the last sweep and says so', async () => {
  let fail = false;
  const r = mounted({ changes: FULL, fetchJson: () => fail ? Promise.reject(new Error('x')) : Promise.resolve(MERGED) });
  r.draw(); click(r, win(r, '6h')); await tick();
  click(r, win(r, 'last'));
  fail = true;
  click(r, win(r, '24h')); await tick();
  assert.deepEqual(pressed(r), ['last'], 'not the old 6 h answer');
  assert.ok(!titles(r).includes('Older flood warning') && titles(r).includes('VIX'), 'the snapshot\'s own list');
  assert.equal(r.rail.querySelector('.ch-status').text(), 'Could not load the 24 h changes. Showing Last sweep instead.');
  // A different window that answered stays the fallback.
  fail = false;
  click(r, win(r, '1h')); await tick();
  fail = true;
  click(r, win(r, '24h')); await tick();
  assert.deepEqual(pressed(r), ['1h']);
  assert.equal(r.rail.querySelector('.ch-status').text(), 'Could not load the 24 h changes. Showing 1 h instead.');
});

test('a window button that is disabled does not react to hover', () => {
  const css = read('dashboard/public/changes.css');
  assert.ok(css.includes('.ch-win:hover:not([aria-disabled="true"]){'));
  assert.ok(!/\.ch-win:hover\{/.test(css), 'no bare hover rule');
  assert.ok(css.includes('.ch-win[aria-disabled="true"]{opacity:.5;cursor:not-allowed}'));
});

test('the Show all button has a focus ring and, on a narrow screen, the same 44 px touch target as the other controls', () => {
  const css = read('dashboard/public/changes.css');
  assert.match(css, /\.ch-win:focus-visible,\.ch-more:focus-visible,button\.ch-row:focus-visible[^{]*\{outline:2px solid/);
  assert.ok(css.includes('@media(max-width:700px){.ch-win,.ch-more,button.ch-row{min-height:44px}'));
});

test('a time that is not ISO-8601 is unknown, however Date.parse reads it', () => {
  const { api } = mounted({ changes: FULL });
  const odd = { ...FULL, since: 'Oct 3 2026', events: { ...FULL.events, new: ['Oct 3 2026', '<img src=x onerror=2>', '2026-10-03 09:57'].map((observedAt, index) => ({ ...FULL.events.new[index], observedAt })) } };
  const out = api.panelHtml(odd);
  assert.ok(!out.includes('data-changes-time'), 'no time attribute');
  assert.equal(count(out, /<span class="ch-age">—<\/span>/g), 3, 'three dashes');
  assert.ok(!out.includes('<time'), 'a since time that is not ISO is not shown');
  assert.ok(api.panelHtml({ ...odd, since: '2026-10-03T09:45:00Z' }).includes('<time datetime="2026-10-03T09:45:00.000Z">'), 'a real one is');
});

test('an openEvent hook that rejects later is logged, never thrown into the page', async () => {
  const r = mounted({ changes: FULL, openEvent: () => Promise.reject(new Error('async')) });
  r.draw();
  click(r, r.rail.querySelector('[data-changes-event]'));
  await tick();
  assert.equal(r.errors.length, 1);
});

test('the since time follows the page locale, and an unusable locale tag falls back to the UTC stamp', () => {
  const shownTime = locale => />([^<]*)<\/time>/.exec(mounted({ changes: FULL, locale }).api.panelHtml(FULL))[1];
  const expected = locale => new Date('2026-10-03T09:45:00.000Z').toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  for (const locale of ['en-US', 'hu-HU', 'fr-FR']) assert.equal(shownTime(locale), expected(locale), locale);
  assert.notEqual(shownTime('hu-HU'), shownTime('en-US'));
  assert.equal(shownTime('not a locale tag!'), '2026-10-03 09:45:00 UTC');
});

// ===== a replay =====

test('replay: the replayed snapshot\'s own changes are shown, the longer windows are disabled with the replay note, nothing is fetched', () => {
  const calls = [];
  const r = mounted({ changes: FULL, replay: true, fetchJson: url => { calls.push(url); return Promise.resolve(MERGED); } });
  r.draw();
  assert.deepEqual(pressed(r), ['last']);
  for (const id of ['1h', '6h', '24h']) {
    const button = win(r, id);
    assert.equal(button.getAttribute('aria-disabled'), 'true', id);
    assert.equal(button.getAttribute('aria-describedby'), 'changesNote', id);
  }
  assert.equal(win(r, 'last').getAttribute('aria-disabled'), null);
  const note = r.rail.querySelector('#changesNote');
  assert.ok(note && note.text().startsWith('Longer windows read the live archive'));
  for (const id of ['1h', '6h', '24h']) click(r, win(r, id));
  assert.deepEqual(calls, [], 'no live request during a replay');
  assert.deepEqual(pressed(r), ['last']);
  assert.ok(titles(r).includes('Strong earthquake near Kobe'));
});

test('replay: a window button of a panel drawn before the replay started still asks for nothing', () => {
  const calls = [];
  const r = mounted({ changes: FULL, fetchJson: url => { calls.push(url); return Promise.resolve(MERGED); } });
  r.draw();
  r.state.replay = true;
  click(r, win(r, '1h'));
  assert.deepEqual(calls, []);
  assert.deepEqual(pressed(r), ['last']);
});

test('replay: a window chosen before the replay is not shown during it and not forgotten after it', async () => {
  const calls = [];
  const r = mounted({ changes: FULL, fetchJson: url => { calls.push(url); return Promise.resolve(MERGED); } });
  r.draw(); click(r, win(r, '1h')); await tick();
  assert.ok(titles(r).includes('Older flood warning'));
  r.state.replay = true;
  r.state.changes = { ...FULL, events: { ...FULL.events, new: [{ ...FULL.events.new[0], title: 'Replayed record' }] } };
  r.draw();
  assert.deepEqual(pressed(r), ['last']);
  assert.ok(titles(r).includes('Replayed record') && !titles(r).includes('Older flood warning'));
  r.state.replay = false; r.state.changes = FULL;
  r.draw();
  assert.deepEqual(pressed(r), ['1h'], 'back to live: the chosen window again');
  assert.ok(titles(r).includes('Older flood warning'));
  assert.equal(calls.length, 1, 'the earlier answer is still good');
});

test('replay: the loading and error lines stay out of a replayed panel', async () => {
  const later = defer();
  const r = mounted({ changes: FULL, fetchJson: () => later.promise });
  r.draw(); click(r, win(r, '1h'));
  r.state.replay = true; r.draw();
  assert.equal(r.rail.querySelectorAll('.ch-status').length, 0);
  assert.equal(r.panel().attrs.has('aria-busy'), false);
  const swaps = r.rail.swaps;
  later.reject(new Error('x')); await tick();
  assert.equal(r.errors.length, 0);
  assert.equal(r.rail.querySelectorAll('.ch-status').length, 0, 'the failure of a request made before the replay does not write into the replay');
  assert.equal(r.rail.swaps, swaps, 'the replayed markup did not change, so the panel is not swapped');
});

// ===== update =====

test('update: a new sweep refreshes a chosen merged window; the same sweep, "last" and a replay do not', async () => {
  const calls = [];
  const r = mounted({ changes: FULL, fetchJson: url => { calls.push(url); return Promise.resolve(MERGED); } });
  r.api.update(FULL);
  r.api.update({ ...FULL, at: '2026-10-03T10:15:00.000Z' });
  assert.deepEqual(calls, [], 'with "last" chosen nothing is requested');
  r.draw(); click(r, win(r, '1h')); await tick();
  assert.equal(calls.length, 1);
  r.api.update({ ...FULL, at: '2026-10-03T10:15:00.000Z' });
  assert.equal(calls.length, 1, 'the same sweep again: no request');
  r.api.update({ ...FULL, at: '2026-10-03T10:30:00.000Z' });
  assert.deepEqual(calls, ['/api/changes?window=1h', '/api/changes?window=1h'], 'a new sweep: the window is read again');
  r.state.replay = true;
  r.api.update({ ...FULL, at: '2026-10-03T10:45:00.000Z' });
  assert.equal(calls.length, 2, 'during a replay nothing is requested');
  r.state.replay = false;
  r.api.update({ ...FULL, at: '2026-10-03T11:00:00.000Z' });
  assert.equal(calls.length, 3);
  assert.doesNotThrow(() => { r.api.update(undefined); r.api.update('x'); r.api.update(null); });
  await tick();
});

test('update: while the refresh runs the next render shows the loading line over the content it already has', async () => {
  const later = defer();
  let answer = Promise.resolve(MERGED);
  const r = mounted({ changes: FULL, fetchJson: () => answer });
  r.draw(); click(r, win(r, '6h')); await tick();
  answer = later.promise;
  r.state.changes = { ...FULL, at: '2026-10-03T10:15:00.000Z' };
  r.api.update(r.state.changes);
  r.draw();
  assert.ok(titles(r).includes('Older flood warning'), 'the previous 6 h answer stays while the new one loads');
  assert.ok(r.rail.querySelector('.ch-status').text().includes('Loading'));
  assert.match(r.panel().attrs.get('aria-busy'), /true/);
  later.resolve({ ...MERGED, events: { ...MERGED.events, new: [{ ...MERGED.events.new[0], title: 'Fresh answer' }] } });
  await tick();
  assert.ok(titles(r).includes('Fresh answer'));
});

test('refresh: ages are rewritten in place from the page clock, without replacing a node', () => {
  const r = mounted({ changes: FULL, openEvent() {} });
  r.draw();
  const row = r.rail.querySelector('[data-changes-event]'), age = r.rail.querySelector('.ch-age');
  assert.equal(age.text(), '3m');
  r.state.now = NOW + 62 * 60000;
  r.api.refresh();
  assert.equal(age.text(), '1h', 'the same node, a newer label');
  assert.ok(r.rail.querySelector('[data-changes-event]') === row, 'the first record row is the same node');
  assert.equal(r.rail.querySelectorAll('.ch-age').filter(node => node.text() === '—').length, 1, 'an unknown time stays a dash');
  const bare = realm({ changes: FULL });
  assert.doesNotThrow(() => bare.api.refresh());
  assert.doesNotThrow(() => r.api.refresh.call(null));
});

// ===== the page: registration and wiring =====

const sliceBetween = (text, from, to) => { const start = text.indexOf(from), end = text.indexOf(to, start); assert.ok(start > 0 && end > start, from); return text.slice(start, end); };

test('jarvis.html loads changes.js and changes.css after the matrix and mounts the module once, with the page hooks', () => {
  const at = needle => { const i = html.indexOf(needle); assert.ok(i > 0, needle); return i; };
  assert.ok(at('<script src="health-matrix.js">') < at('<script src="changes.js">'), 'after the matrix');
  assert.ok(at('<script src="domains.js">') < at('<script src="changes.js">') && at('<script src="lens-core.js">') < at('<script src="changes.js">'));
  assert.ok(at('href="health-matrix.css"') < at('href="changes.css"'), 'changes.css after the matrix styles');
  assert.ok(at('href="record-inspector.css"') < at('href="changes.css"'), 'after the severity tokens it reuses');
  assert.equal(count(html, /CrucixChanges\?\.mount\(/g), 1);
  const mount = html.slice(html.indexOf('CrucixChanges?.mount('), html.indexOf('CrucixChanges?.mount(') + 900);
  for (const hook of ['t,', 'locale:uiLocale()', 'now:clockNow', 'getChanges:()=>D.changes', "panelShown:()=>isPanelVisible('changes')", 'isReplay:()=>!!window.CrucixReplay?.active()', 'openEvent:id=>window.CrucixIntelligence?.openEvent(id)']) assert.ok(mount.includes(hook), hook);
  // The archive hooks (the longer windows, the matrix rows) are left out on file pages and in the offline shell, like the replay and the matrix.
  assert.ok(html.includes("const archiveApi=location.protocol!=='file:'&&!window.__CRUCIX_OFFLINE_SHELL__;"));
  assert.ok(mount.includes('openMatrix:archiveApi?()=>window.CrucixHealthMatrix?.open():undefined') && mount.includes('fetchJson:archiveApi?fetchJsonNoStore:undefined'));
  assert.equal(html.match(/^(let|const) D = .*;\s*$/gm).length, 1, 'the injected D line stays one line');
  const source = read('dashboard/public/changes.js');
  assert.ok(/^\(function\(window,document\)\{/.test(source) && !/\son[a-z]+\s*=\s*["']/i.test(source), 'an IIFE with no inline handlers');
});

test('jarvis.html: the panel is registered in the zones, the label, the builder and the top bar, and update/refresh are wired', () => {
  const zones = sliceBetween(html, 'const dashboardDefaultZones = {', '};');
  assert.match(zones, /right:\['changes','countryRisk','liveSources',/, 'first in the right rail by default, Country risk after it');
  assert.equal(count(zones, /'changes'/g), 1);
  assert.match(html, /case 'changes': return t\('panels\.changes','What changed'\);/);
  assert.match(html, /case 'changes': return window\.CrucixChanges\?\.panelHtml\(D\.changes\)\|\|'';/);
  const topbar = sliceBetween(html, 'function renderTopbar(){', '\nfunction ');
  assert.match(topbar, /\$\{window\.CrucixChanges\?\.chipHtml\?\.\(D\.changes,window\.CrucixLens\?\.get\?\.\(\)\)\|\|''\}/, 'the chip is part of the rebuilt top bar');
  assert.ok(topbar.indexOf('CrucixChanges') < topbar.indexOf('CrucixAlerts'), 'before the alert bell');
  const reinit = sliceBetween(html, 'function reinit(){', '\nfunction ');
  assert.ok(reinit.indexOf('CrucixChanges?.update(D.changes)') > 0 && reinit.indexOf('CrucixChanges?.update(D.changes)') < reinit.indexOf('rerenderDashboard('), 'update runs before the panel is rendered');
  assert.match(sliceBetween(html, 'function redriveClock(){', '\nasync function'), /CrucixChanges\?\.refresh\(\)/);
  assert.match(html, /setInterval\(\(\)=>\{updateRuntimeStatus\(\);refreshLiveFreshness\(\);window\.CrucixChanges\?\.refresh\(\);\},30000\)/);
});

function layoutApi() {
  const header = sliceBetween(html, 'const dashboardZones = [', 'const dashboardFixedModuleIds');
  const context = vm.createContext({});
  vm.runInContext(header + "\nconst dashboardFixedModuleIds=['map','mapRegions'];", context);
  vm.runInContext(html.slice(html.indexOf('function createDefaultDashboardLayout('), html.indexOf('function loadDashboardLayout(')), context);
  const plain = value => JSON.parse(JSON.stringify(value));
  return { fresh: () => plain(vm.runInContext('createDefaultDashboardLayout', context)()), normalize: raw => plain(vm.runInContext('normalizeDashboardLayout', context)(raw)) };
}
const OLD_RAIL = ['sourceHealth', 'liveSources', 'sweepDelta'];
// The layouts below have seen the Country risk panel (2.13), so only the What changed rules are in play.
const oldLayout = (extra = {}) => ({ zones: { left: ['sensorGrid'], center1: ['newsTicker'], center2: [], center3: [], right: OLD_RAIL }, fixed: { map: false }, ...extra, visibility: { countryRisk: true, ...(extra.visibility ?? { sourceHealth: false }) } });

test('a saved layout that never held the panel gets it at the top of its right rail, visible; a fresh layout has it there too', () => {
  const { fresh, normalize } = layoutApi();
  assert.equal(fresh().zones.right[0], 'changes');
  assert.equal(fresh().visibility.changes, true);
  const merged = normalize(oldLayout());
  assert.deepEqual(merged.zones.right.slice(0, 4), ['changes', 'sourceHealth', 'liveSources', 'sweepDelta'], 'on top, the user\'s own order after it');
  assert.equal(merged.visibility.changes, true, 'and visible');
  assert.equal(merged.visibility.sourceHealth, false, 'the saved choices stay');
  assert.deepEqual(merged.zones.left.slice(0, 1), ['sensorGrid']);
  assert.equal(Object.values(merged.zones).flat().filter(id => id === 'changes').length, 1, 'once');
  assert.equal(normalize(null).zones.right[0], 'changes', 'no saved layout: the default');
  assert.equal(normalize('garbage').zones.right[0], 'changes');
});

test('a layout that already holds the panel keeps it where it is, in any zone, however the user arranged it', () => {
  const { normalize } = layoutApi();
  const left = normalize(oldLayout({ zones: { left: ['sensorGrid', 'changes', 'nuclearWatch'], center1: [], center2: [], center3: [], right: OLD_RAIL } }));
  assert.deepEqual(left.zones.left.slice(0, 3), ['sensorGrid', 'changes', 'nuclearWatch'], 'a panel the user moved to the left rail stays there');
  assert.equal(left.zones.right.includes('changes'), false);
  const last = normalize(oldLayout({ zones: { left: [], center1: [], center2: [], center3: [], right: [...OLD_RAIL, 'changes'] } }));
  assert.equal(last.zones.right.indexOf('changes'), 3, 'at the end of the rail stays at the end');
  // A layout saved after this release lists every panel in a zone and in visibility: it is not changed on the next load.
  const saved = normalize(oldLayout());
  saved.zones.right = saved.zones.right.filter(id => id !== 'changes').concat('changes');
  assert.equal(normalize(saved).zones.right.at(-1), 'changes', 'after a save the panel counts as seen');
});

test('a user who hid the panel does not get it back: a visibility entry means the layout has seen it', () => {
  const { normalize } = layoutApi();
  const hidden = normalize(oldLayout({ visibility: { sourceHealth: false, changes: false } }));
  assert.equal(hidden.visibility.changes, false, 'it stays hidden');
  assert.notEqual(hidden.zones.right[0], 'changes', 'and is not put on top');
  assert.deepEqual(hidden.zones.right.slice(0, 3), OLD_RAIL);
  assert.equal(hidden.zones.right.includes('changes'), true, 'it keeps a place for when the user turns it on');
  const entry = normalize(oldLayout({ visibility: { changes: true } }));
  assert.notEqual(entry.zones.right[0], 'changes', 'a visibility entry of any kind counts as seen');
  assert.equal(entry.visibility.changes, true);
  assert.equal(normalize({ zones: { right: ['changes'] }, visibility: { changes: false } }).visibility.changes, false);
});

test('the workspace profiles know the panel: default zones, the presets and an old stored profile', () => {
  const source = read('dashboard/public/intelligence.js');
  assert.match(source, /right: \['changes', 'countryRisk', 'crossSourceSignals'/, 'first in the right rail of the default zones');
  assert.equal(count(sliceBetween(source, 'const DEFAULT_ZONES = {', '};'), /'changes'/g), 1);
  const market = sliceBetween(source, "id === 'market' ? [", "] : id === 'infrastructure'"), infrastructure = sliceBetween(source, "id === 'infrastructure' ? [", "] : PANELS");
  assert.ok(market.includes("'changes'") && infrastructure.includes("'changes'"), 'the two explicit presets list it (research takes every panel)');
  assert.ok(market.indexOf("'changes'") < market.indexOf("'liveSources'") && infrastructure.indexOf("'changes'") < infrastructure.indexOf("'liveSources'"));
});

test('the offline snapshot keeps the changes object and stays far below the 5 MiB guard', async () => {
  assert.ok(JSON.parse(read('dashboard/public/pwa.js').match(/const KEYS = (\[[^\]]*\]);/)[1].replaceAll("'", '"')).includes('changes'), 'pwa.js KEYS lists changes');
  // The biggest object the server can emit: every list at its cap, every string at its length bound.
  const long = length => 'x'.repeat(length);
  const biggest = { since: '2026-10-03T09:45:00.000Z', at: '2026-10-03T10:00:00.000Z', baseline: false,
    events: { new: Array.from({ length: CHANGE_CAPS.events }, (_, index) => ({ id: ID(index), title: long(200), kind: long(40), source: long(120), domain: 'security', severity: 'critical', observedAt: '2026-10-03T09:45:00.000Z' })), newTotal: 5000, expiredTotal: 5000 },
    sources: Array.from({ length: CHANGE_CAPS.sources }, (_, index) => ({ source: long(120), domain: 'security', from: 'disabled', to: 'error' })),
    signals: Array.from({ length: CHANGE_CAPS.signals }, (_, index) => ({ key: long(80), label: long(200), direction: long(20), severity: 'critical', type: 'escalated' })),
    domains: Object.fromEntries(DOMAIN_IDS.map(id => [id, 5000])) };
  const bytes = new TextEncoder().encode(JSON.stringify(biggest)).byteLength;
  assert.ok(bytes < 64 * 1024, `${bytes} bytes of changes at every cap and bound`);
  // The same snapshot through pwa.js: changes survives safeSnapshot and the 5 MiB check.
  const values = new Map();
  const db = { close() {}, transaction() {
    let pending = 0, finished = false; const tx = { abort() { finished = true; }, objectStore() { return store; } };
    const schedule = fn => { pending++; queueMicrotask(() => { fn(); pending--; if (!pending && !finished) { finished = true; queueMicrotask(() => tx.oncomplete?.()); } }); };
    const store = { get(key) { const request = {}; schedule(() => { request.result = structuredClone(values.get(key)); request.onsuccess?.(); }); return request; }, put(value, key) { schedule(() => values.set(key, structuredClone(value))); }, delete(key) { schedule(() => values.delete(key)); } };
    return tx; } };
  const window = { indexedDB: { open() { const request = {}; queueMicrotask(() => { request.result = db; request.onsuccess?.(); }); return request; } }, navigator: {}, addEventListener() {} };
  vm.runInNewContext(read('dashboard/public/pwa.js'), { window, document: { querySelector: () => null }, TextEncoder, Date, JSON, Promise, Error, Object, Number, Array });
  await window.CrucixPWA.setOfflineEnabled(true);
  assert.equal(await window.CrucixPWA.saveSnapshot({ meta: { timestamp: new Date().toISOString() }, events: [], health: [], changes: biggest }), true);
  const saved = await window.CrucixPWA.restoreSnapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(saved.data.changes)), biggest, 'the changes object is stored whole');
});

test('the shell caches changes.js and changes.css, once each', () => {
  const sw = read('dashboard/public/sw.js'), base = JSON.parse(sw.match(/const BASE = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
  for (const path of ['/changes.js', '/changes.css']) assert.equal(base.filter(item => item === path).length, 1, path);
  assert.equal(new Set(base).size, base.length);
  assert.ok(sw.includes("const CACHE = 'crucix-shell-v2.13.0';"), 'the cache name carries the release version');
});

// ===== the server's object, as the page reads it =====

test('the caps the panel reports as "capped" are the server\'s (CHANGE_CAPS)', () => {
  const source = read('dashboard/public/changes.js');
  assert.match(source, new RegExp(`const CAPS=\\{events:${CHANGE_CAPS.events},sources:${CHANGE_CAPS.sources},signals:${CHANGE_CAPS.signals}\\}`));
});

test('a real buildChanges object and a real mergeChanges object render, with their totals, caps and nulls', () => {
  const snapshot = (stamp, events, health = [], delta) => ({ meta: { timestamp: stamp }, events, health, delta });
  const event = (index, extra = {}) => ({ id: ID(index), title: 'Record ' + index, kind: 'news', source: { name: index % 2 ? 'USGS' : 'GDELT' }, severity: ['extreme', 'high', 'moderate', 'low', undefined][index % 5], observedAt: '2026-10-03T09:00:00.000Z', ...extra });
  const before = snapshot('2026-10-03T09:45:00.000Z', [event(1)], [{ n: 'USGS' }, { n: 'GDELT' }]);
  const after = snapshot('2026-10-03T10:00:00.000Z', Array.from({ length: 60 }, (_, index) => event(index + 1)), [{ n: 'USGS', err: true }, { n: 'GDELT' }], { signals: { new: [{ key: 'tg_urgent:1', reason: 'Urgent post' }], escalated: [{ key: 'vix', label: 'VIX', direction: 'up', severity: 'critical' }] } });
  const built = buildChanges(before, after);
  const r = mounted({ changes: built, openEvent() {}, openMatrix() {} });
  const out = r.api.panelHtml(built);
  assert.equal(count(out, /data-changes-event=/g), SHOW, 'a few rows until "Show all" is used');
  assert.ok(out.includes(`Showing ${SHOW} of 59 new records, most severe first.`), 'the note names the real total');
  const opened = r.api.panelHtml(built, { expanded: { records: true } });
  assert.equal(count(opened, /data-changes-event=/g), CHANGE_CAPS.events);
  assert.ok(opened.includes(`Showing ${CHANGE_CAPS.events} of 59 new records, most severe first.`), 'the capped list names the real total');
  assert.ok(out.includes('<h4 id="changesRecords">New records <span class="ch-n">59</span></h4>'));
  assert.match(out, /data-changes-source="USGS"/);
  assert.equal(count(out, /data-signal=/g), 2);
  assert.ok(out.includes('data-type="escalated"') && out.includes('sev-critical'));
  assert.equal(r.api.chipHtml(built, 'all').match(/<span class="ch-n">(\d+)<\/span>/)[1], String(59 + 1 + 2), 'newTotal + a transition + two signals');
  const merged = mergeChanges([built, buildChanges(after, snapshot('2026-10-03T10:15:00.000Z', [...after.events, event(70)], after.health))]);
  const second = r.api.panelHtml(merged, { window: '1h', windowChanges: merged });
  assert.ok(second.includes('≤') && second.includes('up to'), 'a merged window is "up to"');
});

// ===== locales =====

test('the default row counts of the module are the ones these tests pin', () => {
  assert.match(read('dashboard/public/changes.js'), new RegExp(`const SHOW=\\{records:${SHOW},sources:${SHOW},signals:${SHOW}\\}`));
});

test('the English fallback text of the module is the English locale text, key for key', () => {
  const source = read('dashboard/public/changes.js'), literal = /const COPY=(\{[\s\S]*?\});\r?\n  let opts/.exec(source); // a Windows checkout has CRLF line endings
  assert.ok(literal, 'the COPY table');
  const copy = vm.runInNewContext('(' + literal[1] + ')');
  assert.deepEqual(JSON.parse(JSON.stringify(copy)), JSON.parse(read('locales/en.json')).changes);
});

test('the panel reads its words in hu and fr', () => {
  for (const [lang, title, last] of [['hu', 'Mi változott', 'Utolsó lekérdezés'], ['fr', 'Ce qui a changé', 'Dernier scan']]) {
    const { api } = mounted({ changes: FULL, t: localT(lang), openMatrix() {} });
    const out = api.panelHtml(FULL);
    assert.ok(out.includes(`>${title}</h3>`) && out.includes(`>${last}</button>`), lang);
    assert.ok(out.includes(strings(lang).get('inspector.level.critical')), `${lang}: the level word`);
    assert.ok(out.includes(strings(lang).get('matrix.stateError')), `${lang}: the state word`);
  }
});

test('the signal rows read the delta engine labels in the page language by key, the stored label as the fallback', () => {
  const withDelta = lang => { const table = new Map([...strings(lang), ...flatten(JSON.parse(read(`locales/${lang}.json`)).delta, 'delta')]); return (key, fallback) => table.has(key) ? table.get(key) : (fallback ?? key); };
  const changes = { ...FULL, signals: [...FULL.signals, { key: 'source_degradation', label: '3 additional sources failing (4 total down)', direction: null, severity: 'watch', type: 'new' }] };
  const titles = t => [...mounted({ changes, t }).api.panelHtml(changes).matchAll(/data-signal="[^"]*"><div class="ch-row">.*?<span class="ch-title">([^<]*)<\/span>/g)].map(match => match[1]);
  assert.deepEqual(titles(withDelta('hu')), ['VIX', 'Új sürgős OSINT-poszt', '3 additional sources failing (4 total down)'], 'its numbers are only in the stored sentence, so it stays');
  assert.deepEqual(titles(withDelta('fr')).slice(0, 2), ['VIX', 'Nouveau post OSINT urgent']);
  assert.deepEqual(titles(withDelta('en')).slice(0, 2), ['VIX', 'New urgent OSINT post'], 'English shows the engine wording');
  assert.deepEqual(titles(localT('hu')).slice(0, 2), ['VIX', 'Urgent post'], 'without the delta group the stored label stays');
});

test('the module falls back to English text when the page has no translation', () => {
  const { api } = mounted({ changes: FULL, t: () => undefined });
  assert.ok(api.panelHtml(FULL).includes('>What changed</h3>'));
  const broken = mounted({ changes: FULL, t: () => { throw new Error('no locale'); } });
  assert.ok(broken.api.panelHtml(FULL).includes('Last sweep'));
  assert.ok(broken.api.chipHtml(FULL, 'all').includes('changes since the previous sweep'));
});
