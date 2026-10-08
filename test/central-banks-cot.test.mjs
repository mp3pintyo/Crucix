import test from 'node:test';
import assert from 'node:assert/strict';
import { sdmxSeries, parseCentralBanks, stressSeverity, briefing as banks } from '../apis/sources/central-banks.mjs';
import { weeklyPoints, rankOf, parseCot, briefing as cot } from '../apis/sources/cftc-cot.mjs';

const NOW = Date.parse('2026-10-08T17:00:00Z');
// BIS-shaped SDMX JSON: dims FREQ + REF_AREA, observation dim TIME_PERIOD; `series` is { areaIndex: { timeIndex: value } }.
const bis = (areas, periods, series) => ({ data: { dataSets: [{ series: Object.fromEntries(Object.entries(series).map(([i, obs]) => [`0:${i}`, { observations: Object.fromEntries(Object.entries(obs).map(([t, v]) => [t, [String(v), 0, 0, null]])) }])) }],
  structure: { dimensions: { series: [{ id: 'FREQ', values: [{ id: 'D' }] }, { id: 'REF_AREA', values: areas.map(id => ({ id })) }], observation: [{ id: 'TIME_PERIOD', values: periods.map(id => ({ id })) }] } } } });
const ecb = (periods, values) => ({ dataSets: [{ series: { '0:0:0': { observations: Object.fromEntries(values.map((v, i) => [String(i), [v, 0, 0]])) } } }], structure: { dimensions: { series: [{ id: 'FREQ', values: [{ id: 'B' }] }], observation: [{ id: 'TIME_PERIOD', values: periods.map(id => ({ id })) }] } } });

test('SDMX: BIS and ECB shapes become series by area; broken documents return null', () => {
  const doc = bis(['HU', 'US'], ['2026-09-30', '2026-10-06'], { 0: { 0: 5.5 }, 1: { 1: 3.875 } });
  const map = sdmxSeries(doc, 'REF_AREA');
  assert.deepEqual(map.get('HU'), [{ period: '2026-09-30', value: 5.5 }]);
  assert.deepEqual(map.get('US'), [{ period: '2026-10-06', value: 3.875 }]);
  assert.deepEqual([...sdmxSeries(ecb(['2026-10-06', '2026-10-07'], [2.439, 2.44])).values()][0].map(p => p.value), [2.439, 2.44]);
  assert.equal(sdmxSeries({ nope: 1 }, 'REF_AREA'), null);
  assert.equal(sdmxSeries(doc, 'MISSING_DIM'), null);
});

test('Central banks: a change over the last months is rated moderate from a quarter point, CISS by level, and old daily rows drop', () => {
  const daily = bis(['HU', 'US', 'IN'], ['2026-07-23', '2026-09-30', '2026-10-06'], { 0: { 1: 5.5 }, 1: { 2: 3.875 }, 2: { 0: 5.25 } });
  const monthly = bis(['HU', 'US', 'IN'], ['2026-06', '2026-07', '2026-08'], { 0: { 0: 6.25, 1: 5.75 }, 1: { 0: 3.625, 1: 3.625 }, 2: { 0: 5.25 } });
  const result = parseCentralBanks({ daily, monthly, estr: ecb(['2026-10-06', '2026-10-07'], [2.439, 2.44]), ciss: ecb(['2026-10-07'], [0.35]) }, NOW);
  assert.equal(result.status, 'ok');
  const by = Object.fromEntries(result.observations.map(row => [row.providerId, row]));
  assert.deepEqual([by['bis:HU'].policyRate, by['bis:HU'].changePp, by['bis:HU'].severity], [5.5, -0.75, 'moderate']);
  assert.deepEqual([by['bis:US'].changePp, by['bis:US'].severity], [0.25, 'moderate']);
  assert.equal(by['bis:IN'].changePp, 0);
  assert.equal(by['bis:IN'].severity, 'info');
  assert.deepEqual([by['ecb:estr'].policyRate, by['ecb:ciss'].stressIndex, by['ecb:ciss'].severity], [2.44, 0.35, 'moderate']);
  assert.deepEqual([0.1, 0.3, 0.6].map(stressSeverity), ['info', 'moderate', 'high']);
  const old = parseCentralBanks({ daily: null, monthly: null, estr: ecb(['2026-09-01'], [2.4]), ciss: null }, NOW);
  assert.equal(old.observations.length, 0, 'a daily figure older than 10 days is not shown');
  assert.equal(old.status, 'stale');
});

