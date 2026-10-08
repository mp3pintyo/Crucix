import { COUNTRIES, countryByIso3, countryDisplayName } from './countries.mjs';

/** Bumped whenever a constant or formula below changes, so stored scores and predictions can be told apart. */
export const RISK_MODEL_VERSION = 2;

/** Physical-activity kinds that count towards a country's events, persistence, diversity and convergence. */
export const RISK_KINDS = Object.freeze(['conflict', 'disaster', 'earthquake', 'weather', 'health', 'outage', 'cyber']);

// ─── model parameters (spec section 4) ───────────────────────────────────────
const HOUR = 3600000;
const DAY = 24 * HOUR;
// Nominal component weights; a missing component is left out and the rest renormalised.
// v2 added the travel advisory (a government's expert reading) and re-cut the weights so that they still sum to 1.
const WEIGHTS = Object.freeze({ events: 0.30, persistence: 0.13, diversity: 0.13, attention: 0.09, forecast: 0.13, baseline: 0.10, advisory: 0.12 });
// Advisory component by level (U.S. State Department 1-4): normal precautions 0, increased caution 25, reconsider travel 60, do not travel 100.
const ADVISORY_VALUE = Object.freeze({ 1: 0, 2: 25, 3: 60, 4: 100 });
// Contribution of one located event by its level; an unknown severity counts like info (an event, no evidence of severity).
const LEVEL_WEIGHT = Object.freeze({ critical: 8, high: 4, watch: 1, info: 0.25 });
const UNKNOWN_WEIGHT = 0.25;
// Events lose half their weight every 12 hours inside the 24-hour window.
const EVENT_HALF_LIFE = 12 * HOUR;
// Saturation of the events component: 100 * (1 - e^(-x / k)); one fresh high event (x = 4) gives about 28.
const EVENT_SATURATION = 12;
// Diversity: the number of distinct kinds at >= high in 24 hours, out of 4 (capped at 100).
const DIVERSITY_KINDS = 4;
// Convergence: at least this many distinct kinds at >= high in 24 hours.
const CONVERGENCE_KINDS = 3;
// Attention: the excess of the last 24 hours' mentions over the previous 6 days' mean, relative to (mean + prior),
// mapped through 100 * (1 - e^(-r / scale)). It needs 7 days of observation, otherwise it is missing.
const ATTENTION_PRIOR = 3;
const ATTENTION_SCALE = 1;
const ATTENTION_DAYS = 7;
// change24h compares with the latest recorded score 24 to 30 hours old; none in that window gives null.
const CHANGE_WINDOW = 6 * HOUR;
// Summary: the top list length and the score counted as high.
const SUMMARY_TOP = 15;
export const HIGH_SCORE = 70;

const KINDS = new Set(RISK_KINDS);
const atLeastHigh = level => level === 'critical' || level === 'high';
const round1 = value => Math.round(value * 10) / 10;
const clamp = value => Math.min(100, Math.max(0, value));
const lookup = (source, key) => source instanceof Map ? source.get(key) : source && typeof source === 'object' && Object.hasOwn(source, key) ? source[key] : undefined;

/** VIEWS month id: (year - 1980) * 12 + month. */
export const viewsMonthId = ms => { const date = new Date(ms); return (date.getUTCFullYear() - 1980) * 12 + date.getUTCMonth() + 1; };

// A forecast entry: a probability, a row with main_dich, or rows by month (the current month's, else the nearest later).
function forecastValue(entry, now) {
  let row = entry;
  if (Array.isArray(entry)) {
    const month = viewsMonthId(now);
    const rows = entry.filter(item => item && Number.isFinite(item.main_dich)).sort((a, b) => (a.month_id ?? 0) - (b.month_id ?? 0));
    row = rows.find(item => item.month_id === month) ?? rows.find(item => (item.month_id ?? 0) > month) ?? rows[0];
  }
  const probability = typeof row === 'number' ? row : row && typeof row === 'object' ? row.main_dich : undefined;
  return Number.isFinite(probability) && probability >= 0 && probability <= 1 ? round1(probability * 100) : null;
}

// A baseline entry: the INFORM score 0-10, as a number or {score|value}.
function baselineValue(entry) {
  const score = typeof entry === 'number' ? entry : entry && typeof entry === 'object' ? entry.score ?? entry.value : undefined;
  return Number.isFinite(score) && score >= 0 && score <= 10 ? round1(score * 10) : null;
}

// An advisory entry: the level 1-4 as a number or {level}.
function advisoryValue(entry) {
  const level = typeof entry === 'number' ? entry : entry && typeof entry === 'object' ? entry.level : undefined;
  return Number.isInteger(level) && Object.hasOwn(ADVISORY_VALUE, level) ? ADVISORY_VALUE[level] : null;
}

