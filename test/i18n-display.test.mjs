import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import vm from 'node:vm';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDelta, NUMERIC_METRICS, COUNT_METRICS } from '../lib/delta/engine.mjs';
import { exportRecords } from '../lib/intelligence/export.mjs';
import { RULE_MESSAGES, validateRule } from '../lib/alerts/rules.mjs';
import { AlertEngine } from '../lib/alerts/engine.mjs';
import { AlertError } from '../lib/alerts/lifecycle.mjs';
import { alertErrorMessage, installAlertRoutes } from '../lib/alerts/routes.mjs';

// Display text the server produces (delta labels, export reports, rule validation messages) in the dashboard language.
// Only what is shown changes: stored values, ids, codes and field paths stay English.

const LANGS = ['en', 'hu', 'fr'];
const locale = code => JSON.parse(readFileSync(new URL(`../locales/${code}.json`, import.meta.url), 'utf8'));
const html = readFileSync(new URL('../dashboard/public/jarvis.html', import.meta.url), 'utf8');
const quiet = { warn() {}, error() {}, log() {}, info() {} };
const slots = text => [...String(text).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
// The page's t() (jarvis.html): walks the key with `in`; anything but a string gives the fallback.
const pageT = messages => (path, fallback) => { let value = messages; for (const key of path.split('.')) value = value && typeof value === 'object' && key in value ? value[key] : undefined; return typeof value === 'string' ? value : fallback || path; };
// A group of every locale: the same keys in the same order, each a non-empty string with the English template's {slots}.
function sameShape(read, name) {
  const english = read(locale('en'));
  for (const code of LANGS) {
    const group = read(locale(code));
    assert.deepEqual(Object.keys(group || {}), Object.keys(english), `${code}: ${name} keys`);
    for (const [key, value] of Object.entries(group)) {
      assert.ok(typeof value === 'string' && value.trim() !== '', `${code}: ${name}.${key}`);
      assert.deepEqual(slots(value), slots(english[key]), `${code}: ${name}.${key} keeps the {slots}`);
    }
  }
  return english;
}

test('delta labels and reasons: every locale has them, and English is exactly what the engine stores', () => {
  const labels = sameShape(data => data.delta.labels, 'delta.labels');
  sameShape(data => data.delta.reasons, 'delta.reasons');
  const engine = Object.fromEntries([...NUMERIC_METRICS, ...COUNT_METRICS].map(metric => [metric.key, metric.label]));
  assert.deepEqual(labels, { ...engine, nuke_anomaly: 'Nuclear Anomaly' });

  const previous = { meta: { timestamp: '2026-10-08T10:00:00Z' }, nuke: [{ anom: true }], tg: { urgent: [] } };
  const current = { meta: { timestamp: '2026-10-08T10:15:00Z' }, nuke: [{ anom: false }], tg: { urgent: [{ postId: 'p1', text: 'x' }] } };
  const delta = computeDelta(current, previous);
  const reasons = locale('en').delta.reasons;
  assert.deepEqual(Object.keys(reasons), ['tg_urgent', 'nuke_anomaly']);
  assert.equal(delta.signals.new.find(signal => signal.key.startsWith('tg_urgent:')).reason, reasons.tg_urgent);
  assert.equal(delta.signals.deescalated.find(signal => signal.key === 'nuke_anomaly').label, labels.nuke_anomaly);
  const fresh = computeDelta({ ...current, nuke: [{ anom: true }] }, { ...previous, nuke: [{ anom: false }] });
  assert.equal(fresh.signals.new.find(signal => signal.key === 'nuke_anomaly').reason, reasons.nuke_anomaly);
});

test('the Sweep Delta panel shows the signals in the page language by key, the stored English text as the fallback', () => {
  const start = html.indexOf('function deltaText(');
  const source = html.slice(start, html.indexOf('\nfunction ', start + 1));
  const deltaText = messages => vm.runInNewContext(`${source}\ndeltaText`, { t: pageT(messages) });
  const hu = deltaText(locale('hu')), en = deltaText(locale('en'));
  assert.equal(hu({ key: 'vix', label: 'VIX' }), 'VIX');
  assert.equal(hu({ key: 'wti', label: 'WTI Crude' }), 'WTI kőolaj');
  assert.equal(hu({ key: 'tg_urgent:id:42', reason: 'New urgent OSINT post' }), 'Új sürgős OSINT-poszt');
  assert.equal(hu({ key: 'nuke_anomaly', reason: 'Nuclear anomaly detected' }), 'Nukleáris anomália észlelve');
  assert.equal(hu({ key: 'nuke_anomaly', label: 'Nuclear Anomaly' }), 'Nukleáris anomália');
  assert.equal(hu({ key: 'source_degradation', reason: '4 additional sources failing (5 total down)' }), '4 additional sources failing (5 total down)', 'its numbers are only in the stored sentence');
  assert.equal(hu({ key: 'some_new_metric', label: 'Some new metric' }), 'Some new metric', 'an unknown key keeps the stored label');
  for (const key of ['__proto__', 'constructor', 'toString']) assert.equal(hu({ key, label: 'Stored' }), 'Stored', key);
  assert.equal(en({ key: 'tg_urgent:id:42', reason: 'New urgent OSINT post' }), 'New urgent OSINT post');
  assert.equal(en({ key: 'hy_spread', label: 'HY Spread' }), 'HY Spread');
});

const record = n => ({
  id: `event-${String(n).padStart(32, '0')}`, kind: 'earthquake', title: `Earthquake ${n}`, summary: 'Unverified public-source report',
  source: { name: 'USGS', url: null, hostname: null, status: 'ok' },
  observedAt: '2026-10-01T08:00:00.000Z', publishedAt: null, collectedAt: '2026-10-01T10:00:00.000Z',
  location: { lat: 47.5, lon: 19, method: 'provider', label: 'Budapest', precision: 'coordinates' }, severity: 'moderate',
  quality: { level: 'complete', checks: { sourceUrl: true, providerTime: true, location: true, sourceStatus: true }, explanationCodes: [] },
  relatedSources: [{ eventId: `event-${'f'.repeat(32)}`, name: 'EMSC', url: 'https://www.emsc-csem.org/' }],
});

test('the export report speaks the export language; field names, provenance lines and the CSV header stay as they are', () => {
  sameShape(data => data.export, 'export');
  const generatedAt = '2026-10-01T12:00:00.000Z';
  const run = (format, language, records = [record(1)]) => exportRecords(records, format, { generatedAt, total: 3, language, filters: { q: 'quake' } }).body;
  const english = run('html', 'en');
  assert.match(english, /<title>Crucix public-source report<\/title>/);
  assert.ok(english.includes('Exported 1 of 3 matching records. Truncated: export is limited to 2000 records or the supplied result page. Generated 2026-10-01T12:00:00.000Z. Query filters: {&quot;q&quot;:&quot;quake&quot;}.'));
  assert.ok(english.includes('<p>USGS · unknown source host</p>') && english.includes('<p>Related reports: <a href="https://www.emsc-csem.org/"'), 'the separator is a real middle dot');
  const hungarian = run('html', 'hu');
  assert.match(hungarian, /<html lang="hu">/);
  assert.match(hungarian, /<h1>Crucix-jelentés nyilvános forrásokból<\/h1>/);
  assert.ok(hungarian.includes('3 találatból 1 rekord exportálva. Csonkolva: az export legfeljebb 2000 rekordot'));
  assert.ok(hungarian.includes('ismeretlen forrásszerver') && hungarian.includes('Kapcsolódó jelentések: <a href='));
  assert.ok(hungarian.includes('observedAt: 2026-10-01T08:00:00.000Z'), 'the provenance lines keep their field names');
  assert.match(run('html', 'fr', []), /<p>Aucun événement correspondant\.<\/p>/);
  const stix = JSON.parse(run('stix', 'hu'));
  const report = stix.objects.find(object => object.type === 'report');
  assert.equal(report.name, 'Crucix kontextus-export nyilvános forrásokból');
  assert.equal(stix.objects.find(object => object.abstract === 'Az export köre és korlátai').content, report.description);
  const note = stix.objects.find(object => object.external_references?.some(ref => ref.external_id === record(1).id));
  assert.ok(note.content.endsWith('nem állított fenyegetés.'));
  assert.equal(note.external_references[0].source_name, 'Crucix event', 'the reference type stays English');
  assert.equal(note.external_references.find(ref => ref.source_name === 'EMSC').description, 'Kapcsolódó jelentés; nem független megerősítés');
  assert.equal(run('csv', 'hu').split('\r\n')[0], run('csv', 'en').split('\r\n')[0], 'the CSV header is the same in every language');
});

test('rule messages: RULE_MESSAGES is en.json alerts.errors, and hu/fr name every key with the same {slots}', () => {
  const english = sameShape(data => data.alerts.errors, 'alerts.errors');
  assert.deepEqual(english, { ...RULE_MESSAGES });
  const result = validateRule({ id: 'x', name: 'X', kind: 'threshold', forSweeps: 99, params: { metric: 'vix', op: '>', value: 1 } });
  assert.deepEqual(result.error, { code: 'INVALID_RULE', field: 'forSweeps', message: 'must be an integer from 1 to 10', key: 'integerRange', values: { min: 1, max: 10 } }, 'the English message is unchanged');
  const error = new AlertError(400, 'INVALID_RULE', result.error.message, result.error.field, result.error.key, result.error.values);
  assert.equal(alertErrorMessage(error, 'hu'), '1 és 10 közötti egész szám legyen');
  assert.equal(alertErrorMessage(error, 'fr'), 'doit être un entier de 1 à 10');
  assert.equal(alertErrorMessage(error, 'en'), 'must be an integer from 1 to 10');
  assert.equal(alertErrorMessage(new AlertError(404, 'NOT_FOUND', 'No such alert', 'id'), 'hu'), 'No such alert', 'an error without a rule message stays English');
  assert.equal(alertErrorMessage(new AlertError(400, 'INVALID_RULE', 'raw', 'x', 'noSuchKey'), 'hu'), 'raw', 'an unknown key keeps the English message');
});

test('the alert API answers rule errors in the server language; code and field are the same', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-i18n-display-'));
  const engine = new AlertEngine(dir, { now: () => Date.parse('2026-10-08T12:00:00Z'), logger: quiet });
  engine.load();
  const app = express();
  app.use(express.json());
  installAlertRoutes(app, { engine, getSnapshot: () => null, security: {}, language: 'hu' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (method, path, body) => fetch(url + path, { method, headers: { 'Content-Type': 'application/json', Origin: url }, body: body === undefined ? undefined : JSON.stringify(body) });

  const bad = await send('PUT', '/api/alerts/rules/my-rule', { name: 'Mine', kind: 'threshold', params: { metric: 'vix', op: '>' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'kötelező', code: 'INVALID_RULE', field: 'params.value' });
  const builtin = await send('PUT', '/api/alerts/rules/vix-spike', { name: 'Renamed' });
  assert.deepEqual(await builtin.json(), { error: 'beépített szabálynál nem módosítható', code: 'INVALID_RULE', field: 'name' });
  const remove = await send('DELETE', '/api/alerts/rules/vix-spike');
  assert.deepEqual(await remove.json(), { error: 'A beépített szabályok nem törölhetők, csak kikapcsolhatók', code: 'INVALID_STATE', field: 'id' });
  const missing = await send('DELETE', '/api/alerts/rules/nothing-here');
  assert.deepEqual([missing.status, (await missing.json()).error], [404, 'Nincs ilyen szabály']);
});