test('Central banks: one failed request is named in the summary, all failed is an error, the answer is cached an hour', async () => {
  const partial = parseCentralBanks({ daily: null, monthly: null, estr: ecb(['2026-10-07'], [2.44]), ciss: null }, NOW);
  assert.match(partial.summary, /BIS daily, BIS monthly, ECB CISS could not be read/);
  assert.equal(parseCentralBanks({ daily: null, monthly: null, estr: null, ciss: null }, NOW).status, 'error');
  let calls = 0;
  const fetcher = async url => { calls++; return url.includes('/EST/') ? ecb(['2026-10-07'], [2.44]) : { error: 'HTTP 503' }; };
  assert.equal((await banks({ now: NOW, fetcher, useCache: true })).observations.length, 1);
  const before = calls;
  await banks({ now: NOW + 60000, fetcher, useCache: true });
  assert.equal(calls, before);
});

const cftcRow = (code, date, long, short, oi, longKey = 'm_money_positions_long_all', shortKey = 'm_money_positions_short_all') => ({ cftc_contract_market_code: code, report_date_as_yyyy_mm_dd: `${date}T00:00:00.000`, open_interest_all: String(oi), [longKey]: String(long), [shortKey]: String(short) });
const weeks = n => Array.from({ length: n }, (_, i) => new Date(Date.parse('2026-09-29') - i * 7 * 86400000).toISOString().slice(0, 10));

test('COT: net position, week change and rank over a year; extremes are moderate; rows with unreadable numbers are skipped', () => {
  const gold = { code: '088691', long: 'm_money_positions_long_all', short: 'm_money_positions_short_all' };
  const rows = weeks(53).map((date, i) => cftcRow('088691', date, 100000 + (i === 0 ? 50000 : i * 100), 10000, 400000));
  rows.push(cftcRow('088691', '2026-01-01', 'x', 1, 1), { cftc_contract_market_code: '088691' }, cftcRow('999999', '2026-09-29', 1, 1, 1));
  const points = weeklyPoints(rows, gold);
  assert.equal(points.length, 53);
  assert.equal(points.at(-1).date, '2026-09-29');
  assert.equal(rankOf([1, 2, 3, 10]), 100);
  assert.equal(rankOf([10, 2, 3, 1]), 25);
  const result = parseCot({ 'rxbv-e226': rows, 'yw9f-hn96': null }, NOW);
  assert.equal(result.status, 'ok');
  const [row] = result.observations;
  assert.deepEqual([row.providerId, row.netPosition, row.rank52w, row.severity], ['cot:088691', 140000, 100, 'moderate']);
  assert.equal(result.observations.length, 1);
  assert.match(result.summary, /Warning: .*missing/);
});

test('COT: no readable answer is an error, an old report is stale, a failed request is an error, answers are cached six hours', async () => {
  assert.equal(parseCot({ 'rxbv-e226': null, 'yw9f-hn96': null }, NOW).status, 'error');
  const old = weeks(30).map((date, i) => cftcRow('088691', new Date(Date.parse(date) - 60 * 86400000).toISOString().slice(0, 10), 1000 + i, 10, 5000));
  assert.equal(parseCot({ 'rxbv-e226': old, 'yw9f-hn96': [] }, NOW).status, 'stale');
  assert.equal((await cot({ now: NOW, fetcher: async () => ({ error: 'HTTP 500' }) })).status, 'error');
  let calls = 0;
  const fetcher = async () => { calls++; return weeks(30).map(date => cftcRow('088691', date, 1000, 10, 5000)); };
  const first = await cot({ now: NOW, fetcher, useCache: true });
  assert.equal(first.status, 'ok');
  const before = calls;
  await cot({ now: NOW + 3600000, fetcher, useCache: true });
  assert.equal(calls, before);
});
