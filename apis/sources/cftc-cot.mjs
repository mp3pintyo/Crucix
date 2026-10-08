// CFTC Commitments of Traders: how speculators are positioned in gold, silver, WTI crude, the euro, the S&P 500 E-mini and the 10-year Treasury note.
// CFTC public reporting portal (Socrata), no key: https://publicreporting.cftc.gov/resource/rxbv-e226.json (disaggregated futures and options, combined; managed money)
// and .../yw9f-hn96.json (traders in financial futures; leveraged funds). One request each, the last 53 weeks of 3 contracts. The report is released on Fridays for
// the Tuesday before. Checked live on 2026-10-08 from Hungary: HTTP 200, 0.8 s. The idea (a COT positioning panel) comes from World Monitor (koala73/worldmonitor,
// seed-cot.mjs); the adapter is Crucix's own.
// The figure is the NET position of the speculative group (long minus short, futures and options combined) and its share of open interest, with its rank among the
// last year of weekly values. A very high or low rank is a prompt to look (crowded positioning), not a forecast. Rows carry no coordinates.
import { safeFetch } from '../utils/fetch.mjs';
import { providerTime, freshResult, unavailableResult } from '../utils/freshness.mjs';

const SOURCE = 'CFTC-COT';
const BASE = 'https://publicreporting.cftc.gov/resource';
const PAGE = 'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm';
const INSTRUMENTS = Object.freeze([
  { code: '088691', name: 'Gold', dataset: 'rxbv-e226', group: 'managed money', long: 'm_money_positions_long_all', short: 'm_money_positions_short_all' },
  { code: '084691', name: 'Silver', dataset: 'rxbv-e226', group: 'managed money', long: 'm_money_positions_long_all', short: 'm_money_positions_short_all' },
  { code: '067651', name: 'WTI crude oil', dataset: 'rxbv-e226', group: 'managed money', long: 'm_money_positions_long_all', short: 'm_money_positions_short_all' },
  { code: '099741', name: 'Euro FX', dataset: 'yw9f-hn96', group: 'leveraged funds', long: 'lev_money_positions_long', short: 'lev_money_positions_short' },
  { code: '13874A', name: 'S&P 500 E-mini', dataset: 'yw9f-hn96', group: 'leveraged funds', long: 'lev_money_positions_long', short: 'lev_money_positions_short' },
  { code: '043602', name: '10-year Treasury note', dataset: 'yw9f-hn96', group: 'leveraged funds', long: 'lev_money_positions_long', short: 'lev_money_positions_short' },
]);
const DATASETS = ['rxbv-e226', 'yw9f-hn96'];
const WEEKS = 53; // this week and the 52 before it
const MIN_WEEKS = 26;
const CACHE_MS = 6 * 3600000;
const REQUEST = Object.freeze({ timeout: 20000, retries: 0, maxBytes: 2 * 1024 * 1024, headers: Object.freeze({ 'User-Agent': 'Crucix/2.x' }) });
const EXTRAS = {
  attribution: 'Source: U.S. Commodity Futures Trading Commission, Commitments of Traders (cftc.gov)',
  rights: 'CFTC Commitments of Traders data is published by a U.S. government agency for public use; no endorsement implied.',
  license: 'U.S. government public data (CFTC)',
  licenseUrl: 'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm',
  summary: 'Net position of speculators (managed money in gold, silver and WTI; leveraged funds in the euro, S&P 500 E-mini and 10-year note), futures and options combined, weekly, as of Tuesday. The rank is among the last year of weekly values; a very high or low rank is crowded positioning, not a forecast.'
};

