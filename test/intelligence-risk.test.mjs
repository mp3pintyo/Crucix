import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COUNTRIES, countriesInText, countryByIso2, countryByName, countryByNum } from '../lib/intelligence/countries.mjs';
import { countryAt } from '../lib/intelligence/geo.mjs';
import { EntityStore } from '../lib/intelligence/entities.mjs';
import { scoreCountries, summarize } from '../lib/intelligence/risk.mjs';
import { PredictionJournal } from '../lib/intelligence/predictions.mjs';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-03T12:00:00Z');
const iso = ms => new Date(ms).toISOString();

let serial = 0;
function event(fields, n = ++serial) {
  return { id: `event-${n.toString(16).padStart(32, '0')}`, kind: 'news', title: '', summary: '', severity: 'unknown', observedAt: null, publishedAt: null,
    location: { lat: null, lon: null, method: 'unknown', label: null, precision: 'unknown' }, ...fields };
}
// A located physical event at a point with a provider location.
const at = (kind, lat, lon, severity, time, n) => event({ kind, title: `${kind} report`, severity, observedAt: iso(time), location: { lat, lon, method: 'provider', label: '', precision: 'exact' } }, n);
const TOKYO = [35.68, 139.69];
const BUDAPEST = [47.4979, 19.0402];

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-risk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('every world-atlas shape resolves in the gazetteer; ambiguous names never match a title; hostile text stays bounded', () => {
  const topology = JSON.parse(readFileSync(new URL('../dashboard/public/vendor/countries-110m-2.0.2.json', import.meta.url), 'utf8'));
  for (const shape of topology.objects.countries.geometries) {
    const country = shape.id !== undefined ? countryByNum(shape.id) : countryByName(shape.properties.name);
    assert.ok(country, `shape ${shape.id} ${shape.properties.name} resolves`);
    assert.ok(countryByName(shape.properties.name) === country, `"${shape.properties.name}" is a known name of ${country.iso3}`);
  }
  assert.ok(COUNTRIES.length >= 249);
  assert.equal(new Set(COUNTRIES.map(country => country.iso3)).size, COUNTRIES.length);
  assert.equal(new Set(COUNTRIES.map(country => country.iso2)).size, COUNTRIES.length);
  assert.equal(countryByIso2('hu').iso3, 'HUN');

  assert.deepEqual(countriesInText('Georgia passes a new election law'), [], 'Georgia is ambiguous in a title');
  assert.deepEqual(countriesInText('Jordan and Chad sign a deal; Korea talks'), []);
  assert.deepEqual(countriesInText('North Korea fires a missile over Japan'), ['PRK', 'JPN']);
  assert.deepEqual(countriesInText('Storms in New Mexico; Guinea-Bissau votes; U.S. sanctions'), ['GNB', 'USA'], 'longest match first, blockers consume');
  assert.deepEqual(countriesInText('Hungary, Austria, Poland, Spain'), ['HUN', 'AUT', 'POL'], 'limit 3');
  assert.equal(countryByName('Georgia').iso3, 'GEO', 'a structured field may still name it');
  assert.deepEqual(countriesInText(`${'x'.repeat(600)} Hungary`), [], 'only the first 600 characters are read');

  const hostile = ['North '.repeat(170000), 'Aa'.repeat(500000), "U.S.'s.".repeat(150000), 'Bosnia and '.repeat(100000)];
  const started = performance.now();
  for (let i = 0; i < 50; i++) for (const text of hostile) countriesInText(text);
  assert.ok(performance.now() - started < 2000, 'two hundred 1e6-character scans finish quickly');
});

