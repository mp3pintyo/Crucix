import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArrivals, monthStarts, briefing } from '../apis/sources/unhcr-arrivals.mjs';
import { normalizeLiveSources } from '../lib/intelligence/live-sources.mjs';
import { domainOfSource } from '../lib/domains.mjs';

const NOW = Date.parse('2026-10-08T06:00:00Z');
const row = (name, individuals, date, group = '4797', lat = 42.9, lon = 12.3) => ({ geomaster_name: name, individuals: String(individuals), date: `${date}T00:00:00`, centroid_lat: lat, centroid_lon: lon, population_group_id: group });
const answer = rows => ({ data: rows });
// since[i]: arrivals since the first of month i (0 = October so far); per-month counts are the differences.
const answers = (country, cumulative, ytd, date = '2026-10-04') => ({ ytd: answer([row(country, ytd, date)]), since: cumulative.map(value => answer(value ? [row(country, value, date)] : [])) });

test('monthStarts gives the first of the current month and the four before it, newest first', () => {
  assert.deepEqual(monthStarts(NOW), ['2026-10-01', '2026-09-01', '2026-08-01', '2026-07-01', '2026-06-01']);
  assert.deepEqual(monthStarts(Date.parse('2026-01-15T00:00:00Z'), 3), ['2026-01-01', '2025-12-01', '2025-11-01']);
});

test('arrivals: monthly counts are differences of the since-sums, a country is accelerating from 1,000 and twice the usual month, groups add up', () => {
  // Cumulative since month starts [Oct, Sep, Aug, Jul, Jun] = 300, 3300, 4400, 5300, 6000: months 300 (partial), 3000, 1100, 900, 700.
  const accelerating = answers('Italy', [300, 3300, 4400, 5300, 6000], 22736);
  const result = parseArrivals(accelerating.ytd, accelerating.since, { now: NOW });
  assert.equal(result.status, 'ok');
  const italy = result.observations[0];
  assert.deepEqual([italy.lastMonth, italy.usualMonth, italy.yearToDate, italy.severity], [3000, 900, 22736, 'moderate']);
  assert.equal(italy.locationMethod, 'country-centroid');
  assert.equal(italy.observedAt, '2026-10-04T23:59:59Z');
  const calm = answers('Greece', [300, 4900, 9600, 14100, 18500], 29401);
  assert.equal(parseArrivals(calm.ytd, calm.since, { now: NOW }).observations[0].severity, 'info', '4,600 against a usual 4,500 is not accelerating');
  const small = answers('Malta', [10, 50, 55, 58, 60], 110);
  assert.equal(parseArrivals(small.ytd, small.since, { now: NOW }).observations[0].severity, 'info', 'below 1,000 is never accelerating');
  const grouped = parseArrivals(answer([row('Spain', 100, '2026-09-30', '4797'), row('Spain', 50, '2026-09-28', '5634'), row('Spain', 20, '2026-10-01', '4798')]), [1, 2, 3, 4, 5].map(() => answer([])), { now: NOW });
  assert.equal(grouped.observations[0].yearToDate, 170);
  assert.equal(grouped.observations[0].observedAt, '2026-10-01T23:59:59Z', 'the newest report of the country');
});

test('arrivals: hostile, reshaped, future-dated and old answers; a failing request keeps the URL out of the error', async () => {
  const empty = [1, 2, 3, 4, 5].map(() => answer([]));
  for (const bad of [null, {}, { data: 'x' }, answer([{ geomaster_name: '<img>', individuals: '5', date: '2026-10-01' }, { geomaster_name: 'Italy', individuals: '-3', date: '2026-10-01' }, { geomaster_name: 'Italy', individuals: '5', date: 'soon' }])]) {
    assert.equal(parseArrivals(bad, empty, { now: NOW }).status, 'error');
  }
  assert.equal(parseArrivals(answer([row('Italy', 5, '2026-12-01')]), empty, { now: NOW }).status, 'error', 'a report from the future is dropped, nothing is left');
  assert.equal(parseArrivals(answer([row('Italy', 5, '2026-07-01')]), empty, { now: NOW }).status, 'stale', 'a three-month-old newest report is expired');
  const failed = await briefing({ fetcher: async () => ({ error: 'HTTP 503 https://data.unhcr.org/secret' }), now: NOW, useCache: false });
  assert.equal(failed.status, 'error');
  assert.ok(!failed.error.includes('https://'));
});

test('briefing asks six first-of-month dates once per six hours, and its rows reach the normalizer and the security lens', async () => {
  const urls = [];
  const fetcher = async url => { urls.push(String(url)); return answer([row('Italy', 100, '2026-10-04')]); };
  const options = offset => ({ fetcher, useCache: true, now: NOW + offset });
  const first = await briefing(options(0));
  assert.equal(first.status, 'ok');
  assert.deepEqual(urls.map(url => new URL(url).searchParams.get('fromDate')), ['2026-01-01', '2026-10-01', '2026-09-01', '2026-08-01', '2026-07-01', '2026-06-01']);
  assert.ok(urls.every(url => new URL(url).searchParams.get('population_group') === '4797,4798,5634'));
  await briefing(options(3600000));
  assert.equal(urls.length, 6, 'inside the cache');
  const normalized = normalizeLiveSources([first], NOW).find(item => item.source === 'UNHCR-Arrivals');
  assert.equal(normalized.observations[0].kind, 'displacement');
  assert.ok(normalized.observations[0].facts.some(fact => fact.label === 'yearToDate'));
  assert.equal(domainOfSource('UNHCR-Arrivals'), 'security');
});
