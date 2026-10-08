// Eurostat for Hungary: inflation (HICP annual rate), unemployment (seasonally adjusted) and real GDP growth (quarter on quarter), each next to the EU27 figure.
// Eurostat dissemination API 1.0 (JSON-stat 2.0), no key: https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/<dataset>?geo=HU&geo=EU27_2020&...
//   prc_hicp_minr (HICP, ECOICOP ver. 2, unit RCH_A, coicop18 TOTAL; the older prc_hicp_manr stopped in 2025), une_rt_m (s_adj SA, age TOTAL, unit PC_ACT, sex T),
//   namq_10_gdp (unit CLV_PCH_PRE, s_adj SCA, na_item B1GQ). Checked live on 2026-10-08 from Hungary: HTTP 200, 0.4 s each. The idea (Eurostat country data on a country
//   card) comes from World Monitor (koala73/worldmonitor, seed-eurostat-country-data.mjs); the adapter is Crucix's own.
// A series' newest value is the newest period at which Hungary has a number; the EU27 figure is the one for the SAME period (or absent), never a different month.
// Provisional values (status "p") are shown as such. The observation time is the last day of the reference period (a month or a quarter). Rows carry no coordinates.
import { safeFetch } from '../utils/fetch.mjs';
import { providerTime, freshResult, unavailableResult } from '../utils/freshness.mjs';

const SOURCE = 'Eurostat-HU';
const BASE = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data';
const PAGE = 'https://ec.europa.eu/eurostat/databrowser/view';
const SERIES = Object.freeze([
  { id: 'hicp', dataset: 'prc_hicp_minr', title: 'Inflation (HICP, annual rate)', label: 'inflation (HICP, annual rate)', query: 'geo=HU&geo=EU27_2020&coicop18=TOTAL&unit=RCH_A', since: months => `sinceTimePeriod=${months(8)}`, moderate: v => v >= 5, high: v => v >= 10 },
  { id: 'unemployment', dataset: 'une_rt_m', title: 'Unemployment rate (seasonally adjusted)', label: 'unemployment rate (seasonally adjusted)', query: 'geo=HU&geo=EU27_2020&s_adj=SA&age=TOTAL&unit=PC_ACT&sex=T', since: months => `sinceTimePeriod=${months(8)}`, moderate: v => v >= 8, high: v => v >= 12 },
  { id: 'gdp', dataset: 'namq_10_gdp', title: 'Real GDP growth (quarter on quarter)', label: 'real GDP growth (quarter on quarter)', query: 'geo=HU&geo=EU27_2020&unit=CLV_PCH_PRE&s_adj=SCA&na_item=B1GQ', since: () => 'sinceTimePeriod=2025-Q1', moderate: v => v < 0, high: v => v <= -2 },
]);
const CACHE_MS = 6 * 3600000;
const REQUEST = Object.freeze({ timeout: 15000, retries: 0, maxBytes: 1024 * 1024, headers: Object.freeze({ 'User-Agent': 'Crucix/2.x' }) });
const EXTRAS = {
  attribution: 'Source: Eurostat (ec.europa.eu/eurostat)',
  rights: 'Eurostat data may be reused free of charge, with the source acknowledged (Commission Decision 2011/833/EU).',
  license: 'Eurostat reuse policy (CC BY 4.0 compatible)',
  licenseUrl: 'https://ec.europa.eu/eurostat/web/main/help/copyright-notice',
  summary: 'Hungary\'s inflation (HICP annual rate), unemployment rate (seasonally adjusted) and real GDP growth (quarter on quarter) from Eurostat, each with the EU27 figure for the same period. Provisional values are marked. The rating (inflation from 5%, unemployment from 8%, a GDP contraction) is Crucix\'s own reading of the level.'
};

const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Last day of a reference period: "2026-08" -> 2026-08-31, "2026-Q2" -> 2026-06-30 (ISO time), or null. */
export function periodEnd(period) {
  const month = /^(\d{4})-(\d{2})$/.exec(period), quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  const [year, m] = month ? [Number(month[1]), Number(month[2])] : quarter ? [Number(quarter[1]), Number(quarter[2]) * 3] : [0, 0];
  if (!year || m < 1 || m > 12) return null;
  return providerTime(new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10));
}

