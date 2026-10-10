import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHttpSecurity } from '../lib/http-security.mjs';
import { installApiErrorHandler } from '../lib/api-errors.mjs';
import { COUNTRIES } from '../lib/intelligence/countries.mjs';
import { EntityStore } from '../lib/intelligence/entities.mjs';
import { PredictionJournal } from '../lib/intelligence/predictions.mjs';
import { viewsMonthId } from '../lib/intelligence/risk.mjs';
import { runRiskStep } from '../lib/intelligence/risk-step.mjs';
import { installRiskRoutes } from '../lib/intelligence/risk-routes.mjs';
import { createBriefingService, generateBriefing } from '../lib/llm/briefing.mjs';
import { metricValues } from '../lib/alerts/metrics.mjs';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const HOUR = 3600000;
const quiet = { warn() {}, error() {}, log() {}, info() {} };
const id = n => `event-${String(n).padStart(32, '0')}`;
const at = ms => new Date(ms).toISOString();

// Located events in Japan (provider coordinates), one news report naming Japan and South Korea, one event elsewhere.
function events() {
  return [
    { id: id(1), kind: 'earthquake', title: 'M6.4 earthquake near Tokyo', summary: '', severity: 'high', observedAt: at(NOW - HOUR), location: { lat: 35.68, lon: 139.69, method: 'provider', label: null } },
    { id: id(2), kind: 'weather', title: 'Typhoon warning for Osaka', summary: '', severity: 'critical', observedAt: at(NOW - 2 * HOUR), location: { lat: 34.69, lon: 135.5, method: 'provider', label: null } },
    { id: id(3), kind: 'news', title: 'Japan and South Korea hold emergency talks', summary: '', severity: 'moderate', observedAt: at(NOW - 3 * HOUR), location: { lat: 0, lon: 0, method: 'headline-keyword', label: 'World' } },
    { id: id(4), kind: 'outage', title: 'Internet outage in Hungary', summary: '', severity: 'high', observedAt: at(NOW - 4 * HOUR), location: { lat: 47.5, lon: 19.04, method: 'provider', label: null } },
  ];
}

// The raw sweep's VIEWS and INFORM results, shaped as the adapters return them.
function raw({ stale = false } = {}) {
  const month = viewsMonthId(NOW);
  return { sources: {
    'VIEWS-Forecast': { source: 'VIEWS-Forecast', status: 'ok', run: 'fatalities003_2026_08_t01', months: [month - 1, month, month + 1], attribution: 'Conflict forecasts: VIEWS', license: 'No data licence stated', ...(stale ? { stale: true } : {}),
      countries: { JPN: { name: 'Japan', months: [{ month_id: month - 1, main_dich: 0.9 }, { month_id: month, main_dich: 0.25, main_mean: 3 }, { month_id: month + 1, main_dich: 0.8 }] } } },
    'INFORM-Risk': { source: 'INFORM-Risk', status: 'ok', release: 'INFORM Risk Mid 2026', published: '2026-09-02', attribution: 'INFORM Risk Index', license: 'open-source', ...(stale ? { stale: true } : {}), countries: { JPN: { score: 2.4 }, HUN: { score: 2.2 } } },
  } };
}

function stores(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-risk-routes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new EntityStore(dir, { now: () => NOW });
  const journal = new PredictionJournal(dir, { now: () => NOW });
  store.load(); journal.load();
  return { dir, store, journal };
}

