// The country-risk step of a sweep (spec section 7), kept out of server.mjs so that it can be tested on its own.
// Order in a sweep: recordSnapshotEvents -> runRiskStep -> runAlertStep -> archiveSweep, so the alert metrics and the
// archived snapshot both see `snapshot.risk`.
import { scoreCountries, summarize, viewsMonthId } from './risk.mjs';
import { countryByIso2, countryByName } from './countries.mjs';
import { computeAnomalies } from './anomalies.mjs';
import { headlinesOf } from './keywords.mjs';
import { regionsOf } from './thermal.mjs';
import { computeTimeline } from './timeline.mjs';

// State Department spellings the gazetteer does not know, by the name as the adapter hands it over.
const TRAVEL_ALIASES = Object.freeze({ 'The Kyrgyz Republic': 'KGZ', 'Kingdom of Denmark': 'DNK' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const messageOf = error => { try { return String(error instanceof Error ? error.message : error).split('\n')[0].slice(0, 200); } catch { return 'unprintable error'; } };

// A source result the step may use: 'ok', no error and carrying its country map. A failed or missing source gives no
// forecast/baseline at all; the coverage of every score then shows the missing component. A stale result is the source's last good
// payload (kept up to 45 days): the VIEWS forecast for its months and the INFORM release stay valid, so both are used:
// dropping them on a provider outage would make every score jump and fire the change rules.
function usable(source) {
  return object(source) && source.status === 'ok' && !source.error && object(source.countries);
}

// The VIEWS row of the current month (month_id = (year - 1980) * 12 + month), else the nearest forecast month (the
// later one on a tie). main_dich is the probability (0-1) of at least 25 battle-related deaths in the country-month.
export function viewsRowFor(months, now) {
  if (!Array.isArray(months)) return null;
  const target = viewsMonthId(now);
  let best = null;
  for (const row of months) {
    if (!object(row) || !Number.isInteger(row.month_id) || !finite(row.main_dich) || row.main_dich < 0 || row.main_dich > 1) continue;
    const distance = Math.abs(row.month_id - target);
    const bestDistance = best ? Math.abs(best.month_id - target) : Infinity;
    if (distance < bestDistance || (distance === bestDistance && row.month_id > best.month_id)) best = row;
  }
  return best;
}

/**
 * The risk model's inputs from the raw sweep: `forecasts[iso3]` (VIEWS probability 0-1), `baselines[iso3]` (INFORM 0-10)
 * and `sources`, what the country profile shows about them (run/release, attribution, licence, the per-country rows).
 */
export function riskInputs(raw, now) {
  const sources = object(raw) && object(raw.sources) ? raw.sources : {};
  const views = sources['VIEWS-Forecast'];
  const inform = sources['INFORM-Risk'];
  const actors = sources['MISP-Galaxy'];
  const travel = sources['Travel-Advisories'];
  let forecasts = null;
  let baselines = null;
  let advisories = null;
  const meta = { views: null, inform: null, actors: null, advisories: null };
  if (usable(views)) {
    forecasts = {};
    for (const [iso3, entry] of Object.entries(views.countries)) {
      const row = viewsRowFor(entry?.months, now);
      if (row) forecasts[iso3] = row.main_dich;
    }
    meta.views = { run: String(views.run ?? ''), months: Array.isArray(views.months) ? views.months.filter(Number.isInteger) : [],
      monthUsed: viewsMonthId(now), attribution: String(views.attribution ?? ''), license: String(views.license ?? ''), countries: views.countries };
  }
  if (usable(inform)) {
    baselines = {};
    for (const [iso3, entry] of Object.entries(inform.countries)) if (finite(entry?.score) && entry.score >= 0 && entry.score <= 10) baselines[iso3] = entry.score;
    meta.inform = { release: String(inform.release ?? ''), published: String(inform.published ?? ''),
      attribution: String(inform.attribution ?? ''), license: String(inform.license ?? ''), countries: inform.countries };
  }
  // The U.S. State Department travel advisory per country (level 1-4): a score component and context on the sheet. A stale last-good result
  // (kept up to 14 days) is used like the INFORM release: an outage of the feed must not move every score.
  if (usable(travel)) {
    advisories = {};
    const byCode = {};
    for (const [name, entry] of Object.entries(travel.countries)) {
      const iso3 = TRAVEL_ALIASES[name] ?? countryByName(name)?.iso3;
      if (!iso3 || Object.hasOwn(advisories, iso3) || !Number.isInteger(entry?.level) || entry.level < 1 || entry.level > 4) continue;
      advisories[iso3] = entry.level;
      byCode[iso3] = entry;
    }
    meta.advisories = { observedAt: String(travel.observedAt ?? ''), attribution: String(travel.attribution ?? ''), license: String(travel.license ?? ''), countries: byCode };
  }
  // Known adversary groups by attributed country (context only, never part of a score): keyed by the gazetteer's alpha-3 code.
  if (usable(actors)) {
    const countries = {};
    for (const [iso2, entry] of Object.entries(actors.countries)) {
      const country = countryByIso2(iso2);
      if (country && object(entry) && Array.isArray(entry.groups)) countries[country.iso3] = entry;
    }
    meta.actors = { release: String(actors.release ?? ''), attribution: String(actors.attribution ?? ''), license: String(actors.license ?? ''), countries };
  }
  return { forecasts, baselines, advisories, sources: meta };
}

/**
 * Ingests `snapshot.events` into the entity store, scores every country from the store and the VIEWS/INFORM inputs of
 * `raw.sources`, records the score series, resolves due predictions and logs today's, saves both files and sets
 * `snapshot.risk`. Never throws: a failure is logged once and `snapshot.risk` is left out (the dashboard then shows
 * "no data yet" and the alert metrics read null).
 * @returns {{ok: true, at: number, scores: object[], inputs: object} | {ok: false, error: string}}
 */
export function runRiskStep({ store, journal = null, keywords = null, thermal = null, snapshot, raw = null, now = Date.now(), log = console } = {}) {
  try {
    if (!store || !object(snapshot)) throw new Error('no store or snapshot');
    if (!finite(now)) throw new Error('invalid clock');
    store.ingest(Array.isArray(snapshot.events) ? snapshot.events : [], { now });
    const inputs = riskInputs(raw, now);
    const scores = scoreCountries({ store, forecasts: inputs.forecasts, baselines: inputs.baselines, advisories: inputs.advisories, now });
    store.recordScores(scores, now);
    if (journal) {
      journal.resolve(store, now);
      journal.log(scores, store, now);
    }
    store.save(log);
    journal?.save(log);
    // Unusual activity (a Welford z-score against the country's own history) and trending terms: each is optional and never stops the step.
    const extras = {};
    try { extras.timeline = computeTimeline(store, now); } catch (error) { try { log?.warn?.('[Risk] Timeline failed:', messageOf(error)); } catch { /* logging never breaks the sweep */ } }
    try { extras.anomalies = computeAnomalies(store, now); } catch (error) { try { log?.warn?.('[Risk] Anomalies failed:', messageOf(error)); } catch { /* logging never breaks the sweep */ } }
    if (keywords) {
      try {
        keywords.ingest(headlinesOf(snapshot), { now });
        extras.spikes = keywords.detect({ now });
        keywords.save(log);
      } catch (error) { try { log?.warn?.('[Risk] Keywords failed:', messageOf(error)); } catch { /* logging never breaks the sweep */ } }
    }
    // Thermal escalation (FIRMS detections against the same cell's own recent days): optional, only while FIRMS answered with detections.
    if (thermal) {
      try {
        const regions = regionsOf(raw?.sources?.FIRMS);
        if (regions) {
          thermal.ingest(regions, { now });
          extras.thermal = thermal.assess(regions, { now });
          thermal.save(log);
        }
      } catch (error) { try { log?.warn?.('[Risk] Thermal failed:', messageOf(error)); } catch { /* logging never breaks the sweep */ } }
    }
    snapshot.risk = summarize(scores, journal ? journal.calibration() : null, now, extras);
    return { ok: true, at: now, scores, inputs: inputs.sources };
  } catch (error) {
    const message = messageOf(error);
    try { if (object(snapshot)) delete snapshot.risk; } catch { /* a hostile snapshot keeps what it has */ }
    try { log?.error?.('[Risk] Step failed:', message); } catch { /* logging never breaks the sweep */ }
    return { ok: false, error: message };
  }
}
