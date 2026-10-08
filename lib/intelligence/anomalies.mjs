// Unusual activity per country: the located physical events of the last 24 hours against the same country's own recent history.
// The method is World Monitor's temporal baseline (koala73/worldmonitor, AGPL-3.0, docs/algorithms.mdx "Temporal Baseline Anomaly Detection"):
// Welford's streaming mean and variance, a z-score of the latest observation, medium from 1.5, high from 2, critical from 3, and a minimum of 10
// samples before anything is reported. World Monitor keeps a baseline per weekday and month in Redis for 90 days; Crucix keeps 35 days of event
// references (RISK_RETENTION_DAYS), so the baseline here is the previous 24-hour windows back from now (up to 28), all of them: weekday patterns
// are not modelled, which the panel says. Pure over the entity store: nothing is persisted, nothing is invented while history is short.
import { countryByIso3 } from './countries.mjs';
import { RISK_KINDS } from './risk.mjs';

const DAY = 86400000;
export const ANOMALY = Object.freeze({ maxWindows: 28, minSamples: 10, minCurrent: 3, minExcess: 2, stdFloor: 0.5, thresholds: Object.freeze({ moderate: 1.5, high: 2, critical: 3 }), top: 5 });
const KINDS = new Set(RISK_KINDS);

/** Welford's online mean and standard deviation (population) of a list of numbers. */
export function welford(values) {
  let n = 0, mean = 0, m2 = 0;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    n++;
    const delta = value - mean;
    mean += delta / n;
    m2 += delta * (value - mean);
  }
  return { n, mean, std: n > 0 ? Math.sqrt(m2 / n) : 0 };
}

/** The level of a z-score on the event scale used elsewhere (moderate, high, critical), or null below 1.5. */
export function anomalyLevel(z) {
  if (!Number.isFinite(z)) return null;
  const { thresholds } = ANOMALY;
  return z >= thresholds.critical ? 'critical' : z >= thresholds.high ? 'high' : z >= thresholds.moderate ? 'moderate' : null;
}

const round1 = value => Math.round(value * 10) / 10;

/**
 * Countries whose last-24-hour count of located physical events (RISK_KINDS) is unusual against their own previous 24-hour windows, strongest
 * first, at most `ANOMALY.top`. `store` is an EntityStore. Empty until the store has observed at least minSamples + 1 days.
 */
export function computeAnomalies(store, now) {
  const observed = Math.floor(store.observedDays(now));
  // Window k covers [now - (k + 1) days, now - k days); it is a sample only when the store watched all of it.
  const windows = Math.min(ANOMALY.maxWindows, observed - 1);
  if (windows < ANOMALY.minSamples) return [];
  const found = [];
  for (const iso3 of store.countries(now - (windows + 1) * DAY)) {
    const counts = new Array(windows + 1).fill(0);
    for (const ref of store.countryEvents(iso3, { sinceMs: now - (windows + 1) * DAY, mode: 'l' })) {
      if (!KINDS.has(ref.k)) continue;
      const index = Math.floor((now - ref.time) / DAY);
      if (index >= 0 && index <= windows) counts[index]++;
    }
    const current = counts[0];
    if (current < ANOMALY.minCurrent) continue;
    const { n, mean, std } = welford(counts.slice(1));
    if (n < ANOMALY.minSamples || current - mean < ANOMALY.minExcess) continue;
    const z = (current - mean) / Math.max(std, ANOMALY.stdFloor);
    const level = anomalyLevel(z);
    if (!level) continue;
    found.push({ iso3, name: countryByIso3(iso3)?.name ?? iso3, current, mean: round1(mean), std: round1(std), z: round1(z), level, samples: n });
  }
  return found.sort((a, b) => b.z - a.z || b.current - a.current || (a.iso3 < b.iso3 ? -1 : 1)).slice(0, ANOMALY.top);
}