/** From a JSON-stat document: { period -> { HU, EU, provisionalHU } } for the periods in which Hungary has a value; null when the shape is wrong. */
export function readSeries(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.id) || !Array.isArray(doc.size) || doc.id.length !== doc.size.length || !doc.dimension || typeof doc.value !== 'object' || doc.value === null) return null;
  const geoAt = doc.id.indexOf('geo'), timeAt = doc.id.indexOf('time');
  const geo = doc.dimension.geo?.category?.index, time = doc.dimension.time?.category?.index;
  if (geoAt < 0 || timeAt < 0 || !geo || !time || typeof geo !== 'object' || typeof time !== 'object') return null;
  const stride = doc.size.map((_, i) => doc.size.slice(i + 1).reduce((a, b) => a * b, 1));
  const at = (g, t) => g * stride[geoAt] + t * stride[timeAt];
  const out = {};
  for (const [period, t] of Object.entries(time).slice(0, 80)) {
    const hu = num(doc.value[at(geo.HU, t)]);
    if (hu === null || !periodEnd(period)) continue;
    out[period] = { HU: hu, EU: geo.EU27_2020 === undefined ? null : num(doc.value[at(geo.EU27_2020, t)]), provisional: doc.status?.[at(geo.HU, t)] === 'p' };
  }
  return out;
}

/** `answers` is { hicp, unemployment, gdp } (JSON-stat documents or null). A series that failed is named in the summary; all failed is an error. */
export function parseEurostat(answers, now = Date.now()) {
  const rows = [], failed = [];
  for (const series of SERIES) {
    const read = answers?.[series.id] ? readSeries(answers[series.id]) : null;
    const periods = read ? Object.keys(read).sort() : [];
    if (!periods.length) { failed.push(series.title); continue; }
    const period = periods.at(-1), v = read[period], observedAt = periodEnd(period);
    if (Date.parse(observedAt) - now > 300000) { failed.push(series.title); continue; }
    const severity = series.high(v.HU) ? 'high' : series.moderate(v.HU) ? 'moderate' : 'info';
    rows.push({ kind: 'economic', providerId: `eurostat:${series.id}`, source: SOURCE, title: `Hungary: ${series.label} ${v.HU}% (${period})`,
      summary: `Hungary ${series.label}: ${v.HU}% in ${period}${v.provisional ? ' (provisional)' : ''}${v.EU !== null ? `, the EU27 figure for the same period ${v.EU}%` : ', the EU27 figure for that period is not published yet'}. Eurostat.`,
      url: `${PAGE}/${series.dataset}/default/table`, observedAt, publishedAt: observedAt, severity, hungaryValue: v.HU, ...(v.EU !== null ? { euValue: v.EU } : {}), period });
  }
  if (failed.length === SERIES.length) return unavailableResult(SOURCE, 'Eurostat returned no readable answer', EXTRAS, now);
  const newest = rows.map(row => row.observedAt).sort().at(-1) ?? null;
  const note = failed.length ? ` Warning: ${failed.join(', ')} could not be read.` : '';
  return freshResult(SOURCE, newest, rows, { ...EXTRAS, summary: EXTRAS.summary + note, examinedRecords: rows.length }, now);
}

const cache = { at: 0, result: null };

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  if (useCache && cache.result && now >= cache.at && now - cache.at < CACHE_MS) return cache.result;
  const request = { ...REQUEST, timeout: Math.max(1, Math.min(REQUEST.timeout, Number(options.timeout) || REQUEST.timeout)) };
  // The first period to ask for: `n` months back, as YYYY-MM.
  const months = n => new Date(now - n * 30.5 * 86400000).toISOString().slice(0, 7);
  const answers = {};
  await Promise.all(SERIES.map(async series => {
    try { const reply = await fetcher(`${BASE}/${series.dataset}?${series.query}&${series.since(months)}`, request); answers[series.id] = reply && !reply.error ? reply : null; } catch { answers[series.id] = null; }
  }));
  const result = parseEurostat(answers, now);
  if (useCache && result.status !== 'error') { cache.at = now; cache.result = result; }
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('eurostat-hu.mjs')) console.log(JSON.stringify(await briefing(), null, 2));
