// UN Comtrade — Global Trade Data
// Public preview endpoint requires no key. Full API needs free registration.
// Tracks commodity trade flows between nations: crude oil, gas, gold, semiconductors, arms.
// Reporter codes: 842 (US), 156 (China), 276 (Germany), 392 (Japan), 826 (UK), 643 (Russia), 356 (India)
// Preview limits: one period per call, at most 500 rows per call, and a rate limit documented as 1 call/s
// but observed at about 1 call per 3 s, counted from the previous response (HTTP 429 above). A 25 s run
// therefore makes ~6-7 calls; a cold cache of the 10 pairs fills within ~2 sweeps.
// Annual data changes rarely, so each reporter/commodity result is cached for 24 hours (and for the
// current previous year); an expired result is served as stale until a refresh succeeds.

import { safeFetch, daysAgo, today } from '../utils/fetch.mjs';

const BASE = 'https://comtradeapi.un.org/public/v1';
const PREVIEW_ROW_CAP = 500;
const PAUSE_MS = 3000;              // after each response: the observed preview rate limit
const RETRY_429_MS = 2500;          // safeFetch does not expose retry-after (observed 1-2 s): fixed wait
const CACHE_TTL_MS = 24 * 3600000;
const RUN_BUDGET_MS = 25000;        // stay inside the 30 s per-source limit of the sweep
const MIN_CALL_MS = 5000;           // do not start a call with less time left than this
const CALL_TIMEOUT_MS = 10000;
const pairCache = new Map();        // `${reporter}:${cmdCode}` -> { at, year, flow }

// Strategic commodity codes (HS classification)
const STRATEGIC_COMMODITIES = {
  '2709': 'Crude Petroleum',
  '2711': 'Natural Gas (LNG & Pipeline)',
  '7108': 'Gold (unwrought/semi-manufactured)',
  '8542': 'Semiconductors (Electronic Integrated Circuits)',
  '93':   'Arms & Ammunition',
  '2844': 'Radioactive Elements (Nuclear)',
  '8471': 'Computers & Processing Units',
  '2701': 'Coal',
  '7601': 'Aluminium (unwrought)',
  '2612': 'Uranium & Thorium Ores',
};

// Key reporter/partner country codes
const COUNTRIES = {
  842: 'United States',
  156: 'China',
  276: 'Germany',
  392: 'Japan',
  826: 'United Kingdom',
  643: 'Russia',
  356: 'India',
  410: 'South Korea',
  158: 'Taiwan',
  380: 'Italy',
};

// Get trade data for a specific reporter, commodity, and period
export async function getTradeData(opts = {}) {
  const {
    reporterCode = 842,        // default: US
    period = new Date().getFullYear(),
    cmdCode = '2709',          // default: crude oil
    flowCode = 'M',            // M = imports, X = exports
    partnerCode = null,        // null = all partners
    timeout = 20000,
    retries = 1,
  } = opts;

  const params = new URLSearchParams({
    reporterCode: String(reporterCode),
    period: String(period),
    cmdCode,
    flowCode,
    // Totals only: no second-partner, customs-procedure or transport-mode breakdown rows
    partner2Code: '0',
    customsCode: 'C00',
    motCode: '0',
  });
  if (partnerCode) params.set('partnerCode', String(partnerCode));

  return safeFetch(`${BASE}/preview/C/A/HS?${params}`, { timeout, retries });
}

// Get bilateral trade between two countries for a commodity
export async function getBilateralTrade(reporter, partner, cmdCode, period) {
  return getTradeData({
    reporterCode: reporter,
    partnerCode: partner,
    cmdCode,
    period: period || new Date().getFullYear(),
  });
}

// Check multiple commodities for a given reporter
async function checkReporterCommodities(reporterCode, commodityCodes, period) {
  const results = [];
  for (const cmdCode of commodityCodes) {
    const data = await getTradeData({
      reporterCode,
      cmdCode,
      period,
      flowCode: 'M', // imports
    });
    results.push({
      commodity: STRATEGIC_COMMODITIES[cmdCode] || cmdCode,
      cmdCode,
      data,
    });
  }
  return results;
}

