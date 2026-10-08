import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import express from 'express';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exposureOf, exposedCountries } from '../lib/intelligence/exposure.mjs';
import { runRiskStep } from '../lib/intelligence/risk-step.mjs';
import { installRiskRoutes } from '../lib/intelligence/risk-routes.mjs';
import { installHttpSecurity } from '../lib/http-security.mjs';
import { installApiErrorHandler } from '../lib/api-errors.mjs';
import { EntityStore } from '../lib/intelligence/entities.mjs';
import { PredictionJournal } from '../lib/intelligence/predictions.mjs';

const NOW = Date.parse('2026-10-08T00:10:00Z');
const quiet = { warn() {}, error() {}, log() {}, info() {} };
const root = new URL('../dashboard/public/', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const portwatch = (status = 'ok') => ({ source: 'IMF-PortWatch', status, observations: [
  { providerId: 'hormuz:2026-10-05', observedAt: '2026-10-05T00:00:00Z', severity: 'moderate', facts: [{ label: 'mean7d', value: 61 }, { label: 'baseline28d', value: 94 }, { label: 'changePct', value: -35 }] },
  { providerId: 'malacca:2026-10-05', observedAt: '2026-10-05T00:00:00Z', severity: 'info', facts: [{ label: 'mean7d', value: 250 }] },
  { providerId: 'unknown_strait:2026-10-05', facts: [{ label: 'changePct', value: -99 }] }] });

test('exposure: Japan leans on Hormuz and Malacca, highest index first; Hungary has no entry; the live state is the PortWatch row of the passage', () => {
  const rows = exposureOf('JPN', [portwatch()]);
  assert.deepEqual(rows.map(row => [row.chokepoint, row.index, row.basis]), [['hormuz', 0.64, 'oil'], ['malacca', 0.42, 'trade']]);
  assert.deepEqual(plain(rows[0].live), { changePct: -35, mean7d: 61, baseline28d: 94, observedAt: '2026-10-05T00:00:00Z', severity: 'moderate' });
  assert.equal(rows[1].live.changePct, null, 'a row without the fact keeps null, not zero');
  assert.deepEqual(exposureOf('HUN', [portwatch()]), []);
  assert.deepEqual(exposureOf('XXX'), []);
  assert.deepEqual(exposureOf(null), []);
  assert.equal(exposureOf('JPN', [portwatch('stale')])[0].live, null, 'a stale or missing live source gives no live state');
  assert.equal(exposureOf('jpn', 'garbage')[0].live, null);
  assert.ok(exposedCountries().includes('CHN') && exposedCountries().length >= 13);
  const china = exposureOf('CHN');
  assert.deepEqual(china.map(row => row.chokepoint), ['malacca', 'hormuz', 'panama', 'suez'].filter(name => china.some(row => row.chokepoint === name)).sort((a, b) => china.find(r => r.chokepoint === b).index - china.find(r => r.chokepoint === a).index || (a < b ? -1 : 1)), 'sorted by index, ties by id');
});

test('GET /api/countries/:iso3 carries the exposure with the live traffic of the snapshot, an empty list for a country without', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-exposure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new EntityStore(dir, { now: () => NOW }), journal = new PredictionJournal(dir, { now: () => NOW });
  store.load(); journal.load();
  const state = runRiskStep({ store, journal, snapshot: { events: [] }, raw: { sources: {} }, now: NOW, log: quiet });
  const app = express();
  installHttpSecurity(app, {});
  installRiskRoutes(app, { store, journal, getSnapshot: () => ({ events: [], liveSources: [portwatch()] }), getState: () => state, history: null, briefing: null, security: {} });
  installApiErrorHandler(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const japan = await (await fetch(`${url}/api/countries/JPN`)).json();
  assert.deepEqual(japan.exposure.map(row => row.chokepoint), ['hormuz', 'malacca']);
  assert.equal(japan.exposure[0].live.changePct, -35);
  assert.deepEqual((await (await fetch(`${url}/api/countries/HUN`)).json()).exposure, []);
});

const sheet = () => { const window = {}; vm.runInContext(read('country.js'), vm.createContext({ window, document: {}, Intl })); return window.CrucixCountry; };
const base = { iso3: 'JPN', name: 'Japan', score: null, events: [], linked: [], forecast: null, baseline: null, advisory: null, actors: null };

test('the country sheet shows the exposure table with the traffic, escaped, an unknown basis as trade, and nothing for an empty list', () => {
  const country = sheet();
  const html = country.render({ ...base, exposure: [
    { chokepoint: 'hormuz', name: 'Strait of Hormuz', strength: 0.8, redundancy: 0.2, index: 0.64, basis: 'oil', live: { changePct: -35, mean7d: 61 } },
    { chokepoint: 'malacca', name: '<img onerror=x>', index: 0.42, basis: 'weird', live: { mean7d: 250 } },
    { chokepoint: 'suez', name: 'Suez Canal', index: 0.3, basis: 'trade', live: null },
    { chokepoint: 'Bad Id!', index: 0.5 }, null] });
  assert.ok(html.includes('Chokepoint exposure (editorial)') && html.includes('<td>64%</td>') && html.includes('oil imports'));
  assert.ok(html.includes('-35% transits against the 28-day median') && html.includes('250 transits a day (7-day mean)') && html.includes('No current traffic data'));
  assert.ok(html.includes('not measured trade data') && !html.includes('<img') && !html.includes('Bad Id'));
  assert.ok(html.includes('<td>trade route</td>'), 'an unknown basis reads as trade route');
  assert.ok(!country.render({ ...base, exposure: [] }).includes('Chokepoint exposure'));
  assert.ok(!country.render({ ...base }).includes('Chokepoint exposure'));
});

// The inspector draws the nearby section from the dataset of infrastructure.js: the first located record starts one request, the page is told once.
function inspector({ fetchJson, withInfrastructure = true } = {}) {
  const events = [];
  const data = JSON.parse(read('data/infrastructure.json'));
  const window = { dispatchEvent: event => events.push(event.type), Event: class { constructor(type) { this.type = type; } }, fetch: fetchJson ?? (async () => ({ ok: true, json: async () => data })) };
  const context = vm.createContext({ window, Date, URL, Math, Number, Object, Array, JSON, Promise, String, Intl });
  for (const file of ['record-core.js', ...(withInfrastructure ? ['infrastructure.js'] : []), 'record-inspector.js']) vm.runInContext(read(file), context);
  return { window, events, fetchJson };
}
const view = rec => ({ source: null, records: [], total: 0, filters: {}, limit: 25, selected: { record: rec, outdated: false } });

test('the inspector shows nearby pipelines and bases once the dataset is loaded, asks for it once and works without the module', async () => {
  const env = inspector();
  const rec = { key: 'k', title: 'M5 earthquake', source: 'EMSC', level: 'high', lat: 26.5, lon: 56.3, facts: [] };
  const tx = (_, fallback) => fallback;
  const first = env.window.CrucixRecordInspector.renderInspector(view(rec), tx, NOW);
  assert.ok(!first.includes('Nearby infrastructure'), 'nothing while the dataset is not loaded');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(env.events, ['crucix:infrastructure'], 'the page is told when the dataset arrives');
  const second = env.window.CrucixRecordInspector.renderInspector(view(rec), tx, NOW);
  assert.ok(second.includes('Nearby infrastructure (600 km)') && second.includes('Goureh-Jask') && /Military base · <strong>[^<]+<\/strong>/.test(second), 'pipelines and bases around Hormuz');
  assert.ok(/ \d+ km<\/li>/.test(second) && second.includes('may be approximate'));
  const far = env.window.CrucixRecordInspector.renderInspector(view({ ...rec, lat: -40, lon: -140 }), tx, NOW);
  assert.ok(!far.includes('Nearby infrastructure'), 'no section when nothing is within 600 km');
  assert.ok(!env.window.CrucixRecordInspector.renderInspector(view({ ...rec, lat: null, lon: null }), tx, NOW).includes('Nearby infrastructure'), 'no section for a record without a position');
  const without = inspector({ withInfrastructure: false });
  assert.ok(!without.window.CrucixRecordInspector.renderInspector(view(rec), tx, NOW).includes('Nearby infrastructure'));
});

test('the first located record starts the load and the page is notified once, a failed load never loops', async () => {
  const data = JSON.parse(read('data/infrastructure.json'));
  const env = inspector();
  let loads = 0;
  const original = env.window.CrucixInfrastructure.load;
  env.window.CrucixInfrastructure.load = (...args) => { loads++; return original(async () => data); };
  const rec = { key: 'k', title: 'x', source: 'EMSC', level: 'high', lat: 26.5, lon: 56.3, facts: [] };
  const render = () => env.window.CrucixRecordInspector.renderInspector(view(rec), (_, f) => f, NOW);
  render();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(env.events, ['crucix:infrastructure']);
  assert.ok(render().includes('Nearby infrastructure'));
  const failing = inspector();
  failing.window.CrucixInfrastructure.load = () => Promise.resolve(null);
  failing.window.CrucixRecordInspector.renderInspector(view(rec), (_, f) => f, NOW);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(failing.events, [], 'a failed load sends no event, so the inspector does not redraw in a loop');
  assert.equal(loads, 1);
});