const int = value => { const n = typeof value === 'string' && /^-?\d{1,12}$/.test(value.trim()) ? Number(value) : typeof value === 'number' && Number.isInteger(value) ? value : null; return n; };
const fmt = value => Math.round(value).toLocaleString('en-US');
const ordinal = n => { const m = n % 100, s = m >= 11 && m <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'; return `${n}${s}`; };

/** Weekly points of one contract from a Socrata answer: [{ date, net, openInterest }] oldest first. Rows with unreadable numbers are skipped. */
export function weeklyPoints(rows, instrument) {
  if (!Array.isArray(rows)) return [];
  const out = new Map();
  for (const row of rows.slice(0, 400)) {
    if (!row || typeof row !== 'object' || row.cftc_contract_market_code !== instrument.code) continue;
    const date = typeof row.report_date_as_yyyy_mm_dd === 'string' ? row.report_date_as_yyyy_mm_dd.slice(0, 10) : '';
    const long = int(row[instrument.long]), short = int(row[instrument.short]), openInterest = int(row.open_interest_all);
    if (!providerTime(date) || long === null || short === null || openInterest === null || openInterest <= 0) continue;
    out.set(date, { date, net: long - short, openInterest });
  }
  return [...out.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(-WEEKS);
}

/** Rank (0-100) of the newest value among the series: the share of values at or below it. */
export const rankOf = values => Math.round(values.filter(value => value <= values.at(-1)).length / values.length * 100);

/** `answers` is { 'rxbv-e226': rows, 'yw9f-hn96': rows } (arrays, or null for a failed request). */
export function parseCot(answers, now = Date.now()) {
  const a = answers && typeof answers === 'object' ? answers : {};
  if (DATASETS.every(id => !Array.isArray(a[id]))) return unavailableResult(SOURCE, 'The CFTC returned no readable answer', EXTRAS, now);
  const rows = [], skipped = [];
  for (const instrument of INSTRUMENTS) {
    const points = weeklyPoints(a[instrument.dataset], instrument);
    const last = points.at(-1);
    if (!last) { skipped.push(instrument.name); continue; }
    const observedAt = providerTime(last.date);
    if (Date.parse(observedAt) - now > 300000) continue;
    const previous = points.at(-2);
    const rank = points.length >= MIN_WEEKS ? rankOf(points.map(point => point.net)) : null;
    const share = Math.round(last.net / last.openInterest * 1000) / 10;
    const change = previous ? last.net - previous.net : null;
    const side = last.net >= 0 ? 'net long' : 'net short';
    rows.push({ kind: 'market', providerId: `cot:${instrument.code}`, source: SOURCE,
      title: `${instrument.name}: ${instrument.group} ${side} ${fmt(Math.abs(last.net))} contracts${rank !== null ? ` (${ordinal(rank)} percentile of ${points.length} weeks)` : ''}`,
      summary: `${instrument.name}: ${instrument.group} are ${side} ${fmt(Math.abs(last.net))} contracts, ${Math.abs(share)}% of open interest, as of ${last.date}${change !== null ? `; ${change >= 0 ? '+' : '-'}${fmt(Math.abs(change))} on the week` : ''}${rank !== null ? `; the ${ordinal(rank)} percentile of the last ${points.length} weekly values (about a year)` : ''}. Futures and options combined, from the CFTC Commitments of Traders report.`,
      url: PAGE, observedAt, publishedAt: observedAt, severity: rank !== null && (rank >= 95 || rank <= 5) ? 'moderate' : 'info',
      netPosition: last.net, netShare: share, ...(rank !== null ? { rank52w: rank } : {}) });
  }
  const failed = DATASETS.filter(id => !Array.isArray(a[id]));
  const note = failed.length || skipped.length ? ` Warning: ${[...skipped, ...(failed.length ? ['one of the two CFTC reports failed'] : [])].join(', ')} missing.` : '';
  const newest = rows.map(row => row.observedAt).sort().at(-1) ?? null;
  return freshResult(SOURCE, newest, rows, { ...EXTRAS, summary: EXTRAS.summary + note, examinedRecords: rows.length }, now);
}

const cache = { at: 0, result: null };

const queryOf = dataset => {
  const codes = INSTRUMENTS.filter(instrument => instrument.dataset === dataset);
  const fields = ['report_date_as_yyyy_mm_dd', 'cftc_contract_market_code', 'open_interest_all', ...new Set(codes.flatMap(instrument => [instrument.long, instrument.short]))];
  return `${BASE}/${dataset}.json?${new URLSearchParams({ $limit: String(WEEKS * codes.length + 6), $order: 'report_date_as_yyyy_mm_dd DESC', $select: fields.join(','),
    $where: `futonly_or_combined='Combined' AND cftc_contract_market_code IN (${codes.map(instrument => `'${instrument.code}'`).join(',')})` })}`;
};

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  if (useCache && cache.result && now >= cache.at && now - cache.at < CACHE_MS) return cache.result;
  const request = { ...REQUEST, timeout: Math.max(1, Math.min(REQUEST.timeout, Number(options.timeout) || REQUEST.timeout)) };
  const answers = {};
  await Promise.all(DATASETS.map(async dataset => {
    try { const reply = await fetcher(queryOf(dataset), request); answers[dataset] = Array.isArray(reply) ? reply : null; } catch { answers[dataset] = null; }
  }));
  const result = parseCot(answers, now);
  if (useCache && result.status !== 'error') { cache.at = now; cache.result = result; }
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('cftc-cot.mjs')) console.log(JSON.stringify(await briefing(), null, 2));