// Compact a trade record for briefing output
function compactRecord(rec) {
  return {
    reporter: rec.reporterDesc || rec.reporterCode,
    partner: rec.partnerDesc || rec.partnerCode,
    commodity: rec.cmdDesc || rec.cmdCode,
    flow: rec.flowDesc || rec.flowCode,
    value: rec.primaryValue || rec.cifvalue || rec.fobvalue || null,
    quantity: rec.qty || rec.netWgt || null,
    unit: rec.qtyUnitAbbr || rec.qtyUnitDesc || null,
    period: rec.period,
  };
}

// Detect anomalies in trade data (unusually large flows, new partners, etc.)
function detectAnomalies(tradeRecords) {
  const signals = [];
  if (!Array.isArray(tradeRecords) || tradeRecords.length === 0) return signals;

  const values = tradeRecords
    .map(r => r.value)
    .filter(v => typeof v === 'number' && v > 0);

  if (values.length > 2) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = Math.sqrt(values.reduce((a, v) => a + (v - avg) ** 2, 0) / values.length);

    tradeRecords.forEach(r => {
      if (typeof r.value === 'number' && r.value > avg + 2 * stdDev) {
        signals.push(
          `OUTLIER: ${r.commodity} trade with ${r.partner} = $${(r.value / 1e9).toFixed(2)}B ` +
          `(mean: $${(avg / 1e9).toFixed(2)}B)`
        );
      }
    });
  }

  return signals;
}

// Comtrade returns data in different structures; normalize to rows or an error
function previewRows(data) {
  // Trust a status only from safeFetch's own non-2xx failure ("HTTP <status>"), never from a response body
  if (data?.error) return { error: String(data.error).slice(0, 120), ...(data.error === `HTTP ${data.status}` ? { status: data.status } : {}) };
  const records = data?.data || data?.dataset;
  return Array.isArray(records)
    ? { records: records.filter(rec => rec && typeof rec === 'object' && !Array.isArray(rec)) }
    : { error: 'Unexpected Comtrade response' };
}

// The World aggregate (partner code 0) is the sum of all partners, not a partner
const isWorld = rec => {
  const code = String(rec.partnerCode ?? '').trim();
  return (code !== '' && Number(code) === 0) || String(rec.partnerDesc ?? '').trim().toLowerCase() === 'world';
};
const numeric = value => Number.isFinite(value) ? value : 0;

function summarizeFlow(reporter, cmdCode, period, records) {
  // Safety net for breakdown rows: each partner counts once, with its largest value
  const byPartner = new Map();
  for (const rec of records.filter(rec => !isWorld(rec))) {
    const compact = compactRecord(rec);
    const id = rec.partnerCode ?? rec.partnerDesc;
    if (!byPartner.has(id) || numeric(compact.value) > numeric(byPartner.get(id).value)) byPartner.set(id, compact);
  }
  return {
    reporter: COUNTRIES[reporter] || reporter,
    commodity: STRATEGIC_COMMODITIES[cmdCode] || cmdCode,
    cmdCode,
    period,
    topPartners: [...byPartner.values()].sort((a, b) => numeric(b.value) - numeric(a.value)).slice(0, 10),
    totalRecords: records.length,
    capped: records.length >= PREVIEW_ROW_CAP,
  };
}