async function serve(t, options) {
  const app = express();
  installHttpSecurity(app, {});
  installRiskRoutes(app, options);
  installApiErrorHandler(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (url, body, headers = {}) => fetch(`${url}/api/briefing`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('the risk step never throws on a hostile or empty snapshot and sets snapshot.risk otherwise, from the VIEWS/INFORM results (a stale last good one still counts)', t => {
  const { store, journal } = stores(t);
  const throwing = new Proxy({}, { get() { throw new Error('hostile getter'); }, has() { throw new Error('hostile'); } });
  const broken = { ingest() { throw new Error('disk on fire'); } };
  for (const [snapshot, s] of [[null, store], ['text', store], [throwing, store], [{ events: [] }, broken], [{ events: [1, null, 'x', { id: 'bad' }] }, null]]) {
    let result;
    assert.doesNotThrow(() => { result = runRiskStep({ store: s, journal, snapshot, raw: raw(), now: NOW, log: quiet }); });
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
  }
  const failed = { events: [], risk: { stale: true } };
  runRiskStep({ store: broken, snapshot: failed, now: NOW, log: quiet });
  assert.equal(Object.hasOwn(failed, 'risk'), false, 'a failed step leaves no old risk behind');

  const empty = {};
  assert.equal(runRiskStep({ store, journal, snapshot: empty, raw: { sources: 'junk' }, now: NOW, log: quiet }).ok, true);
  assert.deepEqual([empty.risk.top, empty.risk.counts], [[], { scored: 0, high: 0 }]);

  const snapshot = { events: [...events(), 'junk', null] };
  const result = runRiskStep({ store, journal, snapshot, raw: raw(), now: NOW, log: quiet });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(snapshot.risk), ['version', 'at', 'top', 'counts', 'calibration', 'anomalies', 'timeline']);
  const japan = result.scores.find(row => row.iso3 === 'JPN');
  assert.equal(snapshot.risk.top[0].iso3, 'JPN');
  assert.equal(japan.components.forecast.value, 25, 'the VIEWS row of the current month, main_dich x 100');
  assert.equal(japan.components.baseline.value, 24, 'INFORM x 10');
  assert.ok(result.scores.some(row => row.iso3 === 'HUN'));
  assert.ok(journal.recent(50).some(row => row.iso3 === 'JPN'), 'today\'s prediction is logged');
  // A stale VIEWS or INFORM payload (the last good one) still gives its forecast and baseline; a missing one drops the component and the coverage shows it.
  const stale = runRiskStep({ store, snapshot: { events: events() }, raw: raw({ stale: true }), now: NOW + HOUR, log: quiet }).scores.find(row => row.iso3 === 'JPN');
  assert.deepEqual([stale.components.forecast.value, stale.components.baseline.value], [25, 24]);
  const none = runRiskStep({ store, snapshot: { events: events() }, raw: { sources: {} }, now: NOW + HOUR, log: quiet }).scores.find(row => row.iso3 === 'JPN');
  assert.equal(none.components.forecast.value, null);
  assert.ok(none.coverage < japan.coverage);
});

test('the read-only routes over real HTTP: list, profile and predictions shapes; invalid and unknown ISO3; no stack on errors', async t => {
  const { store, journal } = stores(t);
  const snapshot = { events: events() };
  const state = runRiskStep({ store, journal, snapshot, raw: raw(), now: NOW, log: quiet });
  // The current snapshot no longer holds event 2: its title comes from the history store.
  const current = { events: events().filter(event => event.id !== id(2)) };
  const history = { getMany: keys => new Map(keys.filter(key => key === id(2)).map(key => [key, { id: key, title: 'Typhoon warning (history)' }])) };
  let broken = false;
  const url = await serve(t, { store, journal, getSnapshot: () => current, getState: () => { if (broken) throw new Error('state at C:\\secret\\path'); return state; }, history, briefing: null, security: {} });

  const list = await (await fetch(`${url}/api/countries`)).json();
  assert.equal(list.countries[0].iso3, 'JPN');
  assert.deepEqual(Object.keys(list.countries[0]), ['iso3', 'name', 'score', 'change24h', 'coverage', 'convergence']);
  assert.ok(list.countries.every((row, index) => row.score > 0 && (index === 0 || list.countries[index - 1].score >= row.score)));

  const profile = await (await fetch(`${url}/api/countries/JPN`)).json();
  assert.equal(profile.name, 'Japan');
  assert.deepEqual(profile.components.map(item => item.key), ['events', 'persistence', 'diversity', 'attention', 'forecast', 'baseline', 'advisory']);
  assert.deepEqual(profile.components.find(item => item.key === 'attention'), { key: 'attention', value: null, weight: 0.09, available: false });
  assert.equal(profile.series.recent.length, 1);
  assert.deepEqual([profile.forecast.run, profile.forecast.monthUsed, profile.forecast.months.length, profile.forecast.attribution], ['fatalities003_2026_08_t01', viewsMonthId(NOW), 3, 'Conflict forecasts: VIEWS']);
  assert.deepEqual([profile.baseline.score, profile.baseline.release], [2.4, 'INFORM Risk Mid 2026']);
  const titles = Object.fromEntries(profile.events.map(event => [event.id, event.title]));
  assert.deepEqual([titles[id(1)], titles[id(2)], titles[id(3)]], ['M6.4 earthquake near Tokyo', 'Typhoon warning (history)', 'Japan and South Korea hold emergency talks']);
  assert.equal(profile.events.find(event => event.id === id(3)).relation, 'mentioned');
  assert.deepEqual(profile.linked.map(row => row.iso3), ['KOR']);
  const unscored = await (await fetch(`${url}/api/countries/FRA`)).json();
  assert.deepEqual([unscored.score, unscored.components, unscored.events], [null, null, []]);

  const predictions = await (await fetch(`${url}/api/predictions`)).json();
  assert.equal(predictions.calibration.n, 0);
  assert.ok(predictions.recent.length > 0 && predictions.recent.length <= 20 && predictions.recent.every(row => typeof row.name === 'string'));

  for (const [path, status] of [['/api/countries/jpn', 400], ['/api/countries/JAPAN', 400], ['/api/countries/QQQ', 404], ['/api/countries/JPN?x=1', 400], ['/api/countries?limit=5', 400], ['/api/countries/%E0%A4%A', 400]]) {
    const response = await fetch(url + path);
    const text = await response.text();
    assert.equal(response.status, status, path);
    assert.match(response.headers.get('content-type'), /application\/json/, path);
    assert.ok(!/\bat \S+:\d+|stack|secret/i.test(text), `${path}: ${text}`);
  }
  broken = true;
  const failing = await fetch(`${url}/api/countries`);
  assert.equal(failing.status, 503);
  assert.deepEqual(await failing.json(), { error: 'Country risk temporarily unavailable' });
});

test('POST /api/briefing is guarded and validated, keeps only cited bullets from the model and runs one generation per key', async t => {
  const { store, journal } = stores(t);
  const snapshot = { meta: { timestamp: at(NOW) }, events: events() };
  runRiskStep({ store, journal, snapshot, raw: raw(), now: NOW, log: quiet });
  const long = `${'x'.repeat(398)}😀 tail`;
  let calls = 0;
  const provider = { isConfigured: true, config: {}, async complete(system, user) {
    calls++;
    assert.match(system, /untrusted observations/);
    assert.match(system, /compactly on a single line/);
    assert.match(user, /^\[1\] /m);
    await new Promise(resolve => setImmediate(resolve));
    return { text: `Here you go:\n\`\`\`json\n${JSON.stringify({ bullets: [
      { text: '<b>Quake</b> **near** Tokyo [1] see https://evil.example/x', refs: [1, 99, '2'] },
      { text: 'No valid citation', refs: [0, 41, 'x'] },
      { text: 'No refs at all' },
      { text: long, refs: [3] },
    ] })}\n\`\`\`` };
  } };
  const briefing = createBriefingService({ provider, language: 'en', store, getSnapshot: () => snapshot, now: () => NOW, log: quiet });
  const url = await serve(t, { store, journal, getSnapshot: () => snapshot, getState: () => null, briefing, security: {} });

  for (const [body, headers, status, code] of [
    [{ scope: 'global' }, { Origin: 'http://evil.example' }, 403, 'CROSS_ORIGIN'],
    [{ scope: 'global' }, { 'Content-Type': 'text/plain' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ scope: 'QQQ' }, {}, 400, 'INVALID_SCOPE'],
    [{ scope: 'jpn' }, {}, 400, 'INVALID_SCOPE'],
    [{ scope: 'global', extra: 1 }, {}, 400, 'INVALID_BODY'],
    [{ scope: 'global', pad: 'x'.repeat(2000) }, {}, 413, 'BODY_TOO_LARGE'],
    ['{"scope":', {}, 400, 'INVALID_JSON'],
  ]) {
    const response = await post(url, body, headers);
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal((await response.json()).code, code);
  }
  assert.equal(calls, 0, 'refused requests never reach the model');

  const [first, second] = await Promise.all([post(url, { scope: 'global' }), post(url, { scope: 'global' })]);
  const result = await first.json();
  assert.deepEqual(await second.json(), result);
  assert.equal(calls, 1, 'one generation per scope|language|sweep');
  assert.equal(result.source, 'llm');
  assert.equal(result.bullets.length, 2);
  assert.equal(result.bullets[0].text, 'Quake near Tokyo see');
  assert.deepEqual(result.bullets[0].refs.map(ref => ref.n), [1, 2]);
  const rowIds = new Set(events().map(event => event.id));
  assert.ok(result.bullets.every(bullet => bullet.refs.length && bullet.refs.every(ref => rowIds.has(ref.id) && typeof ref.title === 'string')));
  const cut = result.bullets[1].text;
  assert.ok(cut.length <= 400 && cut.endsWith('…') && !/[\ud800-\udbff]…$/.test(cut), 'cut at 400 characters without splitting a surrogate pair');
  await post(url, { scope: 'global' });
  assert.equal(calls, 1, 'cached for the sweep');
});

test('the briefing service keeps a whole sweep (70 scopes > 64), calls the model at most once per scope and never more than 2 at a time', async () => {
  const sweepA = { meta: { timestamp: at(NOW) }, events: events() };
  // Every country scope has the same one reference, so each scope has a row and costs one model call.
  const store = { events: new Map(), countryEvents: () => [{ id: id(1), m: 'l', l: 'high', k: 'earthquake', o: null, t: NOW, time: NOW }] };
  const scopes = COUNTRIES.slice(0, 70).map(country => country.iso3);
  const calls = new Map();
  let running = 0;
  let peak = 0;
  let hold = null;
  const provider = { isConfigured: true, config: {}, async complete(_system, user) {
    const scope = /^SCOPE: .*\(([A-Z]{3})\)$/m.exec(user)[1];
    calls.set(scope, (calls.get(scope) ?? 0) + 1);
    peak = Math.max(peak, ++running);
    try { await (hold ?? new Promise(resolve => setImmediate(resolve))); } finally { running--; }
    return { text: JSON.stringify({ bullets: [{ text: 'Quake near Tokyo', refs: [1] }] }) };
  } };
  const make = getSnapshot => createBriefingService({ provider, language: 'en', store, getSnapshot, now: () => NOW, log: quiet });

  // One at a time, twice: all 70 stay cached for the sweep (the cache held 64), so a scope costs one call.
  const steady = make(() => sweepA);
  for (let round = 0; round < 2; round++) for (const scope of scopes) assert.equal((await steady.generate(scope)).source, 'llm', scope);
  assert.deepEqual([calls.size, [...calls.values()].every(count => count === 1)], [70, true]);

  // A burst of 70 at once, twice: never more than 2 calls in flight, the rest answer with rules (`busy`, not cached), a scope costs at most one call.
  calls.clear(); peak = 0;
  const burst = make(() => sweepA);
  const answers = [...await Promise.all(scopes.map(scope => burst.generate(scope))), ...await Promise.all(scopes.map(scope => burst.generate(scope)))];
  assert.ok(peak >= 1 && peak <= 2, `peak ${peak}`);
  assert.ok([...calls.values()].every(count => count === 1) && calls.size <= 4);
  const busy = answers.filter(answer => answer.busy === true);
  assert.ok(busy.length > 100 && busy.every(answer => answer.source === 'rules' && answer.bullets.length > 0 && answer.bullets.every(bullet => bullet.refs.length > 0)));
  assert.ok(answers.filter(answer => answer.busy !== true).every(answer => answer.source === 'llm'));

  // A generation that ends after a newer sweep began is answered but neither kept nor allowed to evict the newer sweep's entries.
  calls.clear();
  let sweep = sweepA;
  const moving = make(() => sweep);
  let release;
  hold = new Promise(resolve => { release = resolve; });
  const slow = moving.generate('JPN');
  sweep = { meta: { timestamp: at(NOW + HOUR) }, events: events() };
  hold = null;
  await moving.generate('KOR');
  release();
  assert.equal((await slow).source, 'llm');
  assert.equal(calls.size, 2);
  await moving.generate('KOR');
  assert.equal(calls.get('KOR'), 1, 'the newer sweep kept its entry');
  await moving.generate('JPN');
  assert.equal(calls.get('JPN'), 2, 'the older sweep\'s late result was not kept');
});

test('the briefing falls back to rules when the model throws or answers junk, and every rule bullet cites a real row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-risk-rules-'));
  try {
    const store = new EntityStore(dir, { now: () => NOW });
    const snapshot = { events: events() };
    const { scores } = runRiskStep({ store, snapshot, raw: raw(), now: NOW, log: quiet });
    const ids = new Set(events().map(event => event.id));
    const providers = [null, { isConfigured: true, config: {}, complete: async () => { throw new Error('timeout'); } },
      { isConfigured: true, config: {}, complete: async () => ({ text: 'not json <script>' }) },
      { isConfigured: true, config: {}, complete: async () => ({ text: '{"bullets":[{"text":"uncited","refs":[77]}]}' }) }];
    for (const provider of providers) {
      for (const scope of ['global', 'JPN']) {
        const result = await generateBriefing({ scope, snapshot, store, scores, provider, language: 'hu', now: NOW, log: quiet });
        assert.equal(result.source, 'rules');
        assert.ok(result.bullets.length > 0 && result.bullets.length <= 8, scope);
        for (const bullet of result.bullets) {
          assert.ok(bullet.text.length > 0 && bullet.text.length <= 400);
          assert.ok(bullet.refs.length > 0 && bullet.refs.every(ref => ids.has(ref.id) && ref.n >= 1), JSON.stringify(bullet));
        }
      }
    }
    const japan = await generateBriefing({ scope: 'JPN', snapshot, store, scores, language: 'hu', now: NOW });
    assert.match(japan.bullets[0].text, /^Japan: kockázati pontszám \d+\/100, még nincs 24 órás összehasonlítás\.$/);
    await assert.rejects(generateBriefing({ scope: 'QQQ', snapshot, store, now: NOW }), RangeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the alert metrics read snapshot.risk and are null without it', () => {
  const values = metricValues({ risk: { top: [{ iso3: 'JPN', score: 72 }, { iso3: 'HUN', score: 40 }], counts: { scored: 2, high: 1 } } });
  assert.deepEqual([values.risk_max_score, values.risk_countries_high], [72, 1]);
  for (const snapshot of [{}, { risk: null }, { risk: 'high' }, { risk: { counts: { high: 3 } } }, { risk: { top: [], counts: {} } }]) {
    const empty = metricValues(snapshot);
    assert.deepEqual([empty.risk_max_score, empty.risk_countries_high], [null, null], JSON.stringify(snapshot));
  }
});