function change24h(series, score, now) {
  let previous = null;
  for (const point of series) if (point.at <= now - DAY && point.at >= now - DAY - CHANGE_WINDOW) previous = point;
  return previous ? round1(score - previous.score) : null;
}

function scoreOne(iso3, { store, forecasts, baselines, advisories, now }) {
  const refs = store.countryEvents(iso3, { sinceMs: now - 7 * DAY });
  let events = 0;
  const days = new Set();
  const kinds = new Set();
  for (const ref of refs) {
    if (ref.m !== 'l' || !KINDS.has(ref.k)) continue;
    const age = Math.max(0, now - ref.time);
    if (age < DAY) {
      events += (ref.l ? LEVEL_WEIGHT[ref.l] : UNKNOWN_WEIGHT) * 0.5 ** (age / EVENT_HALF_LIFE);
      if (atLeastHigh(ref.l)) kinds.add(ref.k);
    }
    if (atLeastHigh(ref.l) && age < 7 * DAY) days.add(Math.floor(age / DAY));
  }
  let attention = null;
  if (store.observedDays(now) >= ATTENTION_DAYS) {
    const counts = store.mentionCounts(iso3, ATTENTION_DAYS, now);
    const base = counts.slice(1).reduce((sum, count) => sum + count, 0) / (ATTENTION_DAYS - 1);
    const excess = Math.max(0, counts[0] - base) / (base + ATTENTION_PRIOR);
    attention = round1(100 * (1 - Math.exp(-excess / ATTENTION_SCALE)));
  }
  const values = {
    events: round1(100 * (1 - Math.exp(-events / EVENT_SATURATION))),
    persistence: round1(days.size / 7 * 100),
    diversity: round1(clamp(kinds.size / DIVERSITY_KINDS * 100)),
    attention,
    forecast: forecastValue(lookup(forecasts, iso3), now),
    baseline: baselineValue(lookup(baselines, iso3)),
    advisory: advisoryValue(lookup(advisories, iso3)),
  };
  let total = 0;
  let weight = 0;
  const components = {};
  for (const [name, nominal] of Object.entries(WEIGHTS)) {
    components[name] = { value: values[name], weight: nominal };
    if (values[name] === null) continue;
    total += values[name] * nominal;
    weight += nominal;
  }
  const score = weight > 0 ? Math.round(total / weight) : 0;
  const convergenceKinds = [...kinds].sort();
  return {
    iso3, name: countryByIso3(iso3).name, score, coverage: Math.round(weight * 100) / 100, components,
    convergence: { active: convergenceKinds.length >= CONVERGENCE_KINDS, kinds: convergenceKinds },
    change24h: change24h(store.series(iso3), score, now),
  };
}

/**
 * Scores every country with a reference in the last 7 days or a forecast/baseline entry, highest first (ties by ISO3).
 * Pure given its inputs: the store is only read, `now` is the only clock.
 */
export function scoreCountries({ store, forecasts = null, baselines = null, advisories = null, now }) {
  const candidates = new Set(store.countries(now - 7 * DAY));
  for (const source of [forecasts, baselines, advisories]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of source instanceof Map ? source.keys() : Object.keys(source)) if (countryByIso3(key)) candidates.add(countryByIso3(key).iso3);
  }
  return COUNTRIES.filter(country => candidates.has(country.iso3))
    .map(country => scoreOne(country.iso3, { store, forecasts, baselines, advisories, now }))
    .sort((a, b) => b.score - a.score || (a.iso3 < b.iso3 ? -1 : 1));
}

/** The compact `snapshot.risk` summary; `displayName` is the country name in the server `language` (display only). */
export function summarize(scores, calibration = null, now = Date.now(), extras = null, language = 'en') {
  const list = Array.isArray(scores) ? scores : [];
  const displayOf = (iso3, name) => countryDisplayName(iso3, language) ?? name;
  return {
    version: RISK_MODEL_VERSION,
    at: new Date(now).toISOString(),
    top: list.slice(0, SUMMARY_TOP).map(({ iso3, name, score, change24h: change, coverage, convergence }) => ({ iso3, name, displayName: displayOf(iso3, name), score, change24h: change, coverage, convergence })),
    counts: { scored: list.length, high: list.filter(row => row.score >= HIGH_SCORE).length },
    calibration: calibration ? { n: calibration.n, brier: calibration.brier, skill: calibration.skill } : null,
    // Optional (2.23): the unusual-activity list and the trending terms; absent in a summary written by an older version.
    ...(extras && Array.isArray(extras.anomalies) ? { anomalies: extras.anomalies.map(row => ({ ...row, displayName: displayOf(row.iso3, row.name) })) } : {}),
    ...(extras && extras.spikes && typeof extras.spikes === 'object' ? { spikes: extras.spikes } : {}),
  };
}