test('countryAt resolves known points, the antimeridian and the sea', () => {
  assert.equal(countryAt(...BUDAPEST), 'HUN');
  assert.equal(countryAt(50.45, 30.52), 'UKR');
  assert.equal(countryAt(...TOKYO), 'JPN');
  assert.equal(countryAt(0, -160), null, 'mid-Pacific');
  assert.equal(countryAt(66, -172), 'RUS', 'Chukotka, east of the antimeridian');
  assert.equal(countryAt(-16.5, -179.95), 'FJI');
  assert.equal(countryAt(66, 188), 'RUS', 'longitude is normalised');
  assert.equal(countryAt(Number.NaN, 0), null);
  assert.equal(countryAt('47', '19'), null);
});

test('entity ingest: keyword places count only as mentions, provider places locate, caps and retention hold, corrupt loads empty', t => {
  const dir = tempDir(t);
  const store = new EntityStore(dir, { now: () => NOW, maxRefs: 6 });
  store.load();
  const keyword = event({ title: "Trump meets Hungary's prime minister", location: { lat: 38.9, lon: -77.03, method: 'headline-keyword', label: 'Trump', precision: 'approximate' } });
  const quake = at('earthquake', ...TOKYO, 'high', NOW - HOUR);
  const many = event({ kind: 'osint', title: 'Hungary, Austria, Poland, Spain and Italy meet' });
  store.ingest([keyword, quake, many]);
  assert.deepEqual(store.events.get(keyword.id), { c: ['HUN'], m: 'm', l: null, k: 'news', o: null, t: NOW }, 'the Washington keyword point is ignored');
  assert.deepEqual(store.events.get(quake.id).c, ['JPN']);
  assert.equal(store.events.get(quake.id).m, 'l');
  assert.equal(store.events.get(many.id).c.length, 3);
  assert.equal(store.countryEvents('JPN', { mode: 'l' })[0].id, quake.id);

  store.ingest(Array.from({ length: 10 }, () => event({ title: 'Hungary news' })), { now: NOW + 1000 });
  assert.equal(store.events.size, 6, 'maxRefs keeps the newest references');
  assert.ok(store.save());
  const reloaded = new EntityStore(dir, { now: () => NOW + 1000 });
  assert.equal(reloaded.load(), 'ok');
  assert.equal(reloaded.events.size, 6);
  reloaded.ingest([], { now: NOW + 36 * DAY });
  assert.equal(reloaded.events.size, 0, 'references past 35 days expire');

  const broken = tempDir(t);
  mkdirSync(join(broken, 'intelligence'), { recursive: true });
  writeFileSync(join(broken, 'intelligence', 'countries.json'), '{"version":1,"events":');
  const corrupt = new EntityStore(broken, { now: () => NOW });
  assert.equal(corrupt.load(), 'corrupt');
  assert.equal(corrupt.events.size, 0);
});

