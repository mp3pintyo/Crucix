// Safecast — Global radiation monitoring (150M+ readings)
// No auth required. CC0 public domain. Citizen-science network.
//
// api.safecast.org is slow and overloaded (measured 2026-10-02): a successful request takes ~14 s,
// about half of the requests are answered with an instant HTTP 502 and a dense area such as
// Fukushima exceeds 40 s on a wide time window. A sweep has 30 s, so each sweep refreshes
// REFRESH_PER_SWEEP sites in rotation and the others are served from a bounded in-memory cache
// that always reports its age. Devices with a wrong clock upload readings dated 2080, so the
// query has an upper time bound and every reading is checked again here.

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://api.safecast.org';
const MINUTE = 60000, HOUR = 3600000;
const SWEEP_BUDGET_MS = 27000;      // headroom below the orchestrator's 30-second source limit
const REQUEST_TIMEOUT_MS = 24000;
const VIABLE_START_MS = 17000;      // a ~15 s answer cannot arrive if less time than this is left
const RETRY_DELAY_MS = 1500;
const REFRESH_PER_SWEEP = 2;
const MAX_READING_AGE_MS = 72 * HOUR; // measurement time of a reading that still counts as current
const MAX_CACHE_AGE_MS = 3 * HOUR;    // how long a successful check may be reused
const FUTURE_SKEW_MS = 5 * MINUTE;
const ROW_LIMIT = 25;
const ELEVATED_CPM = 100;

// Key nuclear sites to monitor. The dashboard pairs this list with its map markers by index.
export const NUCLEAR_SITES = {
  zaporizhzhia: { lat: 47.51, lon: 34.58, label: 'Zaporizhzhia NPP (Ukraine)', radius: 100 },
  chernobyl: { lat: 51.39, lon: 30.1, label: 'Chernobyl Exclusion Zone', radius: 50 },
  bushehr: { lat: 28.83, lon: 50.89, label: 'Bushehr NPP (Iran)', radius: 100 },
  yongbyon: { lat: 39.8, lon: 125.75, label: 'Yongbyon (North Korea)', radius: 100 },
  fukushima: { lat: 37.42, lon: 141.03, label: 'Fukushima Daiichi', radius: 50 },
  dimona: { lat: 31.0, lon: 35.15, label: 'Dimona (Israel)', radius: 100 },
};
const KEYS = Object.keys(NUCLEAR_SITES);

const CACHE = new Map();    // key -> { checkedAt, rows: [{ value, capturedAt }] }
const ATTEMPTS = new Map(); // key -> time of the last refresh attempt
const FAILURES = new Map(); // key -> message of the last failed refresh

