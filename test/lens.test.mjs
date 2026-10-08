import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { POLICIES } from '../apis/utils/freshness.mjs';
import { DOMAINS, DOMAIN_IDS, domainOfSource } from '../lib/domains.mjs';

// Domain lenses (lens-core.js, lens.js) and the grouped live panel (live-sources.js), in vm realms like the other dashboard modules.
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const LENS_FILES = ['domains.js', 'lens-core.js', 'lens.js'];
const PANEL_FILES = ['record-core.js', 'domains.js', 'lens-core.js', 'lens.js', 'live-sources.js'];
const memory = (entries = {}) => { const map = new Map(Object.entries(entries)); return { map, getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => { map.set(key, String(value)); }, removeItem: key => { map.delete(key); } }; };
const failing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };
// storage: an object (window.localStorage), 'throw' (the getter itself throws, as in a sandboxed frame) or undefined (no storage at all).
function realm({ files = LENS_FILES, storage, document } = {}) {
  const window = {}, errors = [];
  if (storage === 'throw') Object.defineProperty(window, 'localStorage', { get() { throw new Error('SecurityError'); } });
  else if (storage) window.localStorage = storage;
  if (document) window.document = document;
  const context = vm.createContext({ window, Date, URL, Object, Array, Number, JSON, Set, Map, String, console: { error: (...args) => errors.push(args) } });
  for (const file of files) vm.runInContext(read('dashboard/public/' + file), context);
  return { window, errors };
}
const t = (_key, fallback) => fallback;

test('normalize keeps a known domain id and turns anything else into all', () => {
  const { CrucixLensCore: core } = realm().window;
  for (const id of DOMAIN_IDS) assert.equal(core.normalize(id), id);
  assert.equal(core.normalize('all'), 'all');
  for (const value of [null, undefined, '', 'weather', 'HAZARDS', ' hazards', '__proto__', 'constructor', 'toString', '<img src=x onerror=alert(1)>', 7, {}, [], ['hazards'], true])
    assert.equal(core.normalize(value), 'all', String(value));
});

test('matchesSource: all matches every source, a domain lens only its own sources; unknown sources only under all', () => {
  const { CrucixLensCore: core } = realm().window;
  for (const domain of DOMAINS) for (const source of domain.sources) {
    assert.equal(core.matchesSource('all', source), true, source);
    for (const lens of DOMAIN_IDS) assert.equal(core.matchesSource(lens, source), lens === domain.id, `${lens} / ${source}`);
  }
  for (const name of ['Reuters', '', null, undefined, '__proto__', 7]) {
    assert.equal(core.matchesSource('all', name), true, String(name));
    for (const lens of DOMAIN_IDS) assert.equal(core.matchesSource(lens, name), false, `${lens} / ${name}`);
  }
  assert.equal(core.matchesSource('bogus', 'GDELT'), true, 'an unknown lens is all');
});

test('matchesEvent reads event records and live rows; domain-less items only match all', () => {
  const { CrucixLensCore: core } = realm().window;
  const cases = [
    [{ id: 'e1', kind: 'earthquake', source: { name: 'USGS' } }, 'hazards'],
    [{ sourceName: 'ECB' }, 'economy'],
    [{ source: 'GDACS', title: 'live row with a bare source name' }, 'hazards'],
    [{ source: 'FIRST-EPSS' }, 'cyber'],
    [{ source: { name: 'OpenSanctions-Index' } }, 'sanctions'],
  ];
  for (const [event, domain] of cases) for (const lens of ['all', ...DOMAIN_IDS]) assert.equal(core.matchesEvent(lens, event), lens === 'all' || lens === domain, `${lens} / ${JSON.stringify(event)}`);
  for (const event of [{ kind: 'news', source: { name: 'Reuters' } }, { kind: 'osint', source: 'Telegram channel' }, { kind: 'signal' }, null, undefined, 'GDELT', 7]) {
    assert.equal(core.matchesEvent('all', event), true, JSON.stringify(event) ?? 'undefined');
    for (const lens of DOMAIN_IDS) assert.equal(core.matchesEvent(lens, event), false, `${lens} / ${JSON.stringify(event)}`);
  }
});

test('groupSources orders groups by the domain order, keeps row order, finds the worst level and the groups needing attention', () => {
  const { window } = realm(), core = window.CrucixLensCore;
  const row = (source, state = 'ok', levels = {}) => ({ source, state, levels });
  const rows = [row('Meteoalarm'), row('ECB', 'ok', { info: 3 }), row('GDACS', 'ok', { high: 1, info: 2 }), row('OONI', 'stale'), row('ADSB-Military', 'ok', { watch: 2 }),
    row('FIRST-EPSS', 'ok', { critical: 1 }), row('ENTSOG-HU'), row('Unknown-Source', 'ok', { critical: 5 }), null, 'x', row('Federal-Register', 'error')];
  const groups = plain(core.groupSources(rows, window.CrucixDomains.domainOfSource));
  assert.deepEqual(groups.map(group => [group.domain, group.rows.map(item => item.source), group.worst, group.attention]), [
    ['security', ['ADSB-Military'], 'watch', false],
    ['hazards', ['Meteoalarm', 'GDACS'], 'high', true],
    ['cyber', ['OONI', 'FIRST-EPSS'], 'critical', true],
    ['economy', ['ECB'], 'info', false],
    ['supply', ['ENTSOG-HU'], null, false],
    ['sanctions', ['Federal-Register'], null, true],
    [null, ['Unknown-Source'], 'critical', true],
  ]);
  assert.deepEqual(plain(core.groupSources('x', domainOfSource)), []);
  assert.deepEqual(plain(core.groupSources([row('GDACS')], () => { throw new Error('boom'); })).map(group => group.domain), [null], 'a throwing domainOf puts the row in the unmapped group');
  assert.deepEqual(plain(core.groupSources([row('GDACS')], () => '__proto__')).map(group => group.domain), [null]);
});

