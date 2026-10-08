// Central banks: policy rates of 14 central banks (BIS), the euro short-term rate (ECB €STR) and the ECB's composite indicator of systemic stress (CISS).
// BIS data portal, SDMX JSON, no key: https://stats.bis.org/api/v1/data/WS_CBPOL/{D|M}.<areas>?lastNObservations=<n>&format=sdmx-json (daily series: the newest
// observation of each bank; monthly series: the month ends before it, for the change). ECB Data Portal, no key: data-api.ecb.europa.eu .../EST/... and .../CISS/...
// (format=jsondata). Checked live on 2026-10-08 from Hungary: HTTP 200, 0.2-0.4 s. The idea (BIS policy rates + ECB short rates and the stress index on one panel)
// comes from World Monitor (koala73/worldmonitor, seed-bis-data.mjs, seed-ecb-short-rates.mjs, seed-fsi-eu.mjs); the adapter is Crucix's own.
// A policy rate is a step function: its BIS date is the last day the bank's figure was reported, which can lie weeks back (India: 2026-07-23 on 2026-10-08), so a rate
// row is shown for up to 120 days with that date; the daily €STR and CISS rows only for 10 days. Rows carry no coordinates.
import { safeFetch } from '../utils/fetch.mjs';
import { providerTime, freshness, freshResult, unavailableResult } from '../utils/freshness.mjs';

const SOURCE = 'Central-Banks';
const BIS = 'https://stats.bis.org/api/v1/data/WS_CBPOL';
const ECB = 'https://data-api.ecb.europa.eu/service/data';
const BIS_PAGE = 'https://data.bis.org/topics/CBPOL';
const ESTR_PAGE = 'https://www.ecb.europa.eu/stats/financial_markets_and_interest_rates/euro_short-term_rate/html/index.en.html';
const CISS_PAGE = 'https://data.ecb.europa.eu/data/datasets/CISS/CISS.D.U2.Z0Z.4F.EC.SS_CIN.IDX';
// Hungary first: the sheet is read from Hungary.
const BANKS = Object.freeze([
  ['HU', 'National Bank of Hungary (MNB)'], ['XM', 'European Central Bank'], ['US', 'Federal Reserve'], ['GB', 'Bank of England'], ['JP', 'Bank of Japan'],
  ['CH', 'Swiss National Bank'], ['CN', "People's Bank of China"], ['PL', 'National Bank of Poland'], ['CZ', 'Czech National Bank'], ['RO', 'National Bank of Romania'],
  ['RS', 'National Bank of Serbia'], ['TR', 'Central Bank of Türkiye'], ['IN', 'Reserve Bank of India'], ['BR', 'Central Bank of Brazil'],
]);
const AREAS = BANKS.map(([code]) => code).join('+');
const NAMES = new Map(BANKS);
const RATE_MAX_AGE = 120 * 24 * 3600000;
const DAILY_MAX_AGE = 10 * 24 * 3600000;
const CACHE_MS = 3600000;
const REQUEST = Object.freeze({ timeout: 15000, retries: 0, maxBytes: 2 * 1024 * 1024, headers: Object.freeze({ 'User-Agent': 'Crucix/2.x' }) });
const EXTRAS = {
  attribution: 'Source: Bank for International Settlements (central bank policy rates, data.bis.org) and European Central Bank (€STR and CISS, data.ecb.europa.eu)',
  rights: 'BIS statistics may be reproduced with the source named (BIS terms of use); ECB statistics may be reused with attribution (ECB reuse policy). No endorsement implied.',
  license: 'BIS terms of use (attribution); ECB reuse policy (attribution)',
  licenseUrl: 'https://www.bis.org/terms_conditions.htm',
  summary: 'Policy rates of 14 central banks from the BIS (the date is the last day the bank\'s figure was reported), the ECB euro short-term rate and the ECB composite indicator of systemic stress (CISS, 0 to 1). The CISS rating is Crucix\'s own reading of the level, not an ECB statement.'
};

