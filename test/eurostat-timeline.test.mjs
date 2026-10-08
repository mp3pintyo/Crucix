import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { periodEnd, readSeries, parseEurostat, briefing as eurostat } from '../apis/sources/eurostat-hu.mjs';
import { computeTimeline } from '../lib/intelligence/timeline.mjs';
import { EntityStore } from '../lib/intelligence/entities.mjs';
import { runRiskStep } from '../lib/intelligence/risk-step.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-10-08T12:30:00Z');
const quiet = { warn() {}, error() {}, log() {}, info() {} };

// JSON-stat with the dimensions geo (EU27_2020, HU) and time; the single-valued dimensions come first as in the real answers.
const stat = (periods, eu, hu, status = {}) => ({ id: ['freq', 'unit', 'geo', 'time'], size: [1, 1, 2, periods.length],
  dimension: { geo: { category: { index: { EU27_2020: 0, HU: 1 } } }, time: { category: { index: Object.fromEntries(periods.map((p, i) => [p, i])) } } },
  value: Object.fromEntries([...eu.map((v, i) => [i, v]), ...hu.map((v, i) => [periods.length + i, v])].filter(([, v]) => v !== null)), status });

test('Eurostat: period ends, the stride maths of a JSON-stat answer, EU27 only for the same period, provisional marks, bad shapes', () => {
  assert.deepEqual([periodEnd('2026-08'), periodEnd('2026-Q2'), periodEnd('2026-13'), periodEnd('x')], ['2026-08-31T00:00:00.000Z', '2026-06-30T00:00:00.000Z', null, null]);
  const series = readSeries(stat(['2026-07', '2026-08', '2026-09'], [3.0, 3.2, null], [1.6, 1.8, null], { 4: 'p' }));
  assert.deepEqual(Object.keys(series), ['2026-07', '2026-08'], 'September has no Hungarian value');
  assert.deepEqual([series['2026-08'].HU, series['2026-08'].EU, series['2026-08'].provisional], [1.8, 3.2, true]);
  assert.equal(readSeries({ id: ['geo'], size: [1, 2] }), null);
  assert.equal(readSeries(null), null);
  const lateEu = readSeries(stat(['2026-07', '2026-08'], [3.0, null], [1.6, 1.8]));
  assert.equal(lateEu['2026-08'].EU, null, 'a missing EU27 value is not replaced by the month before');
});

test('Eurostat: rows with the newest Hungarian value, own rating, a failed series named, all failed an error, cached six hours', async () => {
  const hicp = stat(['2026-07', '2026-08'], [3.0, 3.2], [1.6, 7.0]);
  const gdp = stat(['2026-Q1', '2026-Q2'], [0.1, 0.7], [0.2, -0.4]);
  const result = parseEurostat({ hicp, unemployment: null, gdp }, NOW);
  assert.equal(result.status, 'ok');
  const by = Object.fromEntries(result.observations.map(row => [row.providerId, row]));
  assert.deepEqual([by['eurostat:hicp'].hungaryValue, by['eurostat:hicp'].euValue, by['eurostat:hicp'].severity, by['eurostat:hicp'].period], [7, 3.2, 'moderate', '2026-08']);
  assert.deepEqual([by['eurostat:gdp'].hungaryValue, by['eurostat:gdp'].severity], [-0.4, 'moderate']);
  assert.match(result.summary, /Warning: Unemployment rate \(seasonally adjusted\) could not be read/);
  assert.equal(parseEurostat({ hicp: null, unemployment: null, gdp: null }, NOW).status, 'error');
  assert.equal((await eurostat({ now: NOW, fetcher: async () => ({ error: 'HTTP 500' }) })).status, 'error');
  let calls = 0;
  const fetcher = async () => { calls++; return hicp; };
  assert.equal((await eurostat({ now: NOW, fetcher, useCache: true })).status, 'ok');
  const before = calls;
  await eurostat({ now: NOW + 60000, fetcher, useCache: true });
  assert.equal(calls, before);
});