test('CrucixLens works in memory when localStorage throws or is absent', () => {
  for (const storage of ['throw', failing, undefined]) {
    const { window, errors } = realm({ storage }), lens = window.CrucixLens, seen = [];
    assert.equal(lens.get(), 'all');
    lens.onChange(value => seen.push(value));
    assert.doesNotThrow(() => lens.set('hazards'));
    assert.equal(lens.get(), 'hazards'); assert.deepEqual(seen, ['hazards']);
    lens.set('hazards'); assert.deepEqual(seen, ['hazards'], 'no change, no notification');
    lens.set('<b>bogus</b>'); assert.equal(lens.get(), 'all'); assert.deepEqual(seen, ['hazards', 'all']);
    assert.equal(lens.expanded('economy', false), false);
    assert.doesNotThrow(() => lens.toggle('economy'));
    assert.equal(lens.expanded('economy', false), true, 'the expansion lives in memory');
    assert.deepEqual(errors, [], String(storage));
  }
});

test('CrucixLens restores a persisted lens and falls back to all for an unknown stored value', () => {
  const storage = memory();
  realm({ storage }).window.CrucixLens.set('cyber');
  assert.equal(storage.map.get('crucix.lens'), 'cyber');
  assert.equal(realm({ storage }).window.CrucixLens.get(), 'cyber', 'a new page restores the lens');
  for (const stored of ['weather', '__proto__', '', '{"x":1}', 'ALL']) assert.equal(realm({ storage: memory({ 'crucix.lens': stored }) }).window.CrucixLens.get(), 'all', stored);
  const later = realm({ storage: memory({ 'crucix.lens': 'hazards' }) }).window.CrucixLens;
  later.set('all'); assert.equal(later.get(), 'all');
});

test('group expansion: attention groups start open, a choice persists while the attention state it was made under holds', () => {
  const storage = memory(), lens = realm({ storage }).window.CrucixLens;
  assert.equal(lens.expanded('hazards', true), true, 'a group needing attention starts open');
  assert.equal(lens.expanded('economy', false), false, 'a calm group starts closed');
  lens.toggle('economy'); lens.toggle('hazards');
  assert.equal(lens.expanded('economy', false), true); assert.equal(lens.expanded('hazards', true), false, 'an attention group can be closed');
  assert.deepEqual(JSON.parse(storage.map.get('crucix.liveGroups')), { hazards: { open: false, attention: true }, economy: { open: true, attention: false } });
  const again = realm({ storage }).window.CrucixLens;
  assert.equal(again.expanded('economy', false), true, 'restored on a new page'); assert.equal(again.expanded('hazards', true), false);
  assert.equal(again.expanded('economy', true), true, 'a group that now needs attention is open');
  assert.equal(again.expanded('hazards', false), false, 'the old choice no longer applies: the calm default');
  assert.equal(again.expanded('hazards', true), true, 'and it does not come back');
  assert.deepEqual(JSON.parse(storage.map.get('crucix.liveGroups')), { economy: { open: true, attention: false } }, 'the collapsed choice is dropped, the opened one is kept');
  for (const stored of ['nope', '[1]', '{"__proto__":{"open":true,"attention":false},"hazards":{"open":"yes","attention":false},"bogus":{"open":true,"attention":false}}']) {
    const fresh = realm({ storage: memory({ 'crucix.liveGroups': stored }) }).window.CrucixLens;
    assert.equal(fresh.expanded('hazards', false), false, stored); assert.equal(fresh.expanded('bogus', true), true, stored);
  }
  assert.doesNotThrow(() => lens.toggle('__proto__')); assert.doesNotThrow(() => lens.toggle(null));
});