const num = value => { const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
const r3 = value => Math.round(value * 1000) / 1000;

/**
 * Observations of an SDMX-JSON document as Map(seriesKey -> [{ period, value }] oldest first). `area` is the id of the dimension whose value names the series
 * (REF_AREA for BIS); without it the series are numbered. Handles both the BIS shape (data.dataSets) and the ECB one (dataSets at the top).
 */
export function sdmxSeries(doc, area) {
  const root = doc && typeof doc === 'object' ? (doc.data && typeof doc.data === 'object' ? doc.data : doc) : null;
  const set = root?.dataSets?.[0]?.series, dims = root?.structure?.dimensions;
  if (!set || typeof set !== 'object' || !Array.isArray(dims?.series) || !Array.isArray(dims?.observation)) return null;
  const periods = dims.observation.find(dim => dim?.id === 'TIME_PERIOD')?.values;
  if (!Array.isArray(periods)) return null;
  const areaAt = area ? dims.series.findIndex(dim => dim?.id === area) : -1;
  if (area && areaAt < 0) return null;
  const out = new Map();
  for (const [key, series] of Object.entries(set).slice(0, 200)) {
    const index = key.split(':').map(Number);
    const name = areaAt >= 0 ? dims.series[areaAt].values?.[index[areaAt]]?.id : key;
    if (typeof name !== 'string' || !series?.observations || typeof series.observations !== 'object') continue;
    const list = [];
    for (const [at, cell] of Object.entries(series.observations).slice(0, 400)) {
      const period = periods[Number(at)]?.id, value = num(Array.isArray(cell) ? (typeof cell[0] === 'string' ? Number(cell[0]) : cell[0]) : null);
      if (typeof period === 'string' && value !== null) list.push({ period, value });
    }
    out.set(name, list.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0)));
  }
  return out;
}

const rateRow = (code, name, now, daily, monthly) => {
  const last = daily?.at(-1);
  const observedAt = last ? providerTime(last.period) : null;
  if (!observedAt || Date.parse(observedAt) - now > 300000) return null;
  const month = last.period.slice(0, 7);
  const before = (monthly || []).filter(point => point.period < month)[0]; // the oldest month end of the three: about a quarter of change
  const change = before ? r3(last.value - before.value) : null;
  const verb = change === null || change === 0 ? '' : change > 0 ? `, up ${change} points since the end of ${before.period}` : `, down ${-change} points since the end of ${before.period}`;
  return { kind: 'economic', providerId: `bis:${code}`, source: SOURCE, title: `${name}: policy rate ${last.value}%`,
    summary: `${name} policy rate ${last.value}% as of ${last.period} (BIS, end of period)${verb}${before && change === 0 ? `, unchanged since the end of ${before.period}` : ''}. The date is the last day the bank's figure was reported.`,
    url: BIS_PAGE, observedAt, publishedAt: observedAt, severity: change !== null && Math.abs(change) >= 0.25 ? 'moderate' : 'info',
    policyRate: last.value, ...(change !== null ? { changePp: change } : {}), maxAgeMs: RATE_MAX_AGE };
};

/** CISS reading: Crucix's own thresholds, the level is a prompt to look, not an ECB verdict. */
export const stressSeverity = value => value >= 0.6 ? 'high' : value >= 0.3 ? 'moderate' : 'info';

function dailyRow(id, title, summary, url, point, extra, now) {
  const observedAt = providerTime(point?.period);
  if (!observedAt || Date.parse(observedAt) - now > 300000) return null;
  return { kind: 'economic', providerId: id, source: SOURCE, title, summary, url, observedAt, publishedAt: observedAt, maxAgeMs: DAILY_MAX_AGE, ...extra };
}

/**
 * Result from the four answers { daily, monthly, estr, ciss } (documents or null when a request failed). A part that failed is named in the summary;
 * all four failed is an error.
 */
