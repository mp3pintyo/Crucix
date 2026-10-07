import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// The Ctrl+K command palette: palette-core.js (pure: scoring, ranking, key logic) and palette.js (the <dialog>, the combobox/listbox,
// the live history search) in vm realms with a small fake DOM, then the page's item builders (paletteActions/paletteSources sliced
// from jarvis.html) and the registration. DOM nodes are only ever compared with assert.ok(a === b): a failing assert.equal on a
// fake node would walk the circular tree for minutes.
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('dashboard/public/jarvis.html');
const tick = () => new Promise(resolve => setImmediate(resolve));
const count = (text, pattern) => (text.match(pattern) || []).length;
const plain = value => JSON.parse(JSON.stringify(value));
const flatten = (value, prefix) => Object.entries(value || {}).flatMap(([key, item]) => item && typeof item === 'object' ? flatten(item, `${prefix}.${key}`) : [[`${prefix}.${key}`, item]]);
const locale = lang => JSON.parse(read(`locales/${lang}.json`));
const localT = lang => { const data = locale(lang), table = new Map([...flatten(data.palette, 'palette'), ...flatten(data.lenses, 'lenses'), ...flatten(data.intelligence, 'intelligence')]); return (key, fallback) => table.has(key) ? table.get(key) : fallback; };
const ID = number => 'event-' + number.toString(16).padStart(32, '0');
const defer = () => { const out = {}; out.promise = new Promise((resolve, reject) => { out.resolve = resolve; out.reject = reject; }); return out; };
// An event-handler attribute in the name position of a tag (attribute values are skipped whole, so escaped text is not a handler).
const HANDLER = /<[a-z][\w-]*(?:\s+[\w:-]+(?:="[^"]*")?)*?\s+on\w+(?:=|[\s>])/i;

// ===== palette-core.js =====

const core = () => { const window = {}; vm.runInNewContext(read('dashboard/public/palette-core.js'), { window }); return window.CrucixPaletteCore; };

test('score: exact > prefix > word prefix > in-order subsequence > no match', () => {
  const { score } = core();
  const exact = score('gdelt', 'GDELT'), prefix = score('gd', 'GDELT'), word = score('rec', 'Open records: GDELT'), loose = score('ogd', 'Open records: GDELT');
  assert.ok(exact > prefix && prefix > word && word > loose && loose > 0, JSON.stringify([exact, prefix, word, loose]));
  assert.equal(score('xyz', 'Open records: GDELT'), 0);
  assert.equal(score('gdeltx', 'GDELT'), 0, 'a longer query than the label never matches');
  assert.equal(score('tledg', 'GDELT'), 0, 'out of order is no match');
  assert.ok(score('open gdelt', 'Open records: GDELT') > 0, 'spaces in the query are skipped by the subsequence');
  assert.ok(score('gd elt', 'GDELT') > 0, 'also where the label has no space');
  assert.equal(score('', 'GDELT'), 0); assert.equal(score('   ', 'GDELT'), 0);
  assert.equal(score(null, 'GDELT'), 0); assert.equal(score('g', undefined), 0); assert.equal(score({}, 'x'), 0);
  // A word starts after any non-letter, non-digit: "(all sources)" and "IMF-PortWatch".
  assert.equal(score('port', 'IMF-PortWatch'), score('rec', 'Open records: GDELT'));
  assert.equal(score('all', 'Open the record browser (all sources)'), score('rec', 'Open records: GDELT'));
});

test('score: case- and diacritics-insensitive, so plain ASCII finds the Hungarian and French labels', () => {
  const { score } = core();
  const hazards = 'Természeti veszélyek és időjárás';
  assert.ok(score('termeszeti', hazards) > 0 && score('termeszeti', hazards) === score('Természeti', hazards), 'no accents, same score');
  assert.equal(score('TERMÉSZETI', hazards), score('természeti', hazards));
  assert.equal(score('veszely', hazards), score('rec', 'Open records: GDELT'), 'a word prefix without accents');
  assert.ok(score('idojaras', hazards) > 0, 'ő and á fold to o and a');
  assert.ok(score('energie', 'Énergie et chaîne d’approvisionnement') > 0 && score('chaine', 'Énergie et chaîne d’approvisionnement') > 0);
  assert.equal(score('é', 'e'), score('e', 'e'), 'an accented query folds too');
});

test('rank: keywords are searchable, the best score wins, ties keep their order, at most 12 by default', () => {
  const { rank } = core();
  const item = (id, label, keywords, group = 'action') => ({ id, group, label, keywords });
  const lens = item('lens:hazards', 'Témalencse: Természeti veszélyek és időjárás', ['hazards']);
  assert.deepEqual(rank([lens], 'hazard').map(entry => entry.id), ['lens:hazards'], 'the domain id finds the Hungarian lens');
  const source = item('records:USGS', 'Rekordok megnyitása: USGS', ['USGS', 'Természeti veszélyek és időjárás', 'hazards'], 'source');
  assert.deepEqual(rank([source], 'termeszeti').map(entry => entry.id), ['records:USGS'], 'a source is found by its domain label');
  const list = [item('a', 'Open records: GDELT'), item('b', 'GDELT'), item('c', 'gdelt tools'), item('d', 'Go deep to elt')];
  assert.deepEqual(rank(list, 'gdelt').map(entry => entry.id), ['b', 'c', 'a', 'd'], 'exact, prefix, word prefix, subsequence');
  const ties = Array.from({ length: 20 }, (_, index) => item('t' + index, 'Source ' + index));
  assert.deepEqual(rank(ties, 'source').map(entry => entry.id), ties.slice(0, 12).map(entry => entry.id), 'stable for ties, 12 by default');
  assert.equal(rank(ties, 'source', { limit: 5 }).length, 5);
  for (const limit of [0, -1, 1.5, 'x', null]) assert.equal(rank(ties, 'source', { limit }).length, 12, String(limit));
  assert.deepEqual(rank([item('x', 'Alpha'), null, 7, { label: 3 }], 'alpha').map(entry => entry.id), ['x'], 'junk entries are skipped');
});

test('rank: an empty query lists the actions only (up to 12), never the source list', () => {
  const { rank } = core();
  const actions = Array.from({ length: 16 }, (_, index) => ({ id: 'a' + index, group: 'action', label: 'Action ' + index }));
  const sources = Array.from({ length: 50 }, (_, index) => ({ id: 's' + index, group: 'source', label: 'Source ' + index }));
  const out = rank([...sources, ...actions], '   ');
  assert.equal(out.length, 12);
  assert.ok(out.every(entry => entry.group === 'action'));
  assert.deepEqual(out.map(entry => entry.id), actions.slice(0, 12).map(entry => entry.id));
  assert.deepEqual(plain(rank(sources, '')), []);
  assert.deepEqual(plain(rank('nope', 'x')), []);
});

test('isOpenKey: Ctrl+K and Cmd+K (any case, any layout via the KeyK code), never with Shift or Alt, never plain k', () => {
  const { isOpenKey } = core();
  const key = (value, extra = {}) => isOpenKey({ key: value, code: 'KeyK', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });
  assert.equal(key('k', { ctrlKey: true }), true);
  assert.equal(key('k', { metaKey: true }), true);
  assert.equal(key('K', { ctrlKey: true }), true, 'Caps Lock');
  assert.equal(key('л', { ctrlKey: true }), true, 'a Cyrillic layout: the physical K key');
  assert.equal(key('k', { ctrlKey: true, shiftKey: true }), false);
  assert.equal(key('k', { ctrlKey: true, altKey: true }), false);
  assert.equal(key('k', { metaKey: true, altKey: true }), false);
  assert.equal(key('k'), false, 'plain k is the inspector key');
  assert.equal(key('j', { ctrlKey: true, code: 'KeyJ' }), false);
  assert.equal(key('t', { ctrlKey: true, code: 'KeyK' }), false, 'Dvorak: the letter decides when it is a Latin letter');
  assert.equal(key('k', { ctrlKey: true, isComposing: true }), false, 'not while an IME composes');
  assert.equal(isOpenKey(null), false); assert.equal(isOpenKey({}), false);
});

test('shouldIgnoreTarget: other text fields yes, the palette input no, buttons and the page no', () => {
  const { shouldIgnoreTarget } = core();
  const node = (tagName, attrs = {}, extra = {}) => ({ tagName, type: attrs.type || '', getAttribute: name => Object.hasOwn(attrs, name) ? attrs[name] : null, hasAttribute: name => Object.hasOwn(attrs, name), ...extra });
  assert.equal(shouldIgnoreTarget(node('INPUT', { type: 'text' })), true);
  assert.equal(shouldIgnoreTarget(node('INPUT', { type: 'search' })), true);
  assert.equal(shouldIgnoreTarget(node('TEXTAREA')), true);
  assert.equal(shouldIgnoreTarget(node('SELECT')), true);
  assert.equal(shouldIgnoreTarget(node('DIV', {}, { isContentEditable: true })), true);
  assert.equal(shouldIgnoreTarget(node('INPUT', { type: 'text', 'data-palette-input': '' })), false, 'its own input');
  for (const type of ['checkbox', 'radio', 'range', 'button', 'submit']) assert.equal(shouldIgnoreTarget(node('INPUT', { type })), false, type);
  assert.equal(shouldIgnoreTarget(node('BUTTON')), false);
  assert.equal(shouldIgnoreTarget(node('BODY')), false);
  assert.equal(shouldIgnoreTarget(null), false); assert.equal(shouldIgnoreTarget({}), false);
});

// ===== palette.js in a fake DOM =====

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
const decode = text => text.replace(/&(?:lt|gt|quot|#39|amp);/g, entity => ENTITIES[entity]);
function parseMarkup(markup, doc, root) {
  const holder = { kids: [] }, stack = [holder];
  const token = /<(\/?)([a-zA-Z][\w]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*>|([^<]+)/g;
  for (let match; (match = token.exec(markup));) {
    const top = stack[stack.length - 1], parent = top === holder ? root : top;
    if (match[4] !== undefined) { const text = new Node('#text', doc); text.own = decode(match[4]); text.parentNode = parent; top.kids.push(text); continue; }
    if (match[1]) { while (stack.length > 1 && stack.pop().tag !== match[2]); continue; }
    const node = new Node(match[2], doc);
    for (const attribute of match[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attribute[1], decode(attribute[2] ?? ''));
    node.parentNode = parent; top.kids.push(node); stack.push(node);
  }
  return holder.kids;
}
class Node {
  constructor(tag, doc) { Object.assign(this, { tag, doc, attrs: new Map(), kids: [], parentNode: null, markup: '', listeners: [], own: '', focused: 0, open: false, value: '', inert: false, scrolled: 0, writes: 0, type: '' }); }
  get tagName() { return this.tag.toUpperCase(); }
  get id() { return this.attrs.get('id') || ''; }
  set id(value) { this.attrs.set('id', String(value)); }
  get className() { return this.attrs.get('class') || ''; }
  set className(value) { this.attrs.set('class', String(value)); }
  get textContent() { return this.own + this.kids.map(kid => kid.textContent).join(''); }
  set textContent(value) { this.own = String(value); this.kids = []; this.writes++; }
  get innerHTML() { return this.markup; }
  set innerHTML(value) { this.markup = String(value); this.kids = parseMarkup(this.markup, this.doc, this); }
  get isConnected() { for (let node = this; node; node = node.parentNode) if (node === this.doc.body) return true; return false; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.kids.push(node); } }
  remove() { if (this.parentNode) this.parentNode.kids.splice(this.parentNode.kids.indexOf(this), 1); this.parentNode = null; }
  addEventListener(type, fn, options) { this.listeners.push({ type, fn, capture: options === true || !!(options && options.capture) }); }
  focus() { this.focused++; this.doc.activeElement = this; }
  scrollIntoView() { this.scrolled++; }
  showModal() { if (this.open) throw new Error('InvalidStateError'); this.open = true; this.attrs.set('open', ''); }
  close() { if (this.open) { this.open = false; this.attrs.delete('open'); dispatch(this.doc, this, 'close', {}); } }
  contains(node) { for (let at = node; at; at = at.parentNode) if (at === this) return true; return false; }
  matches(selector) {
    const [, tag, rest] = /^([\w-]*)(.*)$/.exec(selector);
    if (tag && this.tag !== tag) return false;
    for (const part of rest.match(/\.[\w-]+|#[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) || []) {
      if (part[0] === '.') { if (!this.className.split(' ').includes(part.slice(1))) return false; continue; }
      if (part[0] === '#') { if (this.id !== part.slice(1)) return false; continue; }
      const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
      if (!this.attrs.has(name) || (value !== undefined && this.attrs.get(name) !== value)) return false;
    }
    return true;
  }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.tag !== '#text' && node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { return all(this).slice(1).filter(node => node.tag !== '#text' && selector.split(',').some(part => node.matches(part.trim()))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function all(node) { return [node, ...node.kids.flatMap(all)]; }
// Capture listeners on the document, then the target and its ancestors (bubble), then the document's bubble listeners; stopPropagation
// ends the walk. Returns the event (defaultPrevented tells whether the page took the key).
function dispatch(doc, target, type, init) {
  const event = { type, target, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...init };
  const run = (list, capture) => { for (const entry of list.filter(item => item.type === type && item.capture === capture)) { if (event.stopped) return; entry.fn.call(null, event); } };
  run(doc.listeners, true);
  for (let node = target; node && !event.stopped; node = node.parentNode) if (node !== doc) run(node.listeners || [], false);
  if (!event.stopped) run(doc.listeners, false);
  return event;
}

const MODS = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
function realm({ t = localT('en'), actions, sources, routes = {}, replay = false, platform = 'Win32', openEvent, now = Date.parse('2026-10-03T10:00:00.000Z'), extra = {}, records = true } = {}) {
  const errors = [], requests = [], aborted = [], timers = [], ran = [], opened = [];
  const doc = { activeElement: null, listeners: [] };
  doc.body = new Node('body', doc); doc.activeElement = doc.body;
  doc.createElement = tag => new Node(tag, doc);
  doc.getElementById = id => all(doc.body).find(node => node.id === id) || null;
  doc.querySelectorAll = selector => doc.body.querySelectorAll(selector);
  doc.querySelector = selector => doc.body.querySelector(selector);
  doc.addEventListener = (type, fn, options) => doc.listeners.push({ type, fn, capture: options === true || !!(options && options.capture) });
  const add = (tag, attrs = {}) => { const node = new Node(tag, doc); for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value); doc.body.append(node); return node; };
  class AbortController { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; aborted.push(this); } }
  const window = { document: doc, navigator: { platform }, matchMedia: () => ({ matches: false }), CrucixIntelligence: { openEvent: id => opened.push(id) } };
  const context = vm.createContext({ window, document: doc, navigator: window.navigator, console: { error: (...args) => errors.push(args) }, AbortController, Date, Object, Array, Number, JSON, Set, Map, String, Promise, Math, encodeURIComponent });
  if (records) vm.runInContext(read('dashboard/public/record-core.js'), context);
  vm.runInContext(read('dashboard/public/palette-core.js'), context);
  vm.runInContext(read('dashboard/public/palette.js'), context);
  const item = (id, label, group = 'action', more = {}) => ({ id, group, label, hint: '', run: () => ran.push({ id, focus: doc.activeElement }), ...more });
  const actionList = actions || [item('alerts', 'Open alerts'), item('settings', 'Open settings'), item('glossary', 'Open the signal guide')];
  const sourceList = sources || [item('records:GDACS', 'Open records: GDACS', 'source', { hint: 'Natural hazards and weather', keywords: ['GDACS', 'Natural hazards and weather', 'hazards'] }), item('health:GDELT', 'Show in source health: GDELT', 'source', { hint: 'Security and conflict', keywords: ['GDELT'] })];
  // routes: url prefix -> function(url) returning a value, a promise or throwing; every call is logged first.
  const fetchJson = (url, init) => { requests.push({ url, init }); const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix)); if (!route) return Promise.reject(Object.assign(new Error('HTTP 404'), { status: 404 })); try { return Promise.resolve(route[1](url, init)); } catch (error) { return Promise.reject(error); } };
  // The injected scheduler: nothing runs until flush().
  const schedule = (fn, ms) => { timers.push({ fn, ms, cancelled: false, done: false }); return timers.length; };
  const cancel = handle => { if (timers[handle - 1]) timers[handle - 1].cancelled = true; };
  const flush = () => { for (const timer of timers) if (!timer.cancelled && !timer.done) { timer.done = true; timer.fn(); } };
  const options = { fetchJson, t, esc: undefined, actions: () => actionList, sources: () => sourceList, schedule, cancel, isReplay: () => replay, now: () => now, ...(openEvent ? { openEvent } : {}), ...extra };
  const api = window.CrucixPalette;
  const part = id => doc.getElementById(id);
  const r = { api, window, doc, errors, requests, aborted, timers, ran, opened, flush, add, options, part,
    mount: more => api.mount({ ...options, ...more }),
    dialog: () => all(doc.body).find(node => node.tag === 'dialog' && node.id === 'palette'),
    input: () => part('palette-input'), list: () => part('palette-list'), status: () => part('palette-status'), note: () => part('palette-note'),
    options: () => part('palette-list').querySelectorAll('[role="option"]'),
    labels: () => part('palette-list').querySelectorAll('[role="option"]').map(node => node.querySelector('.pl-label').textContent),
    active: () => { const id = part('palette-input').getAttribute('aria-activedescendant'); return id ? doc.getElementById(id) : null; },
    key: (key, mods = {}, target = doc.activeElement) => dispatch(doc, target, 'keydown', { key, code: /^[a-z]$/i.test(key) ? 'Key' + key.toUpperCase() : key, ...MODS, ...mods }),
    type: text => { const input = part('palette-input'); input.value = text; dispatch(doc, input, 'input', {}); },
    click: node => dispatch(doc, node, 'click', {}) };
  return r;
}
const mounted = settings => { const r = realm(settings); assert.equal(r.mount(), true); return r; };

test('mount builds the dialog once: a combobox input controlling a listbox, a polite status line and the key hint', () => {
  const r = realm();
  assert.equal(r.api.isOpen(), false, 'closed before mount');
  assert.equal(r.api.open(), false, 'open before mount does nothing');
  assert.equal(r.mount(), true);
  assert.equal(r.mount(), false, 'a second mount is refused');
  assert.equal(r.api.mount(null), false);
  assert.equal(all(r.doc.body).filter(node => node.tag === 'dialog').length, 1);
  const dialog = r.dialog(), input = r.input(), list = r.list(), status = r.status();
  assert.ok(dialog && dialog.contains(input) && dialog.contains(list) && dialog.contains(status));
  assert.equal(dialog.getAttribute('aria-label'), 'Command palette');
  for (const [name, value] of [['role', 'combobox'], ['aria-controls', 'palette-list'], ['aria-autocomplete', 'list'], ['aria-expanded', 'false'], ['autocomplete', 'off'], ['data-palette-input', ''], ['aria-describedby', 'palette-keys']]) assert.equal(input.getAttribute(name), value, name);
  assert.equal(input.getAttribute('type'), 'text', 'not type=search: Esc must not just clear the field');
  assert.ok(input.getAttribute('aria-label') && input.getAttribute('placeholder'));
  assert.equal(list.getAttribute('role'), 'listbox');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(r.part('palette-keys').textContent, locale('en').palette.keys);
  assert.ok(r.doc.listeners.some(entry => entry.type === 'keydown' && entry.capture), 'the open key is captured at the document');
  assert.deepEqual(r.errors, []);
});

test('open shows the actions with the first one active; Esc closes and the focus goes back to where it was', () => {
  const r = mounted();
  const opener = r.add('button', { id: 'somewhere' }); opener.focus();
  assert.equal(r.api.open(), true);
  assert.equal(r.api.open(), false, 'already open');
  assert.ok(r.api.isOpen() && r.dialog().open);
  assert.ok(r.doc.activeElement === r.input(), 'the input takes the focus');
  assert.deepEqual(r.labels(), ['Open alerts', 'Open settings', 'Open the signal guide'], 'an empty query lists the actions, not the sources');
  assert.equal(r.input().getAttribute('aria-expanded'), 'true');
  assert.ok(r.active() === r.options()[0], 'aria-activedescendant names the first option');
  assert.equal(r.options()[0].getAttribute('aria-selected'), 'true');
  assert.equal(r.options()[1].getAttribute('aria-selected'), 'false');
  const esc = r.key('Escape');
  assert.ok(esc.defaultPrevented && esc.stopped, 'Esc is taken (it must not close the glossary behind the palette too)');
  assert.equal(r.api.isOpen(), false);
  assert.equal(r.dialog().open, false);
  assert.ok(r.doc.activeElement === opener, 'focus restored to the opener');
  assert.deepEqual(r.ran, [], 'Esc runs nothing');
});

test('focus return: a detached opener falls back to the header button; close() and the dialog cancel event close too', () => {
  const r = mounted();
  r.add('div', { id: 'topbar' }).innerHTML = r.api.button();
  const first = r.add('button'); first.focus();
  r.api.open(); first.remove();
  r.api.close();
  assert.ok(r.doc.activeElement === r.part('paletteTrigger'), 'the rebuilt top bar button takes the focus');
  const opener = r.add('button'); opener.focus();
  r.api.open();
  const cancel = dispatch(r.doc, r.dialog(), 'cancel', {});
  assert.ok(cancel.defaultPrevented, 'the browser close request is handled by the palette');
  assert.equal(r.api.isOpen(), false);
  assert.ok(r.doc.activeElement === opener);
  r.api.open(); r.dialog().close();
  assert.equal(r.api.isOpen(), false, 'a dialog closed by the browser ends the palette too');
  // Browsers queue the close event: the one of an Esc can arrive after a quick reopen (Esc, then Ctrl+K) and must not close it.
  r.api.open();
  dispatch(r.doc, r.dialog(), 'close', {});
  assert.equal(r.api.isOpen(), true, 'a late close event of the previous session is ignored');
  assert.equal(r.dialog().open, true);
  r.api.close();
  assert.doesNotThrow(() => r.api.close(), 'close when closed');
});

test('ArrowDown/ArrowUp wrap, Home/End jump, and aria-activedescendant follows', () => {
  const r = mounted();
  r.api.open();
  const ids = () => r.options().map(node => node.id), at = () => ids().indexOf(r.input().getAttribute('aria-activedescendant'));
  assert.equal(new Set(ids()).size, 3, 'each option has its own id');
  assert.ok(ids().every(id => /^pl-o\d+$/.test(id)));
  assert.equal(at(), 0);
  assert.ok(r.key('ArrowDown').defaultPrevented); assert.equal(at(), 1);
  r.key('ArrowDown'); assert.equal(at(), 2);
  r.key('ArrowDown'); assert.equal(at(), 0, 'wraps to the top');
  r.key('ArrowUp'); assert.equal(at(), 2, 'wraps to the bottom');
  assert.ok(r.active().scrolled > 0, 'the active option is kept in view');
  r.key('Home'); assert.equal(at(), 0);
  r.key('End'); assert.equal(at(), 2);
  assert.equal(r.options().filter(node => node.getAttribute('aria-selected') === 'true').length, 1, 'one selected option');
  assert.equal(r.options()[2].getAttribute('aria-selected'), 'true');
  const tab = r.key('Tab');
  assert.ok(tab.defaultPrevented, 'Tab stays in the dialog');
  assert.ok(r.doc.activeElement === r.input());
  const shiftTab = r.key('Tab', { shiftKey: true });
  assert.ok(shiftTab.defaultPrevented);
  const before = ids().join();
  r.api.close(); r.api.open();
  assert.equal(ids().join(), before, 'the same items keep the same ids across opens');
});

test('Enter runs the active item after the palette closed (focus back first), then nothing more; a click runs an item too', () => {
  const r = mounted();
  const opener = r.add('button'); opener.focus();
  r.api.open();
  r.key('ArrowDown');
  const enter = r.key('Enter');
  assert.ok(enter.defaultPrevented);
  assert.deepEqual(r.ran.map(entry => entry.id), ['settings']);
  assert.ok(r.ran[0].focus === opener, 'the item runs with the focus back on the opener (a dialog it opens returns there)');
  assert.equal(r.api.isOpen(), false);
  r.api.open();
  r.click(r.options()[2].querySelector('.pl-label'));
  assert.deepEqual(r.ran.map(entry => entry.id), ['settings', 'glossary'], 'a click on any part of an option runs it');
  assert.equal(r.api.isOpen(), false);
  r.api.open();
  r.click(r.list());
  assert.equal(r.ran.length, 2, 'a click between options runs nothing');
  assert.equal(r.api.isOpen(), true);
  // A throwing or rejecting item is logged, the palette is closed anyway.
  const bad = mounted({ actions: [{ id: 'boom', group: 'action', label: 'Boom', run: () => { throw new Error('boom'); } }, { id: 'later', group: 'action', label: 'Later', run: () => Promise.reject(new Error('later')) }] });
  bad.api.open(); assert.doesNotThrow(() => bad.key('Enter'));
  assert.equal(bad.api.isOpen(), false);
  bad.api.open(); bad.key('End'); bad.key('Enter');
  return tick().then(() => assert.equal(bad.errors.length, 2, 'both failures logged'));
});

test('Enter with an IME composition or with no results does nothing', async () => {
  const r = mounted({ routes: { '/api/history': () => ({ items: [] }) } });
  r.api.open();
  const composing = r.key('Enter', { isComposing: true });
  assert.equal(composing.defaultPrevented, false);
  assert.deepEqual(r.ran, []);
  r.type('zzzz');
  assert.equal(r.note().textContent, 'Searching the record history…', 'no "no matches" while the history may still answer');
  r.flush(); await tick();
  assert.deepEqual(r.labels(), []);
  assert.equal(r.input().getAttribute('aria-expanded'), 'false');
  assert.equal(r.input().getAttribute('aria-activedescendant'), null, 'no active option');
  r.key('Enter'); r.key('ArrowDown'); r.key('Home');
  assert.deepEqual(r.ran, []);
  assert.equal(r.api.isOpen(), true);
  assert.equal(r.note().textContent, 'No matches.');
});

test('typing ranks actions and sources together (12 at most), the domain finds a source, the active option resets to the top', () => {
  const sources = Array.from({ length: 30 }, (_, index) => ({ id: 'records:S' + index, group: 'source', label: 'Open records: Source ' + index, hint: 'Space', keywords: ['Space', 'space'], run() {} }));
  sources.push({ id: 'records:GDACS', group: 'source', label: 'Open records: GDACS', hint: 'Natural hazards and weather', keywords: ['GDACS', 'Natural hazards and weather', 'hazards'], run() {} });
  const r = mounted({ sources });
  r.api.open();
  r.type('source');
  assert.equal(r.options().length, 12);
  r.key('End');
  r.type('source 2');
  assert.ok(r.active() === r.options()[0], 'a new query starts at the top');
  assert.equal(r.labels()[0], 'Open records: Source 2');
  r.type('spa');
  assert.equal(r.options().length, 12, 'the domain keyword finds the sources');
  r.type('alerts');
  assert.deepEqual(r.labels(), ['Open alerts']);
  const groups = r.list().querySelectorAll('[role="group"]');
  assert.equal(groups.length, 1);
  assert.equal(r.doc.getElementById(groups[0].getAttribute('aria-labelledby')).textContent, 'Actions', 'the group is labelled');
  r.type('gdacs');
  assert.deepEqual(r.labels(), ['Open records: GDACS']);
  assert.equal(r.doc.getElementById(r.list().querySelector('[role="group"]').getAttribute('aria-labelledby')).textContent, 'Sources');
  assert.equal(r.options()[0].querySelector('.pl-hint').textContent, 'Natural hazards and weather', 'the domain is the hint');
});

test('groups follow their best match (a source that matches better comes first); records always come last', async () => {
  const r = mounted({ actions: [{ id: 'grid', group: 'action', label: 'Grid data access', run() {} }], sources: [{ id: 'records:GDACS', group: 'source', label: 'GDACS', run() {} }], routes: { '/api/history': () => ({ items: [{ id: ID(9), title: 'GDACS orange alert' }] }) } });
  r.api.open();
  r.type('gdacs');
  assert.deepEqual(r.labels(), ['GDACS', 'Grid data access'], 'the exact source before the loose action');
  const heads = () => r.list().querySelectorAll('[role="group"]').map(group => r.doc.getElementById(group.getAttribute('aria-labelledby')).textContent);
  assert.deepEqual(heads(), ['Sources', 'Actions']);
  r.flush(); await tick();
  assert.deepEqual(heads(), ['Sources', 'Actions', 'Records']);
  assert.deepEqual(r.options().map(node => node.getAttribute('data-palette-option')), ['0', '1', '2'], 'option indexes follow the order on screen');
});

test('an answer that arrives keeps the active option where the user moved it', async () => {
  const pending = defer();
  const r = mounted({ routes: { '/api/history': () => pending.promise } });
  r.api.open();
  r.type('open');
  r.key('ArrowDown'); r.key('ArrowDown');
  const before = r.active().id;
  r.flush();
  pending.resolve({ items: [{ id: ID(10), title: 'Open water report', kind: 'news' }] });
  await tick();
  assert.equal(r.labels().at(-1), 'Open water report');
  assert.equal(r.active().id, before, 'still the third option');
  assert.equal(r.active().querySelector('.pl-label').textContent, 'Open the signal guide');
});

test('the status line counts the results and is written only when its text changes', () => {
  const r = mounted();
  r.api.open();
  const status = r.status();
  assert.equal(status.textContent, '3 results');
  const writes = status.writes;
  r.key('ArrowDown'); r.key('ArrowDown');
  assert.equal(status.writes, writes, 'moving does not re-announce');
  r.type('open');
  assert.equal(status.textContent, '4 results', 'three actions and a source');
  r.type('open '); r.type('Open');
  assert.equal(status.writes, writes + 1, 'an equal count does not re-announce');
  r.type('alerts');
  assert.equal(status.textContent, '1 result');
  r.type('qqqq');
  assert.equal(status.textContent, 'No results');
  assert.equal(status.writes, writes + 3);
});

test('live search: 2+ characters, debounced 200 ms through the injected scheduler, limit=6, the query encoded', async () => {
  const answer = { items: [{ id: ID(1), kind: 'earthquake', title: 'M6.1 near Kobe', source: { name: 'USGS' }, lastSeenAt: '2026-10-03T09:57:00.000Z' }] };
  const r = mounted({ routes: { '/api/history': () => answer } });
  r.api.open();
  r.type('a');
  assert.equal(r.timers.length, 0, 'one character: no search');
  r.type('a&b'); r.type('a&b ü');
  assert.equal(r.requests.length, 0, 'nothing before the delay');
  assert.deepEqual(r.timers.map(timer => [timer.ms, timer.cancelled]), [[200, true], [200, false]], 'each keystroke restarts the delay');
  assert.equal(r.note().textContent, 'Searching the record history…');
  r.flush();
  assert.deepEqual(r.requests.map(request => request.url), ['/api/history?q=' + encodeURIComponent('a&b ü') + '&limit=6']);
  assert.ok(r.requests[0].init && r.requests[0].init.signal, 'the request carries an abort signal');
  await tick();
  assert.deepEqual(r.labels(), ['M6.1 near Kobe']);
  assert.equal(r.doc.getElementById(r.list().querySelectorAll('[role="group"]').at(-1).getAttribute('aria-labelledby')).textContent, 'Records');
  assert.equal(r.options()[0].querySelector('.pl-hint').textContent, 'Earthquake · USGS · 3m', 'kind, source and age');
  assert.equal(r.note().textContent, '', 'the searching note is gone');
  assert.equal(r.status().textContent, '1 result');
  r.type('  ab  ');
  r.flush();
  assert.equal(r.requests.at(-1).url, '/api/history?q=ab&limit=6', 'the query is trimmed');
  r.type(' a ');
  assert.equal(r.timers.filter(timer => !timer.cancelled && !timer.done).length, 0, 'a trimmed single character does not search');
  assert.deepEqual(r.labels().filter(label => label === 'M6.1 near Kobe'), [], 'records of an older query are gone at once');
});

test('race: the slow answer for "ab" arriving after the answer for "abc" is dropped, and its request was aborted', async () => {
  const pending = [];
  const r = mounted({ routes: { '/api/history': url => { const d = defer(); pending.push({ url, d }); return d.promise; } } });
  r.api.open();
  r.type('ab'); r.flush();
  r.type('abc'); r.flush();
  assert.deepEqual(pending.map(entry => entry.url), ['/api/history?q=ab&limit=6', '/api/history?q=abc&limit=6']);
  assert.equal(r.aborted.length, 1, 'the older request is aborted when a newer query starts');
  assert.ok(r.aborted[0].signal === r.requests[0].init.signal);
  pending[1].d.resolve({ items: [{ id: ID(3), kind: 'news', title: 'Result for abc', source: { name: 'GDELT' } }] });
  await tick();
  assert.deepEqual(r.labels(), ['Result for abc']);
  pending[0].d.resolve({ items: [{ id: ID(2), kind: 'news', title: 'Stale result for ab', source: { name: 'GDELT' } }] });
  await tick();
  assert.deepEqual(r.labels(), ['Result for abc'], 'the late, older answer never replaces the newer one');
  assert.deepEqual(r.errors, []);
});

test('closing cancels the pending search and drops a late answer; reopening starts clean', async () => {
  const pending = [];
  const r = mounted({ routes: { '/api/history': () => { const d = defer(); pending.push(d); return d.promise; } } });
  r.api.open();
  r.type('ab');
  r.api.close();
  assert.equal(r.timers[0].cancelled, true, 'the debounce timer is cleared on close');
  r.flush();
  assert.equal(r.requests.length, 0);
  r.api.open();
  assert.equal(r.input().value, '', 'the query is cleared');
  r.type('cd'); r.flush();
  r.api.close();
  assert.equal(r.aborted.length, 1, 'the running request is aborted on close');
  pending[0].resolve({ items: [{ id: ID(4), title: 'Late', kind: 'news', source: { name: 'X' } }] });
  await tick();
  r.api.open();
  assert.deepEqual(r.labels(), ['Open alerts', 'Open settings', 'Open the signal guide'], 'the late answer is not shown');
  assert.equal(r.note().textContent, '');
  // Records found in an earlier session are not shown again on the next open.
  r.type('ef'); r.flush();
  pending[1].resolve({ items: [{ id: ID(11), title: 'Shown once', kind: 'news' }] });
  await tick();
  assert.equal(r.labels().at(-1), 'Shown once');
  r.api.close(); r.api.open();
  assert.deepEqual(r.labels(), ['Open alerts', 'Open settings', 'Open the signal guide']);
});

test('a delay that fires after a newer keystroke (a scheduler that cannot cancel) does not search for the old query', () => {
  const r = mounted({ routes: { '/api/history': () => new Promise(() => {}) }, extra: { cancel: () => {} } });
  r.api.open();
  r.type('ab'); r.type('abc');
  r.flush();
  assert.deepEqual(r.requests.map(request => request.url), ['/api/history?q=abc&limit=6']);
  r.type('abcd'); r.api.close();
  r.flush();
  assert.equal(r.requests.length, 1, 'nor after the palette closed');
});

test('a failed search keeps the static results and only shows a quiet note (no console error)', async () => {
  for (const route of [() => { throw Object.assign(new Error('HTTP 503'), { status: 503 }); }, () => null, () => ({ items: 'nope' }), () => Promise.reject(new Error('offline'))]) {
    const r = mounted({ routes: { '/api/history': route } });
    r.api.open();
    r.type('open'); r.flush();
    await tick();
    assert.deepEqual(r.labels(), ['Open alerts', 'Open settings', 'Open the signal guide', 'Open records: GDACS'], 'the static results stay');
    assert.equal(r.note().textContent, locale('en').palette.historyFailed, route.toString());
    assert.equal(r.status().textContent, '4 results. ' + locale('en').palette.historyFailed, 'the count and the note are two sentences in the status line');
    assert.deepEqual(r.errors, [], 'no console spam');
  }
  const replaying = mounted({ replay: true });
  replaying.api.open(); replaying.type('open');
  assert.equal(replaying.status().textContent, '4 results. ' + locale('en').palette.replayNote);
});

test('an item that rebuilds the top bar (a lens switch) leaves the focus on the new node with the opener\'s id, or on the new palette button', () => {
  let topbar;
  // The lens switch re-renders the top bar with innerHTML: the browser drops the focus from the replaced nodes (onto <body>).
  const rebuild = () => { const had = topbar.kids.includes(r.doc.activeElement); for (const node of topbar.kids.slice()) node.remove(); topbar.innerHTML = r.api.button() + '<button id="eventsTrigger">Events</button>'; if (had) r.doc.activeElement = r.doc.body; };
  const elsewhere = { id: 'mover', label: 'Moves the focus itself', run: () => r.part('target').focus() };
  const r = mounted({ actions: [{ id: 'lens', label: 'Lens: Natural hazards', run: rebuild }, { id: 'detach', label: 'Detach only', run: () => { for (const node of topbar.kids.slice()) node.remove(); topbar.innerHTML = r.api.button() + '<button id="eventsTrigger">Events</button>'; } }, elsewhere] });
  topbar = r.add('div', { id: 'topbar' }); topbar.innerHTML = r.api.button() + '<button id="eventsTrigger">Events</button>';
  r.add('button', { id: 'target' });
  const opener = r.part('eventsTrigger'); opener.focus();
  r.api.open(); r.key('Enter');
  const fresh = r.part('eventsTrigger');
  assert.ok(fresh !== opener && !opener.isConnected, 'the top bar was rebuilt');
  assert.ok(r.doc.activeElement === fresh, 'the focus is on the new node that carries the opener\'s id, not on the body');
  // Opened from the page body: no id to go back to, so the new palette button takes the focus.
  r.doc.activeElement = r.doc.body;
  r.api.open(); r.key('Enter');
  assert.ok(r.doc.activeElement === r.part('paletteTrigger'), 'the rebuilt palette button has the focus');
  // A detached node still counted as the active element (no browser fix-up) is replaced the same way.
  r.part('eventsTrigger').focus(); r.api.open(); r.key('ArrowDown'); r.key('Enter');
  assert.ok(r.doc.activeElement === r.part('eventsTrigger') && r.doc.activeElement.isConnected, 'a detached active element is not left focused');
  // An item that moves the focus itself keeps it there.
  r.part('eventsTrigger').focus(); r.api.open(); r.key('End'); r.key('Enter');
  assert.ok(r.doc.activeElement === r.part('target'), 'the item\'s own focus move wins');
  assert.deepEqual(r.errors, []);
});

test('hostile titles, kinds, sources and labels are escaped; invalid record ids are not offered', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const answer = { items: [
    { id: ID(5), kind: '"><svg onload=alert(2)>', title: hostile, source: { name: '"><script>alert(3)</script>' }, lastSeenAt: 'not a time' },
    { id: 'event-../../etc', title: 'bad id' }, { id: ID(6) + '"', title: 'quote id' }, null, 'x', { id: ID(7), title: '' },
  ] };
  const sources = [{ id: 'x"y', group: 'source', label: 'Open records: <b>bold</b>', hint: '<i>hint</i>', run() {} }];
  const r = mounted({ sources, routes: { '/api/history': () => answer } });
  r.api.open();
  r.type('bold');
  assert.ok(!r.list().innerHTML.includes('<b>') && r.list().innerHTML.includes('&lt;b&gt;'));
  assert.deepEqual(r.labels(), ['Open records: <b>bold</b>'], 'shown as text');
  r.type('img'); r.flush();
  await tick();
  const markup = r.list().innerHTML;
  assert.ok(!HANDLER.test(markup), markup);
  assert.ok(!markup.includes('<img') && !markup.includes('<svg') && !markup.includes('<script'));
  assert.deepEqual(r.labels().slice(-2), [hostile, '—'], 'the title reads as text; an empty title is a dash');
  assert.equal(r.options().length, 2, 'only the two valid ids');
  assert.ok(r.options()[0].querySelector('.pl-hint').textContent.includes('"><script>alert(3)</script>'));
});

test('a record result opens through the open-by-id path (CrucixIntelligence.openEvent by default, or options.openEvent)', async () => {
  const answer = { items: [{ id: ID(8), kind: 'news', title: 'Flood warning', source: { name: 'GDACS' } }] };
  const r = mounted({ routes: { '/api/history': () => answer } });
  r.api.open(); r.type('flood'); r.flush(); await tick();
  r.key('Enter');
  assert.deepEqual(r.opened, [ID(8)]);
  assert.equal(r.api.isOpen(), false);
  const seen = [];
  const custom = mounted({ routes: { '/api/history': () => answer }, openEvent: id => seen.push(id) });
  custom.api.open(); custom.type('flood'); custom.flush(); await tick();
  custom.click(custom.options()[0]);
  assert.deepEqual(seen, [ID(8)]); assert.deepEqual(custom.opened, []);
});

test('during a replay the history is not searched: the replay note says why, the static results stay', () => {
  const r = mounted({ replay: true, routes: { '/api/history': () => ({ items: [] }) } });
  r.api.open();
  r.type('open');
  r.flush();
  assert.equal(r.requests.length, 0, 'no /api/history request');
  assert.equal(r.timers.length, 0);
  assert.equal(r.note().textContent, locale('en').palette.replayNote);
  assert.ok(r.status().textContent.includes(locale('en').palette.replayNote), 'announced with the count');
  assert.deepEqual(r.labels(), ['Open alerts', 'Open settings', 'Open the signal guide', 'Open records: GDACS']);
  r.type('o');
  assert.equal(r.note().textContent, '', 'no note while no search would run');
  // The default asks the page's replay module.
  const page = realm({ routes: { '/api/history': () => ({ items: [] }) }, extra: { isReplay: undefined } });
  page.window.CrucixReplay = { active: () => true };
  page.mount(); page.api.open(); page.type('open'); page.flush();
  assert.equal(page.requests.length, 0);
});

test('Ctrl+K / Cmd+K at the document opens from anywhere (even another text field) and toggles; other keys are left alone', () => {
  const r = mounted();
  const field = r.add('input', { type: 'text' }); field.focus();
  const plainK = r.key('k', {}, field);
  assert.equal(plainK.defaultPrevented, false); assert.equal(r.api.isOpen(), false);
  const shifted = r.key('k', { ctrlKey: true, shiftKey: true }, field);
  assert.equal(shifted.defaultPrevented, false); assert.equal(r.api.isOpen(), false);
  const open = r.key('k', { ctrlKey: true }, field);
  assert.ok(open.defaultPrevented); assert.equal(r.api.isOpen(), true);
  assert.ok(r.doc.activeElement === r.input());
  const again = r.key('k', { ctrlKey: true });
  assert.ok(again.defaultPrevented, 'from its own input it closes the palette');
  assert.equal(r.api.isOpen(), false);
  assert.ok(r.doc.activeElement === field, 'back in the field');
  const meta = r.key('K', { metaKey: true }, r.doc.body);
  assert.ok(meta.defaultPrevented); assert.equal(r.api.isOpen(), true);
  r.api.close();
  const held = r.key('k', { ctrlKey: true, repeat: true }, r.doc.body);
  assert.equal(r.api.isOpen(), false, 'a held key does not toggle');
  assert.equal(held.defaultPrevented, false);
});

test('macOS: Cmd+K is the shortcut; Ctrl+K inside another text field stays the system delete-to-end-of-line', () => {
  const r = mounted({ platform: 'MacIntel' });
  const field = r.add('textarea'); field.focus();
  const ctrl = r.key('k', { ctrlKey: true }, field);
  assert.equal(ctrl.defaultPrevented, false); assert.equal(r.api.isOpen(), false);
  const cmd = r.key('k', { metaKey: true }, field);
  assert.ok(cmd.defaultPrevented); assert.equal(r.api.isOpen(), true);
  r.api.close();
  const page = r.key('k', { ctrlKey: true }, r.doc.body);
  assert.ok(page.defaultPrevented, 'outside a text field Ctrl+K opens on a Mac too');
  assert.match(r.api.button(), /<kbd class="pl-kbd" aria-hidden="true">⌘ K<\/kbd>/);
  assert.match(r.api.button(), /aria-keyshortcuts="Meta\+K"/);
  assert.match(mounted().api.button(), /<kbd class="pl-kbd" aria-hidden="true">Ctrl K<\/kbd>/);
});

test('the open key is ignored (not taken) while another modal holds the keys: event dialog, settings, a modal <dialog>, an inert page', () => {
  const blockers = {
    'the event dialog (intelligence.js #ci-overlay)': r => r.add('div', { id: 'ci-overlay' }),
    'the settings overlay': r => r.add('div', { id: 'settingsOverlay', class: 'settings-overlay show' }),
    'the record browser <dialog>': r => { const node = r.add('dialog', { id: 'record-browser' }); node.showModal(); },
    'the palette made inert by another modal': r => { r.dialog().inert = true; },
  };
  for (const [name, block] of Object.entries(blockers)) {
    const r = mounted();
    block(r);
    const event = r.key('k', { ctrlKey: true }, r.doc.body);
    assert.equal(r.api.isOpen(), false, name);
    assert.equal(event.defaultPrevented, false, name + ': the key goes on to the page');
    assert.equal(r.api.open(), false, name + ': open() refuses too');
  }
  // A closed settings overlay and a closed <dialog> do not block; the glossary (no focus trap) does not either.
  const r = mounted();
  r.add('div', { id: 'settingsOverlay', class: 'settings-overlay', inert: '' });
  r.add('dialog', { id: 'record-browser' });
  r.add('div', { id: 'glossaryOverlay', class: 'glossary-overlay show' });
  assert.ok(r.key('k', { ctrlKey: true }, r.doc.body).defaultPrevented);
  assert.equal(r.api.isOpen(), true);
});

test('the header button: markup, a delegated click (survives the top bar rebuild), empty before mount', () => {
  const r = realm();
  assert.equal(r.api.button(), '', 'nothing before mount');
  r.mount();
  const out = r.api.button();
  assert.match(out, /^<button type="button" class="guide-btn pl-trigger" id="paletteTrigger" data-palette-open aria-haspopup="dialog" aria-keyshortcuts="Control\+K">Commands <kbd class="pl-kbd" aria-hidden="true">Ctrl K<\/kbd><\/button>$/);
  assert.ok(!HANDLER.test(out));
  const bar = r.add('div', { id: 'topbar' });
  bar.innerHTML = out; bar.innerHTML = out;
  r.click(bar.querySelector('kbd'));
  assert.equal(r.api.isOpen(), true, 'a click anywhere on the button opens');
  r.key('Escape');
  assert.ok(r.doc.activeElement === r.part('paletteTrigger'));
  r.click(bar);
  assert.equal(r.api.isOpen(), false, 'other clicks do nothing');
  const hu = mounted({ t: localT('hu') });
  assert.ok(hu.api.button().includes('>Parancsok <kbd'));
});

test('setActions replaces the action list (also while open); junk items are skipped; a throwing provider leaves the others', () => {
  const r = mounted();
  r.api.open();
  const ran = [];
  r.api.setActions([{ id: 'one', group: 'action', label: 'First new', run: () => ran.push('one') }, { id: 'two', label: 'Second new', run() {} }, { id: 'bad', label: '', run() {} }, { id: 'nofn', label: 'No run' }, null]);
  assert.deepEqual(r.labels(), ['First new', 'Second new'], 'redrawn at once; an item without a group from the action list is an action');
  r.key('Enter');
  assert.deepEqual(ran, ['one']);
  r.api.setActions(null);
  r.api.open();
  assert.deepEqual(r.labels(), ['Open alerts', 'Open settings', 'Open the signal guide'], 'null goes back to options.actions()');
  const broken = mounted({ extra: { actions: () => { throw new Error('no'); } } });
  broken.api.open();
  assert.deepEqual(broken.labels(), [], 'no actions');
  broken.type('gdacs');
  assert.deepEqual(broken.labels(), ['Open records: GDACS'], 'the sources still work');
  assert.equal(broken.errors.length, 1);
});

test('every palette.js text comes from the palette locale group (same keys, same order), in en, hu and fr', () => {
  const source = read('dashboard/public/palette.js');
  const copy = /const COPY=\{([\s\S]*?)\};/.exec(source)[1];
  const keys = [...copy.matchAll(/(?:^|,)\s*([a-zA-Z]+):'/g)].map(match => match[1]);
  const group = Object.keys(locale('en').palette);
  assert.ok(keys.length >= 15, keys.join());
  for (const key of keys) assert.ok(group.includes(key), 'palette.' + key);
  assert.deepEqual(keys, group.filter(key => keys.includes(key)), 'the same order as the locale');
  for (const lang of ['en', 'hu', 'fr']) {
    const r = mounted({ t: localT(lang) });
    r.api.open();
    assert.equal(r.dialog().getAttribute('aria-label'), locale(lang).palette.dialogLabel, lang);
    assert.equal(r.input().getAttribute('placeholder'), locale(lang).palette.placeholder, lang);
  }
});

test('the module is an IIFE without inline handlers or regex lookbehind; it exposes the brief interface', () => {
  for (const file of ['palette-core.js', 'palette.js']) {
    const source = read('dashboard/public/' + file);
    assert.ok(/^\(function\(window(,document)?\)\{/.test(source), file);
    assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(source), file + ': no inline handlers');
    assert.ok(!/\(\?<[=!]/.test(source), file + ': no lookbehind');
  }
  const r = realm();
  assert.deepEqual(Object.keys(r.api).sort(), ['button', 'close', 'isOpen', 'mount', 'open', 'setActions']);
  assert.deepEqual(Object.keys(core()).sort(), ['isOpenKey', 'rank', 'score', 'shouldIgnoreTarget']);
});

test('palette.css: reduced motion, a narrow viewport without sideways scroll and a forced-colours active marker', () => {
  const css = read('dashboard/public/palette.css');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)[\s\S]*\.pl-opt\[aria-selected="true"\][^}]*outline/);
  // The transparent left border of every option would paint as CanvasText in forced colours: Canvas, and Highlight on the active one.
  const forced = css.slice(css.search(/@media\s*\(forced-colors:\s*active\)/));
  assert.match(forced, /\n\s*\.pl-opt\{[^}]*border-left-color:Canvas[;}]/, 'inactive options: no visible bar');
  assert.match(forced, /\.pl-opt\[aria-selected="true"\]\{[^}]*border-left-color:Highlight/, 'the active option: a Highlight bar');
  assert.match(css, /\.pl-dialog\{[^}]*width:min\([^)]*100vw[^)]*\)/, 'the dialog never exceeds the viewport');
  assert.match(css, /\.pl-label\{[^}]*overflow-wrap:anywhere/, 'long labels wrap instead of scrolling sideways');
  assert.match(css, /\.pl-opt\[aria-selected="true"\] \.pl-mark\{[^}]*visibility:visible/, 'the active option has a marker, not only a colour');
});

// ===== the page =====

// A top-level (column 0) page function, up to the next one.
function helper(name, context = {}) {
  const start = Math.max(html.indexOf(`\nfunction ${name}(`), html.indexOf(`\nasync function ${name}(`));
  assert.ok(start > 0, name);
  const end = Math.min(...['\nfunction ', '\nasync function '].map(needle => html.indexOf(needle, start + 1)).filter(index => index > 0));
  return vm.runInNewContext(`${html.slice(start, end)}\n${name}`, context);
}
function pageWindow({ lens = 'all', archive = true, tray = true, panel = true, replay = false } = {}) {
  const calls = [];
  const domains = { DOMAINS: [], DOMAIN_IDS: [] };
  vm.runInNewContext(read('dashboard/public/domains.js'), { window: { set CrucixDomains(value) { Object.assign(domains, value); } } });
  const live = { policies: Object.fromEntries(['GDACS', 'USGS', 'NOAA-SWPC'].map(name => [name, {}])) };
  const window = {
    CrucixDomains: domains, CrucixLiveSources: live,
    CrucixLens: { get: () => lens, set: id => calls.push(['lens', id]) },
    CrucixAlerts: { open: () => calls.push(['alerts']) },
    CrucixHealthMatrix: { open: () => calls.push(['matrix']) },
    CrucixRecordInspector: { open: name => calls.push(['records', name]) },
    CrucixReplay: { open: () => calls.push(['replay']), exit: () => calls.push(['exit']), active: () => replay },
    CrucixChanges: { focus: () => calls.push(['changes']) },
  };
  const document = { getElementById: id => id === 'alertTray' ? (tray ? {} : null) : id === 'changesPanel' ? (panel ? {} : null) : null };
  const context = { window, document, location: { protocol: archive ? 'http:' : 'file:' }, t: localT('en'), isPanelVisible: id => id === 'changes' && panel, openSettings: () => calls.push(['settings']), openGlossary: () => calls.push(['glossary']), lensMatchesSource: name => lens === 'all' || window.CrucixDomains.domainOfSource(name) === lens };
  return { context, calls, window };
}

test('page: paletteActions lists the dashboard actions, then all + 8 lenses, each running the existing entry point', () => {
  const { context, calls } = pageWindow({ lens: 'hazards' });
  const list = helper('paletteActions', context)();
  assert.deepEqual(plain(list.map(item => item.id)), ['alerts', 'settings', 'glossary', 'matrix', 'browser', 'replay', 'changes', 'lens:all', 'lens:security', 'lens:hazards', 'lens:space', 'lens:cyber', 'lens:economy', 'lens:supply', 'lens:sanctions', 'lens:health']);
  assert.ok(list.every(item => item.group === 'action' && typeof item.run === 'function' && typeof item.label === 'string' && item.label));
  const en = locale('en').palette;
  assert.deepEqual(plain(list.slice(0, 7).map(item => item.label)), [en.openAlerts, en.openSettings, en.openGlossary, en.openMatrix, en.openBrowser, en.startReplay, en.openChanges]);
  const hazards = list.find(item => item.id === 'lens:hazards');
  assert.equal(hazards.label, en.lens.replace('{name}', locale('en').lenses.hazards));
  assert.equal(hazards.hint, en.lensActive, 'the current lens says so');
  assert.equal(list.find(item => item.id === 'lens:space').hint, en.lensHint);
  assert.deepEqual(plain(hazards.keywords), ['hazards', locale('en').lenses.hazards], 'the domain id (any language) and the domain name (ranks the lens with the sources of that domain) are keywords');
  const core = (() => { const window = {}; vm.runInNewContext(read('dashboard/public/palette-core.js'), { window }); return window.CrucixPaletteCore; })();
  const hu = pageWindow({ lens: 'hazards' }); hu.context.t = localT('hu');
  const items = [...helper('paletteActions', hu.context)(), ...helper('paletteSources', hu.context)()];
  assert.equal(core.rank(items, 'termeszeti')[0].id, 'lens:hazards', 'hu: the lens comes before the sources of its domain');
  assert.equal(core.rank(items, 'hazard')[0].id, 'lens:hazards');
  for (const item of list) item.run();
  assert.deepEqual(calls, [['alerts'], ['settings'], ['glossary'], ['matrix'], ['records', 'all'], ['replay'], ['changes'], ...['all', 'security', 'hazards', 'space', 'cyber', 'economy', 'supply', 'sanctions', 'health'].map(id => ['lens', id])]);
});

test('page: paletteActions leaves out what the page cannot do and offers "Back to live" during a replay', () => {
  const ids = options => { const { context } = pageWindow(options); return helper('paletteActions', context)().map(item => item.id); };
  assert.ok(!ids({ panel: false }).includes('changes'), 'the changes panel is not in the layout');
  assert.ok(!ids({ tray: false }).includes('alerts'), 'no alert tray');
  const file = ids({ archive: false });
  assert.ok(!file.includes('matrix') && !file.includes('replay'), 'no archive on file pages');
  const { context, calls } = pageWindow({ replay: true });
  const exit = helper('paletteActions', context)().find(item => item.id === 'replay');
  assert.equal(exit.label, locale('en').palette.exitReplay);
  exit.run();
  assert.deepEqual(calls, [['exit']]);
});

test('page: the glossary and settings actions are found by the words of their header buttons ("signals mean", "jelentése", "réglages")', () => {
  const core = (() => { const window = {}; vm.runInNewContext(read('dashboard/public/palette-core.js'), { window }); return window.CrucixPaletteCore; })();
  for (const [lang, query, id] of [['en', 'signals mean', 'glossary'], ['hu', 'jelentése', 'glossary'], ['fr', 'signification', 'glossary'], ['fr', 'réglages', 'settings'], ['en', 'settings', 'settings']]) {
    const { context } = pageWindow(), table = locale(lang), base = localT(lang);
    context.t = (key, fallback) => (key === 'dashboard.guideBtn' ? table.dashboard.guideBtn : key === 'dashboard.settings' ? table.dashboard.settings : base(key, fallback));
    const list = helper('paletteActions', context)();
    assert.deepEqual(plain(list.find(item => item.id === 'glossary').keywords), [table.dashboard.guideBtn], lang + ': the glossary button text');
    assert.deepEqual(plain(list.find(item => item.id === 'settings').keywords), [table.dashboard.settings], lang + ': the settings button text');
    assert.equal(core.rank(list, query)[0]?.id, id, `${lang}: "${query}" finds ${id}`);
  }
});

test('page: paletteSources has one item per source of the domain registry: live ones open their records, the others the health matrix', () => {
  const { context, calls, window } = pageWindow({ lens: 'economy' });
  const list = helper('paletteSources', context)();
  const names = window.CrucixDomains.DOMAINS.flatMap(domain => domain.sources);
  assert.equal(list.length, names.length);
  assert.ok(list.every(item => item.group === 'source'));
  const en = locale('en').palette;
  const gdacs = list.find(item => item.id === 'records:GDACS'), gdelt = list.find(item => item.id === 'health:GDELT');
  assert.equal(gdacs.label, en.openRecords.replace('{source}', 'GDACS'));
  assert.equal(gdacs.hint, locale('en').lenses.hazards);
  assert.deepEqual(plain(gdacs.keywords), ['GDACS', locale('en').lenses.hazards, 'hazards']);
  assert.equal(gdelt.label, en.showHealth.replace('{source}', 'GDELT'));
  gdacs.run(); gdelt.run();
  assert.deepEqual(calls, [['records', 'GDACS'], ['lens', 'security'], ['matrix']], 'a source the lens hides switches to its domain first, then the matrix opens');
  const fred = list.find(item => item.id === 'health:FRED'); fred.run();
  assert.deepEqual(calls.slice(3), [['matrix']], 'a source of the current lens just opens the matrix');
  const offline = pageWindow({ archive: false });
  const files = helper('paletteSources', offline.context)();
  assert.deepEqual(plain(files.map(item => item.id)), ['records:USGS', 'records:GDACS', 'records:NOAA-SWPC'], 'without the archive only the live sources remain');
});

test('jarvis.html: scripts and styles after the modules they call, one mount with the page hooks, the button in the top bar', () => {
  const at = needle => { const i = html.indexOf(needle); assert.ok(i > 0, needle); return i; };
  assert.ok(at('<script src="changes.js">') < at('<script src="palette-core.js">') && at('<script src="palette-core.js">') < at('<script src="palette.js">'));
  for (const before of ['record-inspector.js', 'alerts.js', 'replay.js', 'health-matrix.js', 'lens.js', 'domains.js', 'intelligence.js']) assert.ok(at(`<script src="${before}">`) < at('<script src="palette.js">'), before);
  assert.ok(at('href="changes.css"') < at('href="palette.css"'));
  assert.equal(count(html, /<script src="palette\.js">/g), 1); assert.equal(count(html, /href="palette\.css"/g), 1);
  assert.equal(count(html, /CrucixPalette\?\.mount\(/g), 1);
  const mount = html.slice(html.indexOf('CrucixPalette?.mount('), html.indexOf('CrucixPalette?.mount(') + 300);
  // No history search on file pages or in the offline shell (like the archive hooks of the replay, the matrix and the changes).
  for (const hook of ['fetchJson:archiveApi?fetchJsonNoStore:undefined', 't,', 'esc,', 'actions:paletteActions', 'sources:paletteSources']) assert.ok(mount.includes(hook), hook);
  assert.ok(html.indexOf('const archiveApi=') < html.indexOf('CrucixPalette?.mount('));
  assert.ok(html.indexOf('CrucixPalette?.mount(') < html.indexOf('\n  init();'), 'mounted before the first top bar render');
  const topbar = html.slice(html.indexOf('function renderTopbar(){'), html.indexOf('\nfunction ', html.indexOf('function renderTopbar(){')));
  assert.match(topbar, /\$\{window\.CrucixPalette\?\.button\?\.\(\)\|\|''\}\s*<button class="guide-btn" id="settingsTrigger"/, 'the first of the guide buttons');
  assert.equal(html.match(/^(let|const) D = .*;\s*$/gm).length, 1, 'the injected D line stays one line');
});

test('jarvis.html: fetchJsonNoStore passes an abort signal along with its timeout', async () => {
  const seen = [];
  const make = any => helper('fetchJsonNoStore', { fetch: async (url, init) => { seen.push(init.signal); return { ok: true, json: async () => ({ url }) }; }, AbortSignal: { timeout: ms => ({ timeout: ms }), ...(any ? { any: list => ({ any: list }) } : {}) } });
  const own = { mine: true };
  assert.deepEqual(await make(true)('/x', { signal: own }), { url: '/x' });
  assert.deepEqual(plain(seen[0]), { any: [{ mine: true }, { timeout: 10000 }] }, 'both the caller and the timeout can end it');
  await make(false)('/x', { signal: own });
  assert.deepEqual(plain(seen[1]), { timeout: 10000 }, 'without AbortSignal.any the timeout stays (the request token still drops a late answer)');
  await make(true)('/x');
  assert.deepEqual(plain(seen[2]), { timeout: 10000 }, 'callers without a signal are unchanged');
});

test('the shell caches palette-core.js, palette.js and palette.css, once each; the cache name carries the release version', () => {
  const sw = read('dashboard/public/sw.js'), base = JSON.parse(sw.match(/const BASE = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
  for (const path of ['/palette-core.js', '/palette.js', '/palette.css']) assert.equal(base.filter(item => item === path).length, 1, path);
  assert.match(sw, /const CACHE = 'crucix-shell-v2\.13\.0';/);
});