test('risk: missing components renormalise, convergence needs three kinds at high, change24h is null without history', t => {
  const store = new EntityStore(tempDir(t), { now: () => NOW });
  store.load();
  store.ingest([
    at('earthquake', ...TOKYO, 'high', NOW - HOUR), at('conflict', ...TOKYO, 'critical', NOW - 2 * HOUR),
    at('weather', ...TOKYO, 'high', NOW - 3 * HOUR), at('outage', ...TOKYO, 'severe', NOW - 30 * HOUR),
    at('earthquake', ...BUDAPEST, 'high', NOW - HOUR), at('weather', ...BUDAPEST, 'high', NOW - HOUR), at('outage', ...BUDAPEST, 'moderate', NOW - HOUR),
    at('market', ...BUDAPEST, 'critical', NOW - HOUR),
  ]);
  const scores = scoreCountries({ store, now: NOW });
  const japan = scores.find(row => row.iso3 === 'JPN');
  const hungary = scores.find(row => row.iso3 === 'HUN');
  for (const name of ['attention', 'forecast', 'baseline', 'advisory']) assert.equal(japan.components[name].value, null, `${name} is missing, not zero`);
  assert.equal(japan.coverage, 0.56);
  const { events, persistence, diversity } = japan.components;
  assert.equal(japan.score, Math.round((events.value * 0.30 + persistence.value * 0.13 + diversity.value * 0.13) / 0.56));
  assert.deepEqual(japan.convergence, { active: true, kinds: ['conflict', 'earthquake', 'weather'] }, 'the 30-hour-old outage is outside 24 hours');
  assert.deepEqual(hungary.convergence, { active: false, kinds: ['earthquake', 'weather'] }, 'watch-level and non-physical kinds do not count');
  assert.equal(japan.change24h, null);
  assert.equal(persistence.value, Math.round(2 / 7 * 1000) / 10, 'two distinct days with a high event');

  const full = scoreCountries({ store, forecasts: { JPN: [{ month_id: 562, main_dich: 0.5 }] }, baselines: { JPN: 4 }, now: NOW });
  const japanFull = full.find(row => row.iso3 === 'JPN');
  assert.equal(japanFull.coverage, 0.79);
  assert.equal(japanFull.components.forecast.value, 50);
  assert.equal(japanFull.components.baseline.value, 40);

  store.recordScores([{ iso3: 'JPN', score: 10 }], NOW - 24 * HOUR);
  store.recordScores([{ iso3: 'JPN', score: 99 }], NOW - 25 * HOUR);
  assert.equal(store.series('JPN').length, 1, 'a clock that went back adds no point');
  assert.equal(scoreCountries({ store, now: NOW }).find(row => row.iso3 === 'JPN').change24h, japan.score - 10);
  const summary = summarize(scores, null, NOW);
  assert.equal(summary.top[0].iso3, 'JPN');
  assert.deepEqual(summary.counts, { scored: scores.length, high: scores.filter(row => row.score >= 70).length });
  assert.equal(summary.calibration, null);
});

test('predictions resolve from events first seen after them; resolved rows never change; calibration gates on 30 rows', t => {
  const dir = tempDir(t);
  let clock = NOW;
  const store = new EntityStore(dir, { now: () => clock, retentionDays: 90 });
  const journal = new PredictionJournal(dir, { now: () => clock });
  store.load(); journal.load();
  assert.equal(journal.calibration(), null);
  store.ingest([at('earthquake', ...TOKYO, 'high', clock, 9001)]);
  assert.equal(journal.log([{ iso3: 'JPN', score: 60 }, { iso3: 'KOR', score: 50 }, { iso3: 'HUN', score: 5 }], store), 2, 'HUN: score < 10 and no located event');
  assert.equal(journal.log([{ iso3: 'JPN', score: 70 }], store), 0, 'one prediction per country per day');
  clock += 2 * DAY;
  store.ingest([at('earthquake', ...TOKYO, 'critical', clock, 9002)]);
  clock += 5 * DAY + 1;
  assert.equal(journal.resolve(store), 2);
  const [korea, japan] = journal.recent(2);
  assert.deepEqual([japan.iso3, japan.outcome, japan.evidence], ['JPN', 1, `event-${(9002).toString(16).padStart(32, '0')}`], 'the event seen with the prediction does not count');
  assert.deepEqual([korea.iso3, korea.outcome], ['KOR', 0]);
  const resolved = JSON.stringify(journal.rows);
  store.ingest([at('earthquake', ...TOKYO, 'critical', clock, 9003)]);
  clock += 8 * DAY;
  journal.resolve(store);
  assert.equal(JSON.stringify(journal.rows), resolved, 'resolved rows are immutable');
  const early = journal.calibration();
  assert.deepEqual([early.n, early.enough, early.brier, early.skill], [2, false, null, null], 'not enough data yet');

  for (let day = 0; day < 30; day++) { clock += DAY; journal.log([{ iso3: 'FRA', score: 42 }], store); }
  clock += 8 * DAY;
  journal.resolve(store);
  const metrics = journal.calibration();
  const rows = journal.rows.filter(row => row.outcome !== null);
  const base = rows.reduce((sum, row) => sum + row.outcome, 0) / rows.length;
  const brier = rows.reduce((sum, row) => sum + (row.p - row.outcome) ** 2, 0) / rows.length;
  assert.equal(metrics.n, 32);
  assert.equal(metrics.enough, true);
  assert.equal(metrics.brier, Math.round(brier * 1e4) / 1e4);
  assert.equal(metrics.skill, Math.round((1 - brier / (base * (1 - base))) * 1e4) / 1e4);
  journal.log([{ iso3: 'FRA', score: 45 }], store);
  const latest = journal.recent(1)[0];
  assert.deepEqual([latest.p, latest.uncalibrated], [0, false], 'a bin with 20 resolved rows says its observed rate');
  assert.ok(journal.save());
  const reloaded = new PredictionJournal(dir, { now: () => clock });
  assert.equal(reloaded.load(), 'ok');
  assert.deepEqual(reloaded.rows, journal.rows);
});