// Briefing — check recent trade data for key commodities, detect anomalies
export async function briefing(opts = {}) {
  const {
    cache = pairCache,
    clock = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    budgetMs = RUN_BUDGET_MS,
    request = getTradeData,
  } = opts;
  const start = clock();
  // Annual data for the current year never exists yet; ask for the previous year directly
  const prevYear = new Date(start).getUTCFullYear() - 1;

  // Key combinations to check: US imports of strategic commodities
  const keyCommodities = ['2709', '2711', '7108', '8542', '93'];
  const keyReporters = [842, 156]; // US, China

  const tradeFlows = [];
  const signals = [];
  const pairErrors = [];
  const refreshErrors = [];
  let calls = 0;
  let deferred = 0;
  let stale = 0;
  let halted = false;
  let rateLimited = false;

  const left = () => budgetMs - (clock() - start);

  // One preview call; null when cut short by our own budget cap, not by the provider
  const send = async (reporter, cmdCode, period) => {
    calls++;
    const timeout = Math.min(CALL_TIMEOUT_MS, left());
    const data = await request({ reporterCode: reporter, cmdCode, period, flowCode: 'M', timeout, retries: 0 });
    if (timeout < CALL_TIMEOUT_MS && /timed out/i.test(String(data?.error || ''))) return null;
    return previewRows(data);
  };

  // One paced preview call, the pause counted from the previous response; a 429 is retried once if the
  // budget allows. null when not made, cut short by the budget or still rate limited (the pair is deferred).
  const preview = async (reporter, cmdCode, period) => {
    if (left() - (calls ? PAUSE_MS : 0) < MIN_CALL_MS) { halted = true; return null; }
    if (calls) await sleep(PAUSE_MS);
    let result = await send(reporter, cmdCode, period);
    if (result?.status === 429 && left() - RETRY_429_MS >= MIN_CALL_MS) {
      await sleep(RETRY_429_MS);
      result = await send(reporter, cmdCode, period);
    }
    if (result?.status === 429) rateLimited = true;
    if (!result || result.status === 429) { halted = true; return null; }
    return result;
  };

  // Previous year, with at most one fallback to the year before (annual data can lag well into the year)
  const fetchFlow = async (reporter, cmdCode) => {
    let period = prevYear;
    let result = await preview(reporter, cmdCode, period);
    if (result?.records?.length === 0) result = await preview(reporter, cmdCode, --period);
    if (!result || result.error) return result;
    return { flow: result.records.length ? summarizeFlow(reporter, cmdCode, period, result.records) : null };
  };

  for (const reporter of keyReporters) {
    for (const cmdCode of keyCommodities) {
      const key = `${reporter}:${cmdCode}`;
      let entry = cache.get(key);
      const fresh = entry?.year === prevYear && start >= entry.at && start - entry.at < CACHE_TTL_MS;
      if (!fresh) {
        const outcome = halted ? null : await fetchFlow(reporter, cmdCode);
        if (outcome && !outcome.error) {
          entry = { at: start, year: prevYear, flow: outcome.flow };
          cache.set(key, entry);
        } else {
          if (!outcome) deferred++;
          else {
            // A pair with an expired entry keeps serving it: only a pair with no data at all is an error
            (entry ? refreshErrors : pairErrors).push({ reporter: COUNTRIES[reporter] || reporter, commodity: STRATEGIC_COMMODITIES[cmdCode] || cmdCode, cmdCode, error: outcome.error });
          }
          if (entry) stale++;
        }
      }

      const flow = entry?.flow;
      if (flow?.topPartners.length > 0) {
        tradeFlows.push(flow);
        // Run anomaly detection
        signals.push(...detectAnomalies(flow.topPartners));
      }
    }
  }

  const pairs = keyReporters.length * keyCommodities.length;
  const error = !pairErrors.length ? null
    : pairErrors.length === pairs ? `Comtrade unavailable for all ${pairs} pairs: ${pairErrors[0].error}`
    : `Comtrade unavailable for ${pairErrors.length}/${pairs} pairs`;

  return {
    source: 'UN Comtrade',
    timestamp: new Date(start).toISOString(),
    tradeFlows,
    signals: signals.length > 0
      ? signals
      : ['No significant trade anomalies detected in sampled commodities'],
    status: tradeFlows.length > 0 ? 'ok' : error ? 'error' : 'no_data',
    note: 'Comtrade data often lags 1-2 months. Recent periods may be incomplete.' +
      (refreshErrors.length ? ` ${refreshErrors.length}/${pairs} pairs could not be refreshed (${refreshErrors[0].error}).` : '') +
      (deferred ? ` ${deferred}/${pairs} pairs deferred to the next sweep (${rateLimited ? 'rate limited, HTTP 429' : 'time budget'}).` : '') +
      (stale ? ` ${stale}/${pairs} pairs served from an expired cache entry (stale).` : ''),
    // No usable flow and only deferrals (rate limit or budget): never ok, but not an error either
    ...(stale || (!tradeFlows.length && deferred && !error) ? { stale: true } : {}),
    ...(error ? { error, pairErrors } : {}),
    coveredCommodities: STRATEGIC_COMMODITIES,
    coveredCountries: COUNTRIES,
  };
}

// Run standalone
if (process.argv[1]?.endsWith('comtrade.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