export function parseCentralBanks(answers, now = Date.now()) {
  const a = answers && typeof answers === 'object' ? answers : {};
  const daily = a.daily ? sdmxSeries(a.daily, 'REF_AREA') : null, monthly = a.monthly ? sdmxSeries(a.monthly, 'REF_AREA') : null;
  const estr = a.estr ? sdmxSeries(a.estr) : null, ciss = a.ciss ? sdmxSeries(a.ciss) : null;
  if (!daily && !estr && !ciss) return unavailableResult(SOURCE, 'BIS and ECB returned no readable answer', EXTRAS, now);
  const rows = [];
  for (const [code, name] of BANKS) {
    const row = rateRow(code, name, now, daily?.get(code), monthly?.get(code));
    if (row) rows.push(row);
  }
  const e = estr ? [...estr.values()][0]?.at(-1) : null;
  if (e) {
    const before = [...estr.values()][0].at(-2);
    const row = dailyRow('ecb:estr', `Euro short-term rate (€STR): ${e.value}%`, `Euro short-term rate (€STR) ${e.value}% on ${e.period} (volume-weighted trimmed mean, ECB)${before ? `; previous day ${before.value}%` : ''}.`, ESTR_PAGE, e, { severity: 'info', policyRate: e.value }, now);
    if (row) rows.push(row);
  }
  const c = ciss ? [...ciss.values()][0]?.at(-1) : null;
  if (c) {
    const value = r3(c.value);
    const row = dailyRow('ecb:ciss', `ECB systemic stress indicator (CISS): ${value}`, `ECB composite indicator of systemic stress (CISS) for the euro area ${value} on ${c.period} (scale 0 to 1, higher is more stress). The rating (moderate from 0.3, high from 0.6) is Crucix's own reading of the level.`, CISS_PAGE, c, { severity: stressSeverity(value), stressIndex: value }, now);
    if (row) rows.push(row);
  }
  const kept = rows.filter(row => freshness(row.observedAt, row.maxAgeMs, now).fresh).map(({ maxAgeMs, ...row }) => row);
  const newest = kept.map(row => row.observedAt).sort().at(-1) ?? null;
  const missing = [['BIS daily', daily], ['BIS monthly', monthly], ['ECB €STR', estr], ['ECB CISS', ciss]].filter(([, value]) => !value).map(([label]) => label);
  const note = missing.length ? ` Warning: ${missing.join(', ')} could not be read, so those figures are missing.` : '';
  return freshResult(SOURCE, newest, kept, { ...EXTRAS, summary: EXTRAS.summary + note, examinedRecords: rows.length }, now);
}

const cache = { at: 0, result: null };

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  if (useCache && cache.result && now >= cache.at && now - cache.at < CACHE_MS) return cache.result;
  const request = { ...REQUEST, timeout: Math.max(1, Math.min(REQUEST.timeout, Number(options.timeout) || REQUEST.timeout)) };
  const get = async url => { try { const reply = await fetcher(url, request); return reply && !reply.error ? reply : null; } catch { return null; } };
  const [daily, monthly, estr, ciss] = await Promise.all([
    get(`${BIS}/D.${AREAS}?lastNObservations=1&format=sdmx-json`),
    get(`${BIS}/M.${AREAS}?lastNObservations=4&format=sdmx-json`),
    get(`${ECB}/EST/B.EU000A2X2A25.WT?format=jsondata&lastNObservations=2`),
    get(`${ECB}/CISS/D.U2.Z0Z.4F.EC.SS_CIN.IDX?format=jsondata&lastNObservations=1`),
  ]);
  const result = parseCentralBanks({ daily, monthly, estr, ciss }, now);
  if (useCache && result.status !== 'error') { cache.at = now; cache.result = result; }
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('central-banks.mjs')) console.log(JSON.stringify(await briefing(), null, 2));