test('an event that happened inside the horizon but was first seen after it (the server was down) still resolves the row to 1', t => {
  const dir = tempDir(t);
  let clock = NOW;
  const store = new EntityStore(dir, { now: () => clock, retentionDays: 90 });
  const journal = new PredictionJournal(dir, { now: () => clock });
  store.load(); journal.load();
  const SEOUL = [37.57, 126.98];
  assert.equal(journal.log([{ iso3: 'JPN', score: 60 }, { iso3: 'KOR', score: 60 }], store), 2);
  clock = NOW + 9 * DAY; // two days after the 7-day horizon, the first sweep after the downtime
  store.ingest([
    at('earthquake', ...TOKYO, 'high', NOW + 3 * DAY, 9101),   // provider time inside the horizon
    at('earthquake', ...SEOUL, 'high', NOW + 8 * DAY, 9102),   // provider time after the horizon: no event inside it
  ]);
  assert.equal(journal.resolve(store), 2);
  const outcome = Object.fromEntries(journal.recent(2).map(row => [row.iso3, [row.outcome, row.evidence]]));
  assert.deepEqual(outcome.JPN, [1, `event-${(9101).toString(16).padStart(32, '0')}`]);
  assert.deepEqual(outcome.KOR, [0, null]);
});

test('the chain ingest -> score -> log -> resolve is deterministic', t => {
  const run = () => {
    const dir = tempDir(t);
    let clock = NOW;
    const store = new EntityStore(dir, { now: () => clock });
    const journal = new PredictionJournal(dir, { now: () => clock });
    store.load(); journal.load();
    const places = [TOKYO, BUDAPEST, [50.45, 30.52], [15.5, 32.5]];
    const kinds = ['earthquake', 'conflict', 'weather', 'outage', 'news'];
    const levels = ['critical', 'high', 'moderate', 'low'];
    for (let day = 0; day < 12; day++) {
      const events = [];
      for (let i = 0; i < 25; i++) {
        const n = day * 100 + i + 1;
        const [lat, lon] = places[(n * 7) % places.length];
        const kind = kinds[(n * 3) % kinds.length];
        events.push(kind === 'news'
          ? event({ title: `Sudan and Ukraine talks ${n}`, publishedAt: iso(clock - i * HOUR) }, n)
          : at(kind, lat, lon, levels[(n * 5) % levels.length], clock - i * HOUR, n));
      }
      store.ingest(events);
      const scores = scoreCountries({ store, now: clock });
      store.recordScores(scores, clock);
      journal.log(scores, store);
      journal.resolve(store);
      clock += DAY;
    }
    const scores = scoreCountries({ store, now: clock });
    return JSON.stringify({ scores, risk: summarize(scores, journal.calibration(), clock), rows: journal.rows, linked: store.linked('SDN') });
  };
  const first = run();
  assert.ok(first.includes('"SDN"') && first.includes('"outcome":1'), 'the synthetic run scores and resolves');
  assert.ok(first === run(), 'two runs give identical output');
});