export function resetState() {
  CACHE.clear();
  ATTEMPTS.clear();
  FAILURES.clear();
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function urlFor(site, now) {
  const params = new URLSearchParams({
    latitude: String(site.lat),
    longitude: String(site.lon),
    distance: String(site.radius * 1000), // metres
    unit: 'cpm',
    captured_after: new Date(now - MAX_READING_AGE_MS).toISOString(),
    captured_before: new Date(now + FUTURE_SKEW_MS).toISOString(),
    order: 'captured_at desc',
    limit: String(ROW_LIMIT),
  });
  return `${BASE}/measurements.json?${params}`;
}

// Only bounded, validated fields are cached.
function normalizeRows(data, now) {
  return data.flatMap(row => {
    const value = row?.value;
    const capturedAt = Date.parse(row?.captured_at);
    if (row?.unit !== 'cpm' || !Number.isFinite(value) || value < 0 || !Number.isFinite(capturedAt)
      || capturedAt > now + FUTURE_SKEW_MS) return [];
    return [{ value, capturedAt }];
  }).sort((a, b) => b.capturedAt - a.capturedAt).slice(0, ROW_LIMIT);
}

const retryable = failure => Boolean(failure?.error)
  && (failure.status === undefined || failure.status === 408 || failure.status >= 500);

async function refresh(key, deadline) {
  ATTEMPTS.set(key, Date.now());
  let failure = 'Invalid response';
  for (let attempt = 0; ; attempt++) {
    const left = deadline - Date.now();
    if (attempt > 0 && left < VIABLE_START_MS) break;
    const data = await safeFetch(urlFor(NUCLEAR_SITES[key], Date.now()), {
      timeout: Math.min(REQUEST_TIMEOUT_MS, Math.max(1000, left)), retries: 0, maxBytes: 2 * 1024 * 1024,
    });
    if (Array.isArray(data)) {
      CACHE.set(key, { checkedAt: Date.now(), rows: normalizeRows(data, Date.now()) });
      FAILURES.delete(key);
      return true;
    }
    failure = data?.error || failure;
    if (!retryable(data)) break;
    await delay(RETRY_DELAY_MS);
  }
  FAILURES.set(key, failure);
  return false;
}

function describeSite(key, refreshed, now) {
  const base = { site: NUCLEAR_SITES[key].label, key };
  const entry = CACHE.get(key);
  const failure = FAILURES.get(key);
  if (!entry || now - entry.checkedAt > MAX_CACHE_AGE_MS) {
    CACHE.delete(key);
    return { ...base, status: failure ? 'unavailable' : 'pending', recentReadings: 0, avgCPM: null, maxCPM: null,
      anomaly: false, lastReading: null, checkedAt: null, ageMinutes: null, ...(failure ? { error: failure } : {}) };
  }
  const values = entry.rows
    .filter(row => row.capturedAt >= now - MAX_READING_AGE_MS && row.capturedAt <= now + FUTURE_SKEW_MS);
  const cpm = values.map(row => row.value);
  const avgCPM = cpm.length ? cpm.reduce((a, b) => a + b, 0) / cpm.length : null;
  return {
    ...base,
    status: !cpm.length ? 'no-recent-readings' : refreshed ? 'fresh' : 'cached',
    recentReadings: cpm.length,
    avgCPM,
    maxCPM: cpm.length ? Math.max(...cpm) : null,
    // Normal background: 10-80 CPM. >100 CPM warrants attention.
    anomaly: avgCPM !== null && avgCPM > ELEVATED_CPM,
    lastReading: values.length ? new Date(values[0].capturedAt).toISOString() : null,
    checkedAt: new Date(entry.checkedAt).toISOString(),
    ageMinutes: Math.round((now - entry.checkedAt) / MINUTE),
    ...(failure ? { refreshError: failure } : {}),
  };
}

function signalsFor(sites) {
  const current = sites.filter(site => site.recentReadings > 0);
  const elevated = current.filter(site => site.anomaly);
  if (elevated.length) {
    return elevated.map(site => `ELEVATED RADIATION at ${site.site}: ${site.avgCPM.toFixed(1)} CPM (normal: 10-80${site.status === 'cached' ? `; checked ${site.ageMinutes} min ago` : ''})`);
  }
  if (!current.length) return ['No current radiation readings from any monitored site'];
  const missing = sites.filter(site => !site.recentReadings);
  return [
    `Current readings at ${current.length} of ${sites.length} monitored sites are below the ${ELEVATED_CPM} CPM threshold`,
    ...(missing.length ? [`No current readings: ${missing.map(site => site.site).join(', ')}`] : []),
  ];
}

// Briefing — check radiation levels near key nuclear sites. The sites whose last attempt is
// oldest are refreshed (concurrently); the others keep their cached, age-labelled readings.
export async function briefing() {
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  const due = KEYS.map((key, index) => ({ key, index }))
    .sort((a, b) => (ATTEMPTS.get(a.key) ?? 0) - (ATTEMPTS.get(b.key) ?? 0) || a.index - b.index)
    .slice(0, REFRESH_PER_SWEEP).map(item => item.key);
  const outcomes = await Promise.all(due.map(key => refresh(key, deadline)));
  const refreshed = new Set(due.filter((_key, index) => outcomes[index]));
  const now = Date.now();
  const sites = KEYS.map(key => describeSite(key, refreshed.has(key), now));
  return {
    source: 'Safecast',
    timestamp: new Date(now).toISOString(),
    refreshed: [...refreshed],
    sites,
    signals: signalsFor(sites),
  };
}

if (process.argv[1]?.endsWith('safecast.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