test('group expansion: a group the user opened stays open when its attention flips true -> false; a collapsed one is dropped when it starts needing attention', () => {
  const storage = memory(), lens = realm({ storage }).window.CrucixLens;
  // A calm group opened by hand, then it needs attention, then it is calm again: open all the way.
  assert.equal(lens.expanded('economy', false), false);
  assert.equal(lens.toggle('economy'), true);
  assert.equal(lens.expanded('economy', true), true);
  assert.equal(lens.expanded('economy', false), true, 'still open after the attention went away');
  assert.equal(realm({ storage }).window.CrucixLens.expanded('economy', false), true, 'and on a new page');
  // An attention group opened by hand (closed, then opened again) stays open when it calms down.
  assert.equal(lens.expanded('cyber', true), true);
  lens.toggle('cyber'); assert.equal(lens.expanded('cyber', true), false);
  lens.toggle('cyber'); assert.equal(lens.expanded('cyber', true), true);
  assert.equal(lens.expanded('cyber', false), true, 'opened by hand: open while calm');
  // A collapsed calm group that starts needing attention opens (the choice is dropped) and is calm-closed afterwards.
  lens.expanded('supply', false); lens.toggle('supply'); lens.toggle('supply');
  assert.equal(lens.expanded('supply', false), false);
  assert.equal(lens.expanded('supply', true), true, 'attention opens a collapsed group');
  assert.equal(lens.expanded('supply', false), false, 'the dropped choice does not come back: the calm default');
  assert.ok(!Object.hasOwn(JSON.parse(storage.map.get('crucix.liveGroups')), 'supply'));
  // The user closes an opened group: closed until its attention state changes.
  lens.toggle('economy'); assert.equal(lens.expanded('economy', false), false);
});

// Nineteen current sources, one record each (GDACS high, so hazards needs attention), at a fixed time.
const now = Date.parse('2026-10-03T12:00:00Z'), at = minutes => new Date(now + minutes * 60000).toISOString();
function liveRow(name, extra = {}) {
  const row = name === 'MET-Norway' ? { kind: 'forecast', forecastAt: at(30), validUntil: at(120) } : { kind: 'signal' };
  return { source: name, status: 'ok', observedAt: at(-10), observations: [{ providerId: name + '-1', title: name + ' record', observedAt: at(-10), ...row, ...extra }] };
}
const nineteen = (overrides = {}) => Object.keys(POLICIES).map(name => overrides[name] ? { ...liveRow(name), ...overrides[name] } : liveRow(name));
const sections = html => html.split('<section class="live-group"').slice(1);
const groupOf = section => section.match(/data-live-domain="([^"]+)"/)?.[1];
const cardsIn = html => [...html.matchAll(/data-live-source="([^"]+)"/g)].map(match => match[1]);

