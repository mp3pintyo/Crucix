// UNHCR Operational Data Portal: sea and land arrivals in Europe along the Mediterranean and Atlantic routes, per receiving country.
// https://data.unhcr.org/population/get/sublocation?geo_id=0&forcesublocation=0&fromDate=<day>&sv_id=100&population_group=4797,4798,5634
// (no key; checked live on 2026-10-08 from Hungary: HTTP 200, 2.5-6.6 KB, 0.2-0.5 s). The portal SUMS the reports since `fromDate`, one row per country
// and group (4797 Mediterranean sea arrivals, 4798 Mediterranean land arrivals, 5634 Atlantic route to Spain), with the date of the newest report and the
// country's centroid. A month's arrivals are therefore the difference of two "since" sums, and asking for a mid-month date would skip that whole month:
// the dates are always the first of a month. Idea and portal parameters from World Monitor's seed-cross-border-arrivals.mjs (koala73/worldmonitor,
// AGPL-3.0); only the arrivals flow is taken (the refugee-stock situations and the DTM internal-displacement source, which needs a key, are not).
// One row per receiving country (at most 12): the arrivals since 1 January, the last complete month and the usual month (the median of the three before).
// A country is "accelerating" (rated moderate) when its last complete month is at least 1,000 and at least twice its usual month, World Monitor's rule;
// otherwise the row is informational. A country's row dates from its newest report (reports come in at different times: Malta's was a month old).
import { safeFetch } from '../utils/fetch.mjs';
import { freshResult, unavailableResult } from '../utils/freshness.mjs';

const SOURCE = 'UNHCR-Arrivals';
const ENDPOINT = 'https://data.unhcr.org/population/get/sublocation';
const PAGE = 'https://data.unhcr.org/en/situations/europe-sea-arrivals';
const QUERY = { geo_id: '0', forcesublocation: '0', sv_id: '100', population_group: '4797,4798,5634' };
const REQUEST = Object.freeze({ timeout: 15000, retries: 0, maxBytes: 1024 * 1024, headers: Object.freeze({ 'User-Agent': 'Mozilla/5.0 (compatible; Crucix/2.x)' }) });
const MONTHS = 5;            // the current partial month and four complete ones
const MAX_ROWS = 12;
const MIN_LAST_MONTH = 1000;
const RATIO = 2;
const CACHE_MS = 6 * 3600000;
const FUTURE_SKEW_MS = 300000;
const NAME = /^[\p{L}][\p{L} .'-]{1,59}$/u;
const state = { key: null, rows: null, at: 0, fetcher: null };
const EXTRAS = {
  attribution: 'UNHCR Operational Data Portal, Europe sea and land arrivals (https://data.unhcr.org)',
  rights: 'UNHCR Operational Data Portal data is published under CC BY 4.0 (check the portal terms); attribution to UNHCR is given. Crucix shows per-country totals only.',
  license: 'CC BY 4.0 (UNHCR Operational Data Portal)',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  summary: 'Sea and land arrivals in Europe (Mediterranean and Atlantic routes) per receiving country, from UNHCR reports: since 1 January, the last complete month and the usual month. A country is rated moderate when its last complete month is at least 1,000 and at least twice its usual month. Counts are what authorities report to UNHCR and can be revised.',
};

const iso = ms => new Date(ms).toISOString();
const day = ms => iso(ms).slice(0, 10);
const median = values => { const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
function failure(error) {
  const reason = typeof error === 'string' ? error.slice(0, 300).replace(/https?:\/\/\S*/gi, '').trim().slice(0, 120) : '';
  return `UNHCR arrivals request failed${reason ? `: ${reason}` : ''}`;
}

/** First days of the current month and the months before it, newest first. */
export function monthStarts(now, count = MONTHS) {
  const date = new Date(now);
  return Array.from({ length: count }, (_, index) => day(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - index, 1)));
}

// One answer's rows summed per country (sea, land and Atlantic groups add up): { name -> { individuals, date, lat, lon } }.
function sumByCountry(answer) {
  const out = new Map();
  if (!answer || !Array.isArray(answer.data) || answer.data.length > 200) return null;
  for (const row of answer.data) {
    const name = typeof row?.geomaster_name === 'string' ? row.geomaster_name.trim() : '';
    const individuals = Number(row?.individuals), date = typeof row?.date === 'string' ? row.date.slice(0, 10) : '';
    if (!NAME.test(name) || !Number.isInteger(individuals) || individuals < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) continue;
    const lat = Number(row.centroid_lat), lon = Number(row.centroid_lon);
    const previous = out.get(name);
    out.set(name, { individuals: (previous?.individuals ?? 0) + individuals, date: previous && previous.date > date ? previous.date : date,
      lat: Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0) ? lat : previous?.lat ?? null, lon: Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0) ? lon : previous?.lon ?? null });
  }
  return out;
}