// A store with events spread over days: `plan` is [daysBack, level, count].
function storeWith(t, plan, since = NOW - 10 * DAY) {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-tl-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new EntityStore(dir, { retentionDays: 35 });
  store.since = since;
  let n = 0;
  for (const [back, level, count] of plan) for (let i = 0; i < count; i++) {
    const at = Math.floor(NOW / DAY) * DAY - back * DAY + 3600000 * (1 + (i % 20));
    store.events.set(`e${++n}`, { c: ['UKR'], m: 'l', l: level, k: 'conflict', o: at, t: at });
  }
  return store;
}

test('Timeline: seven UTC days by level, mentions and old events ignored, trend from the last three complete days against the three before', t => {
  const worse = computeTimeline(storeWith(t, [[0, 'high', 1], [1, 'critical', 2], [2, 'high', 4], [3, 'high', 3], [4, 'high', 1], [5, 'watch', 5], [6, 'info', 2], [9, 'high', 8]]), NOW);
  assert.equal(worse.days.length, 7);
  assert.equal(worse.days.at(-1).day, '2026-10-08');
  assert.deepEqual([worse.days[6].high, worse.days[5].critical, worse.days[4].high, worse.days[1].watch, worse.days[0].info], [1, 2, 4, 5, 2]);
  assert.equal(worse.trend, 'worsening');
  const calm = computeTimeline(storeWith(t, [[1, 'high', 1], [4, 'high', 4], [5, 'critical', 3]]), NOW);
  assert.equal(calm.trend, 'easing');
  const steady = computeTimeline(storeWith(t, [[1, 'high', 2], [2, 'high', 2], [4, 'high', 2]]), NOW);
  assert.equal(steady.trend, 'steady');
  const young = computeTimeline(storeWith(t, [[1, 'high', 2]], NOW - DAY), NOW);
  assert.deepEqual([young.ready, young.trend], [false, null]);
  const mention = storeWith(t, [[1, 'high', 3]]);
  for (const ref of mention.events.values()) ref.m = 'm';
  assert.equal(computeTimeline(mention, NOW).days.reduce((s, d) => s + d.high, 0), 0, 'mentioned (not located) events are not counted');
});

test('the risk step carries the timeline into the summary, and a panel shows it escaped; an older summary shows nothing', t => {
  const store = storeWith(t, [[1, 'high', 2]]);
  const snapshot = { events: [] };
  assert.equal(runRiskStep({ store, snapshot, raw: null, now: NOW, log: quiet }).ok, true);
  assert.equal(snapshot.risk.timeline.days.length, 7);
  const window = {};
  vm.runInContext(readFileSync(new URL('../dashboard/public/risk.js', import.meta.url), 'utf8'), vm.createContext({ window, document: {}, Intl, console }));
  const risk = window.CrucixRisk;
  const base = { version: 2, at: new Date(NOW).toISOString(), top: [], counts: { scored: 0, high: 0 }, calibration: null };
  const html = risk.panelHtml({ ...base, timeline: { ready: true, observedDays: 9, trend: 'worsening', days: [{ day: '2026-10-07', critical: 1, high: 3, watch: 2, info: 9 }, { day: '<img>', critical: 0, high: 0, watch: 0, info: 0 }, { day: '2026-10-08', critical: -1, high: 'x', watch: 0, info: 0 }] } }, { replay: false });
  assert.ok(html.includes('Threat timeline') && html.includes('Trend: worsening') && html.includes('10-07') && html.includes('15 events · 1 critical · 3 high · 2 watch'));
  assert.ok(!html.includes('<img'), 'a day that is not a date is dropped');
  assert.ok(risk.panelHtml({ ...base, timeline: { ready: false, observedDays: 1, trend: null, days: [{ day: '2026-10-08', critical: 0, high: 0, watch: 0, info: 0 }] } }, { replay: false }).includes('Collecting history: 1 of 3 days'));
  assert.ok(!risk.panelHtml(base, { replay: false }).includes('Threat timeline'));
});