// The number of live sources follows the registry: a new source needs no edit here.
const N = Object.keys(POLICIES).length;
test('the live panel groups every card by domain: every card reachable, its attributes and records button unchanged', () => {
  const { window } = realm({ files: PANEL_FILES, storage: memory() }), api = window.CrucixLiveSources;
  const sources = nineteen({ GDACS: { observations: [{ ...liveRow('GDACS').observations[0], severity: 'Orange' }] } });
  const html = api.renderPanel(sources, t, [], now), groups = sections(html);
  const expected = DOMAIN_IDS.filter(id => Object.keys(POLICIES).some(name => domainOfSource(name) === id));
  assert.ok(groups.length <= 8 && groups.length === expected.length, `${groups.length} groups`);
  assert.deepEqual(groups.map(groupOf), expected, 'groups in the domain order, only those with sources');
  assert.deepEqual(cardsIn(html).sort(), Object.keys(POLICIES).sort(), 'all cards are in the DOM');
  assert.equal(html.match(/<article class="live-source" data-live-source="[^"]+" data-live-state="ok">/g).length, N);
  assert.equal(html.match(/<button type="button" class="live-open" data-open-records="[^"]+" aria-controls="record-inspector">/g).length, N);
  for (const section of groups) {
    const domain = groupOf(section), head = section.match(/<button type="button" class="live-group-head"[^>]*>/)?.[0] ?? '';
    assert.match(head, new RegExp(`data-live-group="${domain}" aria-expanded="(true|false)" aria-controls="live-group-${domain}"`), domain);
    const open = head.includes('aria-expanded="true"');
    assert.ok(section.includes(`<div class="live-group-body" id="live-group-${domain}"${open ? '' : ' hidden'}>`), `${domain} body follows aria-expanded`);
    assert.equal(open, domain === 'hazards', `${domain}: only the attention group starts open`);
    for (const name of cardsIn(section)) assert.equal(domainOfSource(name), domain, name);
    const count = cardsIn(section).length;
    assert.ok(section.includes(`${count} ${count === 1 ? 'source' : 'sources'}`), `${domain}: source count`);
  }
  const hazards = groups.find(section => groupOf(section) === 'hazards');
  assert.ok(hazards.includes('data-attention="true"')); assert.match(hazards, /<span class="lg-worst sev-high"><i aria-hidden="true">▲<\/i> High<\/span>/, 'worst level: glyph and text');
  const hazardRecords = Object.keys(POLICIES).filter(name => domainOfSource(name) === 'hazards').length; // one fixture row per source
  assert.ok(hazards.includes(`${hazardRecords} records`), 'hazards record count'); assert.ok(hazards.includes('Needs attention'));
  assert.match(html, new RegExp(`<span class="badge">${N}\/${N}<\/span>`), 'the badge still counts every source');
});

test('the group expansion survives a re-render and the 30 s outerHTML refresh (the state lives in CrucixLens)', () => {
  const storage = memory(), { window } = realm({ files: PANEL_FILES, storage }), api = window.CrucixLiveSources, sources = nineteen();
  const head = (html, domain) => html.match(new RegExp(`data-live-group="${domain}" aria-expanded="(true|false)"`))?.[1];
  const first = api.renderPanel(sources, t, [], now);
  assert.equal(head(first, 'economy'), 'false');
  window.CrucixLens.toggle('economy');
  const second = api.renderPanel(sources, t, [], now), third = api.renderPanel(sources, t, [], now);
  assert.equal(head(second, 'economy'), 'true'); assert.equal(second, third, 'the same state renders the same panel');
  assert.ok(second.includes('<div class="live-group-body" id="live-group-economy">'));
  const reloaded = realm({ files: PANEL_FILES, storage }).window.CrucixLiveSources.renderPanel(sources, t, [], now);
  assert.equal(head(reloaded, 'economy'), 'true', 'and a reload');
});

test('attention: a non-ok source opens its group and is named in a chip; a critical record opens its group', () => {
  const { window } = realm({ files: PANEL_FILES, storage: memory() }), api = window.CrucixLiveSources;
  const sources = nineteen({ OONI: { status: 'error' }, 'IMF-PortWatch': { observedAt: '2020-01-01T00:00:00Z' }, ECB: { observations: [{ ...liveRow('ECB').observations[0], severity: 'Red' }] } });
  const html = api.renderPanel(sources, t, [], now), byDomain = Object.fromEntries(sections(html).map(section => [groupOf(section), section]));
  for (const [domain, chip] of [['cyber', 'OONI: Unavailable'], ['supply', 'IMF-PortWatch: Expired']]) {
    assert.match(byDomain[domain], /aria-expanded="true"/, domain); assert.ok(byDomain[domain].includes(chip), chip);
  }
  assert.match(byDomain.economy, /aria-expanded="true"/); assert.match(byDomain.economy, /lg-worst sev-critical"><i aria-hidden="true">◆<\/i> Critical/);
  assert.match(byDomain.space, /aria-expanded="false"/); assert.ok(!byDomain.space.includes('Needs attention'));
  const many = nineteen(Object.fromEntries(['EMSC', 'GDACS', 'Copernicus-EMS', 'NASA-EONET', 'Meteoalarm'].map(name => [name, { status: 'error' }])));
  const hazards = sections(api.renderPanel(many, t, [], now)).find(section => groupOf(section) === 'hazards');
  assert.equal(hazards.match(/class="lg-chip lg-(?:stale|error)"/g).length, 3, 'three source chips'); assert.ok(hazards.includes('+2 more'), 'then a count of the rest');
});

test('group headers escape every translated and source string', () => {
  const { window } = realm({ files: PANEL_FILES, storage: memory() }), api = window.CrucixLiveSources;
  const hostile = (key, fallback) => key.startsWith('lenses.') || key.startsWith('inspector.level.') ? '<img src=x onerror="alert(1)">{count}' : fallback;
  const html = api.renderPanel(nineteen({ GDACS: { status: 'error' } }), hostile, [], now);
  assert.ok(!html.includes('<img'), 'no markup from a translation'); assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
});

test('a hostile source name is escaped in the attention chip and in the card attributes', () => {
  const { window } = realm({ files: PANEL_FILES, storage: memory() }), api = window.CrucixLiveSources, domains = window.CrucixDomains;
  // Provider names are whitelisted by the policies and the domain table; the hostile one is put into both, as a future adapter's name could be.
  const HOSTILE = `<img src=x onerror="alert(1)"> ' &`, ESCAPED = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &#39; &amp;';
  api.policies[HOSTILE] = { maxAgeMs: 3600000 };
  window.CrucixDomains = { ...domains, domainOfSource: name => (name === HOSTILE ? 'hazards' : domains.domainOfSource(name)) };
  const html = api.renderPanel([liveRow('GDACS'), { ...liveRow(HOSTILE), status: 'error' }, { ...liveRow('EMSC'), status: 'error' }], t, [], now);
  const hazards = sections(html).find(section => groupOf(section) === 'hazards');
  assert.ok(hazards, 'the hostile source is grouped');
  assert.ok(hazards.includes(`<span class="lg-chip lg-error" title="${ESCAPED}: Unavailable">${ESCAPED}: Unavailable</span>`), 'the chip names it, escaped (text and title)');
  assert.ok(hazards.includes(`data-live-source="${ESCAPED}"`), 'and so does the card attribute');
  assert.ok(hazards.includes('<span class="lg-chip lg-error" title="EMSC: Unavailable">EMSC: Unavailable</span>'), 'the other chip is as before');
  assert.ok(!html.includes('<img'), 'no markup from the name'); assert.ok(!html.includes('onerror="alert(1)"'), 'no raw quote in an attribute');
});

test('a domain lens shows only its own group, open and not collapsible; a lens without live sources says so', () => {
  const storage = memory({ 'crucix.lens': 'hazards', 'crucix.liveGroups': JSON.stringify({ hazards: { open: false, attention: false } }) });
  const { window } = realm({ files: PANEL_FILES, storage }), api = window.CrucixLiveSources;
  const html = api.renderPanel(nineteen(), t, [], now), hazards = Object.keys(POLICIES).filter(name => domainOfSource(name) === 'hazards');
  assert.deepEqual(cardsIn(html), hazards, 'only the hazards cards, in policy order');
  assert.equal(sections(html).length, 1); assert.ok(!html.includes('data-live-group='), 'no collapse button under a lens'); assert.ok(!html.includes(' hidden>'), 'the group is open');
  assert.equal(html.match(/class="live-open"/g).length, hazards.length);
  window.CrucixLens.set('health');
  const empty = api.renderPanel(nineteen().filter(row => domainOfSource(row.source || row.name) !== 'health'), t, [], now);
  assert.deepEqual(cardsIn(empty), []); assert.ok(empty.includes('No live source belongs to this domain'));
  window.CrucixLens.set('all');
  assert.equal(cardsIn(api.renderPanel(nineteen(), t, [], now)).length, N);
});

test('the live panel badge counts the cards it shows: current / shown under a domain lens, like the source-health badge', () => {
  const storage = memory(), { window } = realm({ files: PANEL_FILES, storage }), api = window.CrucixLiveSources;
  const sources = nineteen({ GDACS: { status: 'error' }, ECB: { status: 'error' }, 'IMF-PortWatch': { observedAt: '2020-01-01T00:00:00Z' } });
  const badge = html => html.match(/<span class="badge">([^<]*)<\/span>/)[1];
  assert.equal(badge(api.renderPanel(sources, t, [], now)), `${N - 3}/${N}`, 'all: every card');
  for (const lens of DOMAIN_IDS) {
    window.CrucixLens.set(lens);
    const html = api.renderPanel(sources, t, [], now), cards = Object.keys(POLICIES).filter(name => domainOfSource(name) === lens);
    const ok = cards.filter(name => !['GDACS', 'ECB', 'IMF-PortWatch'].includes(name)).length;
    assert.equal(badge(html), `${ok}/${cards.length}`, lens);
    assert.equal(cardsIn(html).length, cards.length, lens + ': the badge counts the cards on screen');
  }
  assert.equal(badge((window.CrucixLens.set('all'), api.renderPanel(sources, t, [], now))), `${N - 3}/${N}`);
  const flat = realm({ files: ['record-core.js', 'live-sources.js'] }).window.CrucixLiveSources;
  assert.equal(badge(flat.renderPanel(sources, t, [], now)), `${N - 3}/${N}`, 'without the lens modules every card counts');
});

test('without domains.js or lens-core.js the panel keeps the flat card list', () => {
  for (const files of [['record-core.js', 'live-sources.js'], ['record-core.js', 'domains.js', 'live-sources.js']]) {
    const html = realm({ files }).window.CrucixLiveSources.renderPanel(nineteen(), t, [], now);
    assert.equal(cardsIn(html).length, N); assert.ok(!html.includes('live-group'), files.join());
    assert.deepEqual(cardsIn(html), Object.keys(POLICIES), 'policy order');
  }
});

// A minimal DOM for mount(): the root records its markup, buttons are stubs parsed from it; the document records listeners.
function fakeDocument() {
  const listeners = {}, nodes = {};
  const button = attrs => ({ attrs: { ...attrs }, focused: false, tagName: 'BUTTON', getAttribute(name) { return this.attrs[name] ?? null; }, setAttribute(name, value) { this.attrs[name] = String(value); }, focus() { this.focused = true; } });
  const root = { html: '', status: null, buttons: [], handlers: {}, contains: () => false,
    set innerHTML(value) { this.html = value; this.buttons = [...value.matchAll(/data-lens="([^"]+)" aria-pressed="(true|false)"/g)].map(m => button({ 'data-lens': m[1], 'aria-pressed': m[2] })); this.status = { textContent: '' }; },
    get innerHTML() { return this.html; },
    querySelectorAll(selector) { return selector === '[data-lens]' ? this.buttons : []; },
    querySelector(selector) { return selector === '.lens-status' ? this.status : null; },
    addEventListener(type, fn) { this.handlers[type] = fn; } };
  const document = { activeElement: null, addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, getElementById: id => nodes[id] ?? null };
  return { document, root, listeners, nodes, button };
}

test('mount draws the lens bar (role=group, aria-label, aria-pressed), a click sets the lens and the status announces it', () => {
  const dom = fakeDocument(), { window } = realm({ storage: memory(), document: dom.document }), lens = window.CrucixLens;
  const labels = { 'lenses.label': 'Témalencse', 'lenses.hazards': 'Természeti <veszélyek>', 'lenses.status': 'Témalencse: {name}' };
  lens.mount(dom.root, { t: (key, fallback) => labels[key] ?? fallback });
  assert.match(dom.root.html, /<div class="lens-bar" role="group" aria-label="Témalencse">/);
  assert.deepEqual(dom.root.buttons.map(node => [node.attrs['data-lens'], node.attrs['aria-pressed']]), [['all', 'true'], ...DOMAIN_IDS.map(id => [id, 'false'])]);
  assert.ok(dom.root.html.includes('Természeti &lt;veszélyek&gt;'), 'labels are escaped'); assert.ok(dom.root.html.includes('role="status"'));
  assert.equal(dom.root.status.textContent, '', 'nothing is announced on load');
  const target = name => ({ closest: selector => selector === '[data-lens]' ? dom.root.buttons.find(node => node.attrs['data-lens'] === name) : null });
  dom.root.handlers.click({ target: target('hazards') });
  assert.equal(lens.get(), 'hazards'); assert.equal(dom.root.status.textContent, 'Témalencse: Természeti <veszélyek>', 'plain text, announced politely');
  assert.deepEqual(dom.root.buttons.filter(node => node.attrs['aria-pressed'] === 'true').map(node => node.attrs['data-lens']), ['hazards']);
  assert.doesNotThrow(() => dom.root.handlers.click({ target: {} }));
});

test('a click on a group header toggles it in place: aria-expanded, the body, and the stored state', () => {
  const dom = fakeDocument(), storage = memory(), { window } = realm({ storage, document: dom.document }), lens = window.CrucixLens;
  lens.mount(dom.root, { t });
  const head = dom.button({ 'data-live-group': 'economy', 'aria-expanded': 'false', 'aria-controls': 'live-group-economy' }), body = { hidden: true };
  dom.nodes['live-group-economy'] = body;
  const click = node => dom.listeners.click.forEach(fn => fn({ target: { closest: selector => selector === 'button[data-live-group]' ? node : null } }));
  assert.equal(lens.expanded('economy', false), false);
  click(head);
  assert.equal(head.attrs['aria-expanded'], 'true'); assert.equal(body.hidden, false); assert.equal(lens.expanded('economy'), true);
  click(head);
  assert.equal(head.attrs['aria-expanded'], 'false'); assert.equal(body.hidden, true);
  assert.doesNotThrow(() => click(null));
  assert.doesNotThrow(() => lens.mount(null), 'a missing root still leaves the group headers working');
});

// jarvis.html helpers, sliced like test/dashboard-security.test.mjs does.
const html = read('dashboard/public/jarvis.html');
function helper(name, context = {}) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start > 0, name);
  const end = html.indexOf('\nfunction ', start + 1);
  return vm.runInNewContext(`${html.slice(start, end)}\n${name}`, context);
}
const lensWindow = lens => { const { window } = realm(); window.CrucixLens = { get: () => lens }; return window; };

test('the maps draw only the located live rows of the active lens', () => {
  const rows = [{ source: 'GDACS', title: 'flood', lat: 1, lon: 2 }, { source: 'IMF-PortWatch', title: 'port', lat: 3, lon: 4 }, { source: 'EMSC', title: 'quake', lat: 5, lon: 6 }];
  const markerRows = window => { const lensMatchesSource = helper('lensMatchesSource', { window }); return helper('lensMarkerRows', { window, lensMatchesSource, D: { liveSources: [], earthquakes: [] }, CrucixLiveSources: { markerRows: () => rows } }); };
  assert.deepEqual(markerRows(lensWindow('hazards'))().map(row => row.title), ['flood', 'quake']);
  assert.deepEqual(markerRows(lensWindow('supply'))().map(row => row.title), ['port']);
  assert.deepEqual(markerRows(lensWindow('all'))().map(row => row.title), ['flood', 'port', 'quake']);
  assert.deepEqual(markerRows({})().map(row => row.title), ['flood', 'port', 'quake'], 'without the lens modules every row is drawn');
  assert.match(html, /CrucixLiveSources\.markerRows\(/, 'the helper reads the live marker rows');
  assert.equal((html.match(/lensMarkerRows\(\)(?!\{)/g) || []).length, 2, 'the globe and the flat map both use it');
  assert.equal((html.match(/CrucixLiveSources\.markerRows\(/g) || []).length, 1, 'no map reads the unfiltered rows');
});

test('the source-health panel shows the rows of the active lens', () => {
  const health = [{ n: 'GDELT' }, { n: 'USGS' }, { n: 'EMSC' }, { n: 'ECB' }, { n: 'Mystery' }];
  const panel = window => helper('buildSourceHealthPanel', { window, D: { health }, t, esc: String, getAge: String, sourceState: () => 'ok', lensMatchesSource: helper('lensMatchesSource', { window }) })();
  const names = out => [...out.matchAll(/<div class="source-row" data-source-state="ok"><div>([^<]+)/g)].map(match => match[1]);
  assert.deepEqual(names(panel(lensWindow('hazards'))), ['USGS', 'EMSC']);
  assert.deepEqual(names(panel(lensWindow('all'))), ['GDELT', 'USGS', 'EMSC', 'ECB', 'Mystery']);
  assert.match(panel(lensWindow('hazards')), /<span class="badge">2\/5<\/span>/, 'the badge says how many of all are shown');
  assert.match(panel(lensWindow('all')), /<span class="badge">5<\/span>/);
  assert.match(panel(lensWindow('all')), /class="g-panel source-health-panel"/, 'the 30 s refresh finds the panel by its class');
  const space = panel(lensWindow('space'));
  assert.deepEqual(names(space), []); assert.ok(space.includes('No source of this domain reported in this sweep.'), 'a lens without rows says so');
  assert.match(space, /<span class="badge">0\/5<\/span>/);
  assert.match(html, /document\.querySelector\('\.source-health-panel'\)/);
});

test('the record browser lists only the sources of the active lens, with unchanged counts', () => {
  const { window } = realm({ files: ['record-core.js', 'domains.js', 'lens-core.js', 'live-sources.js', 'record-inspector.js'] });
  const sources = [{ name: 'GDACS', state: 'ok', count: 3, levels: { high: 3 } }, { name: 'ECB', state: 'ok', count: 7, levels: { info: 7 } }, { name: 'EMSC', state: 'ok', count: 2, levels: {} }];
  const view = lens => ({ source: null, all: true, sources, records: [], total: 0, filters: {}, limit: 25, selected: null, lens });
  const listed = out => [...out.matchAll(/data-ri-source="([^"]+)"[^>]*><span class="rb-name">[^<]*<\/span>(?:<span class="rb-count">(\d+)<\/span>)?/g)].map(match => [match[1], match[2] ?? null]);
  const I = window.CrucixRecordInspector;
  assert.deepEqual(listed(I.renderBrowser(view('hazards'), t, now)), [['all', null], ['GDACS', '3'], ['EMSC', '2']]);
  assert.deepEqual(listed(I.renderBrowser(view('all'), t, now)), [['all', null], ['GDACS', '3'], ['ECB', '7'], ['EMSC', '2']]);
  assert.deepEqual(listed(I.renderBrowser(view(undefined), t, now)).length, 4);
  const current = I.renderBrowser({ ...view('hazards'), all: false, source: { name: 'ECB', source: 'ECB', state: 'ok' } }, t, now);
  assert.ok(current.includes('data-ri-source="ECB" aria-current="true"'), 'the open source stays listed under another lens');
  const inspector = read('dashboard/public/record-inspector.js');
  assert.match(inspector, /lens:window\.CrucixLens\?\.get\?\.\(\)/, 'the controller hands the active lens to the view');
});

test('jarvis.html loads domains.js, lens-core.js and lens.js in order, mounts the bar under the top bar; the shell caches them', () => {
  const at = needle => { const i = html.indexOf(needle); assert.ok(i > 0, needle); return i; };
  assert.ok(at('<script src="domains.js">') < at('<script src="lens-core.js">') && at('<script src="lens-core.js">') < at('<script src="lens.js">'), 'domains -> lens-core -> lens');
  assert.ok(at('<script src="lens.js">') < at('<script src="live-sources.js">'));
  at('<link rel="stylesheet" href="lens.css">');
  assert.ok(at('<div class="topbar" id="topbar"></div>') < at('<div class="lens-host" id="lensBar"></div>') && at('<div class="lens-host" id="lensBar"></div>') < at('<div class="grid">'));
  assert.match(html, /window\.CrucixLens\?\.mount\(document\.getElementById\('lensBar'\),\{t\}\)/);
  assert.match(html, /window\.CrucixLens\?\.onChange\(applyLens\)/);
  assert.equal(html.match(/^(let|const) D = .*;\s*$/gm).length, 1, 'the injected D line stays one line');
  const sw = read('dashboard/public/sw.js'), base = JSON.parse(sw.match(/const BASE = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
  for (const path of ['/domains.js', '/lens-core.js', '/lens.js', '/lens.css']) assert.ok(base.includes(path), path);
  assert.equal(new Set(base).size, base.length);
  for (const file of ['lens-core.js', 'lens.js']) { const source = read('dashboard/public/' + file); assert.ok(/^\(function\(window\)\{/.test(source), file); assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(source), file + ': no inline handlers'); }
});

test('live-sources.css keeps the chip line to one line ("+N" whole) and both box-shadow markers have a forced-colours fallback', () => {
  const css = read('dashboard/public/live-sources.css'), lens = read('dashboard/public/lens.css');
  const rule = (text, selector) => text.match(new RegExp('(?:^|\\})' + selector.replace(/[.[\]()*+?^$|\\]/g, '\\$&') + '\\{([^}]*)\\}', 'm'))?.[1] ?? '';
  assert.match(rule(css, '.lg-sub'), /flex-wrap:nowrap/, 'the chip line never wraps (spec 1.2: <= 420 px collapsed in every state)');
  assert.match(rule(css, '.lg-sub'), /overflow:hidden/);
  assert.match(rule(css, '.lg-sub'), /contain:inline-size/, 'the one-line chips do not widen the auto-width right rail on phones');
  assert.match(rule(css, '.lg-chip'), /text-overflow:ellipsis/); assert.match(rule(css, '.lg-chip'), /white-space:nowrap/); assert.match(rule(css, '.lg-chip'), /min-width:0/);
  assert.doesNotMatch(rule(css, '.lg-chip'), /overflow-wrap:anywhere/, 'a chip does not break onto a second line');
  assert.match(rule(css, '.lg-chip.lg-more'), /flex:0 0 auto/, 'the "+N" chip never shrinks');
  assert.match(rule(css, '.lg-counts'), /flex:0 0 auto/);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)\s*\{\s*\.live-group\[data-attention="true"\]>\.live-group-head\{[^}]*border-left:[^}]*solid/, 'the attention bar is a border in forced colours');
  assert.match(lens, /@media\s*\(forced-colors:\s*active\)\s*\{\s*\.lens-btn\[aria-pressed="true"\]\{[^}]*text-decoration:underline/, 'the pressed lens is underlined in forced colours');
});

// keepLiveFocus, refreshLiveFreshness and rerenderDashboard in one realm with a fake page whose live panel is replaced with new nodes.
function focusPage() {
  const body = { tag: 'body' }, doc = { body, activeElement: body, buttons: [] };
  const button = (name, value) => ({ name, value, isConnected: true, focused: 0, getAttribute(attribute) { return attribute === this.name ? this.value : null; }, focus(options) { this.focused++; this.options = options; doc.activeElement = this; } });
  // The browser moves the focus to <body> when the focused node leaves the page.
  const redraw = () => { for (const node of doc.buttons) node.isConnected = false; if (doc.buttons.includes(doc.activeElement)) doc.activeElement = body; doc.buttons = [button('data-live-group', 'hazards'), button('data-open-records', 'GDACS'), button('data-open-records', 'EMSC')]; };
  redraw();
  doc.querySelector = selector => (selector === '.live-sources-panel' ? { set outerHTML(_value) { redraw(); } } : null);
  doc.querySelectorAll = selector => doc.buttons.filter(node => selector === '[' + node.name + ']');
  const context = vm.createContext({ document: doc, window: {}, D: { liveSources: [{ source: 'GDACS' }] }, t, liveExpirySignature: '', flatG: null, plotMarkers() {}, buildSourceHealthPanel: () => '',
    currentSnapshot: () => ({ events: [] }), CrucixLiveSources: { state: () => 'ok', observations: () => [], renderPanel: () => '<div class="live-sources-panel"></div>' },
    renderTopbar() {}, renderMapVisibility() {}, renderLeftRail() {}, renderLower() {}, renderRight: redraw, isFixedModuleVisible: () => false });
  for (const name of ['keepLiveFocus', 'refreshLiveFreshness', 'rerenderDashboard']) {
    const start = html.indexOf(`\nfunction ${name}(`); assert.ok(start > 0, name);
    vm.runInContext(html.slice(start, html.indexOf('\nfunction ', start + 1)), context);
  }
  return { doc, context, find: (name, value) => doc.buttons.find(node => node.name === name && node.value === value) };
}

test('the 30 s outerHTML swap and a live update keep the focus on the same live group header or "Open records" button', () => {
  const page = focusPage(), { doc, context, find } = page;
  find('data-live-group', 'hazards').focus();
  context.refreshLiveFreshness();
  const header = find('data-live-group', 'hazards');
  assert.ok(doc.activeElement === header && header.isConnected, 'the new hazards header has the focus after the 30 s swap');
  assert.equal(JSON.stringify(header.options), '{"preventScroll":true}', 'without scrolling the page');
  find('data-open-records', 'EMSC').focus();
  context.rerenderDashboard();
  assert.ok(doc.activeElement === find('data-open-records', 'EMSC'), 'the new EMSC button has the focus after the rails were rebuilt (a live update)');
  // Elsewhere on the page (a lens button): untouched; nothing at all focused: the body stays.
  const other = { getAttribute: () => null, isConnected: true }; doc.activeElement = other;
  context.liveExpirySignature = 'changed'; context.refreshLiveFreshness();
  assert.ok(doc.activeElement === other, 'a focus outside the live panel is left alone');
  doc.activeElement = doc.body; context.rerenderDashboard();
  assert.ok(doc.activeElement === doc.body, 'no focus is invented');
  // A group that is gone after the redraw: the focus is not moved anywhere else.
  doc.buttons.push({ name: 'data-live-group', value: 'space', isConnected: true, getAttribute(attribute) { return attribute === this.name ? this.value : null; }, focus() { doc.activeElement = this; } });
  doc.buttons.at(-1).focus(); context.rerenderDashboard();
  assert.ok(doc.activeElement === doc.body, 'no node with that group: the focus stays where the browser put it');
  // A render that moved the focus somewhere else on purpose, or that kept the focused node: nothing is taken back or refocused.
  const gdacs = find('data-open-records', 'GDACS'), mover = { getAttribute: () => null, isConnected: true, focus() { doc.activeElement = this; } };
  gdacs.focus(); const before = gdacs.focused;
  context.keepLiveFocus(() => mover.focus());
  assert.ok(doc.activeElement === mover, 'the render\'s own focus move wins');
  gdacs.focus(); context.keepLiveFocus(() => {});
  assert.ok(doc.activeElement === gdacs); assert.equal(gdacs.focused, before + 1, 'a node that stayed is not focused again');
});

test('the lenses locale group carries the group-header strings in en, hu and fr', () => {
  const keys = ['all', 'label', ...DOMAIN_IDS, 'sourceCount', 'sourceCountOne', 'recordCount', 'recordCountOne', 'attention', 'moreSources', 'noLiveSources', 'noSources', 'status'];
  for (const lang of ['en', 'hu', 'fr']) {
    const group = JSON.parse(read(`locales/${lang}.json`)).lenses;
    assert.deepEqual(Object.keys(group), keys, lang);
    for (const key of ['sourceCount', 'sourceCountOne', 'recordCount', 'recordCountOne', 'moreSources']) assert.ok(group[key].includes('{count}'), `${lang}: lenses.${key}`);
    assert.ok(group.status.includes('{name}'), `${lang}: lenses.status`);
  }
});