/**
 * Rows from the answers: `ytd` since 1 January and `since[i]` since the first day of month i (newest first, so since[0] is the current month so far).
 * Month i is since[i] - since[i - 1] (since[-1] = 0), so counts[0] is the partial current month and counts[1] the last complete one.
 */
export function parseArrivals(ytd, since, { now = Date.now() } = {}) {
  const total = sumByCountry(ytd);
  const sums = Array.isArray(since) ? since.map(sumByCountry) : [];
  if (!total || sums.length < MONTHS || sums.some(item => item === null)) return unavailableResult(SOURCE, 'UNHCR arrivals returned an unexpected response', EXTRAS, now);
  const names = new Set([...total.keys(), ...sums.flatMap(item => [...item.keys()])]);
  const countries = [];
  let newest = 0;
  for (const name of names) {
    const sample = total.get(name) ?? sums.map(item => item.get(name)).find(Boolean);
    const cumulative = sums.map(item => item.get(name)?.individuals ?? 0);
    const counts = cumulative.map((value, index) => Math.max(0, value - (index === 0 ? 0 : cumulative[index - 1])));
    const usual = median(counts.slice(2));
    const last = counts[1];
    const reported = Date.parse(`${sample.date}T23:59:59Z`);
    if (reported - now > FUTURE_SKEW_MS) continue;
    newest = Math.max(newest, reported);
    countries.push({ name, year: total.get(name)?.individuals ?? 0, last, usual, thisMonth: counts[0], date: sample.date, lat: sample.lat, lon: sample.lon, accelerating: last >= MIN_LAST_MONTH && last >= RATIO * Math.max(usual, 1) });
  }
  if (!countries.length) return unavailableResult(SOURCE, 'UNHCR arrivals returned no usable country', EXTRAS, now);
  countries.sort((a, b) => b.year - a.year || (a.name < b.name ? -1 : 1));
  const rows = countries.slice(0, MAX_ROWS).map(item => {
    const at = `${item.date}T23:59:59Z`;
    const fmt = value => value.toLocaleString('en-US');
    return { kind: 'displacement', providerId: `arrivals:${item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, source: SOURCE,
      title: `${item.name}: ${fmt(item.year)} sea and land arrivals this year`,
      summary: `UNHCR reports ${fmt(item.year)} sea and land arrivals in ${item.name} since 1 January, ${fmt(item.last)} in the last complete month against a usual ${fmt(Math.round(item.usual))}, and ${fmt(item.thisMonth)} so far this month (newest report ${item.date}).${item.accelerating ? ' The last month is at least twice the usual and at least 1,000: rated moderate.' : ''}`,
      url: PAGE, observedAt: at, publishedAt: at, severity: item.accelerating ? 'moderate' : 'info',
      ...(item.lat !== null && item.lon !== null ? { lat: Math.round(item.lat * 100) / 100, lon: Math.round(item.lon * 100) / 100, locationMethod: 'country-centroid', locationPrecision: 'approximate' } : {}),
      region: item.name, yearToDate: item.year, lastMonth: item.last, usualMonth: Math.round(item.usual) };
  });
  return freshResult(SOURCE, iso(newest), rows, { ...EXTRAS, examinedRecords: names.size }, now);
}

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  const starts = monthStarts(now);
  const key = starts[0];
  if (useCache && state.key === key && state.fetcher === fetcher && now >= state.at && now - state.at < CACHE_MS) return parseArrivals(state.rows.ytd, state.rows.since, { now });
  const request = { ...REQUEST, timeout: Math.max(1, Math.min(REQUEST.timeout, Number(options.timeout) || REQUEST.timeout)) };
  const dates = [`${new Date(now).getUTCFullYear()}-01-01`, ...starts];
  let answers;
  try {
    answers = await Promise.all(dates.map(async date => {
      const reply = await fetcher(`${ENDPOINT}?${new URLSearchParams({ ...QUERY, fromDate: date })}`, request);
      if (reply?.error) throw new Error(reply.error);
      return reply;
    }));
  } catch (error) {
    return unavailableResult(SOURCE, failure(error instanceof Error ? error.message : 'network error'), EXTRAS, now);
  }
  const [ytd, ...since] = answers;
  const result = parseArrivals(ytd, since, { now });
  if (useCache && result.status !== 'error') Object.assign(state, { key, rows: { ytd, since }, at: now, fetcher });
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('unhcr-arrivals.mjs')) {
  const result = await briefing();
  console.log(JSON.stringify({ ...result, observations: result.observations?.map(row => `${row.severity} ${row.title} | last ${row.lastMonth} usual ${row.usualMonth} | ${row.observedAt}`) }, null, 2));
}
