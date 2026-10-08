// Military aircraft that are flying orbits (circles and racetracks), per theater: a sign of surveillance, tanker or command-post flying that a plain
// head count does not show. Built on adsb.lol (ODbL): the military list (/v2/mil, shared with ADSB-Military so a sweep makes one request) and the
// day's position trace of a few aircraft (https://adsb.lol/data/traces/<last two hex digits>/trace_full_<hex>.json; checked live on 2026-10-08 from
// Hungary: 16 traces in parallel, all HTTP 200, 33-760 KB each, 0.3 s in all). The idea comes from God's Eye View's "ask the planet" (bilawalsidhu/
// gods-eye-view, MIT); the detection is Crucix's own.
// Like ADSB-Military this is an AGGREGATE: one row per theater with the number of orbiting aircraft, their types and (when adsbdb knows them) the countries
// they are registered in; no callsign or ICAO address leaves this module. The row sits at the mean centre of the orbits, not at an aircraft.
// An orbit is a track that in the last 120 minutes turned in one direction by at least 720 degrees in total (two full circles or four racetrack ends),
// stayed within 150 km, and ended within 35% of its path length of where it started, at 100 knots or more, with a position from the last 10 minutes.
// Only aircraft that transmit are in the data; an aircraft that flies without a transponder is not seen, and an orbit is no proof of a purpose.
import { safeFetch } from '../utils/fetch.mjs';
import { freshResult, unavailableResult } from '../utils/freshness.mjs';
import { DEFAULT_THEATERS, MAP_PAGE, theaterList, inside, census, typeOf, feedTime, stamp, sharedMilitaryList } from './adsb-military.mjs';

const SOURCE = 'ADSB-Orbits';
const MIL_URL = 'https://api.adsb.lol/v2/mil';
const TRACE_URL = hex => `https://adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`;
const ADSBDB_URL = hex => `https://api.adsbdb.com/v0/aircraft/${hex}`;
const REQUEST = Object.freeze({ timeout: 10000, retries: 0, maxBytes: 2 * 1024 * 1024 });
const MAX_CANDIDATES = 12;
const CONCURRENCY = 4;
const MAX_LOOKUPS = 6;
const WINDOW_S = 120 * 60;
const FRESH_S = 10 * 60;
const MIN_TURN_DEG = 720;
const MAX_EXTENT_KM = 150;
const MAX_RETURN_RATIO = 0.35;
const MIN_GS_KT = 100;
const MIN_POINTS = 20;
const MIN_STEP_KM = 0.5;
const RAD = Math.PI / 180;
const EARTH_KM = 6371.0088;
// Types that fly surveillance, tanker, early-warning or command-post orbits come first in the queue for traces (the rest follow, up to the cap).
const PRIORITY = new Set(['RC13', 'R135', 'E3TF', 'E3CF', 'E3', 'E8', 'E6', 'E6B', 'P8', 'P3', 'EP3', 'E2', 'RQ4', 'MQ9', 'MQ4', 'U2', 'KC35', 'K35R', 'KC10', 'KC46', 'A332', 'B762', 'GLF5', 'C560', 'DH8D', 'B350', 'BE20', 'C130', 'C30J', 'A400']);
const EXTRAS = {
  attribution: 'Contains information from adsb.lol (https://adsb.lol), made available under the Open Data Commons Open Database License (ODbL) v1.0; aircraft registry data from adsbdb (api.adsbdb.com)',
  rights: 'adsb.lol data is licensed under the ODbL 1.0: credit adsb.lol and share derived databases alike. adsbdb publishes no licence; its registry data is looked up for orbiting aircraft only and never stored or redistributed. Only an aggregate per theater is shown.',
  license: 'ODbL 1.0',
  licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
  summary: 'Per theater, the number of military aircraft that flew orbits (circles or racetracks) in the last two hours, from the adsb.lol military list and position traces. An aggregate; an orbit is no proof of a purpose, and aircraft with their transponder off are not seen.',
};

const finite = value => typeof value === 'number' && Number.isFinite(value);
function distanceKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin((lat2 - lat1) * RAD / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin((lon2 - lon1) * RAD / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
  return Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / RAD;
}

/**
 * Does a readsb trace show an orbit? `trace` is the provider's { timestamp (epoch seconds of the first point), trace: [[offset s, lat, lon, alt, gs, ...]] }.
 * Returns { turns, extentKm, minutes, lat, lon } (the centre of the orbit's bounding box) or null.
 */
export function detectOrbit(trace, nowMs) {
  if (!trace || typeof trace !== 'object' || !finite(trace.timestamp) || !Array.isArray(trace.trace) || trace.trace.length > 20000) return null;
  const now = nowMs / 1000;
  const points = [];
  for (const row of trace.trace) {
    if (!Array.isArray(row) || !finite(row[0]) || !finite(row[1]) || !finite(row[2]) || Math.abs(row[1]) > 90 || Math.abs(row[2]) > 180) continue;
    const at = trace.timestamp + row[0];
    if (at < now - WINDOW_S || at > now + 60) continue;
    if (row[3] === 'ground' || (finite(row[4]) && row[4] < MIN_GS_KT)) continue;
    points.push({ at, lat: row[1], lon: row[2] });
  }
  if (points.length < MIN_POINTS || now - points[points.length - 1].at > FRESH_S) return null;
  let path = 0, turn = 0, previousHeading = null;
  let [south, north, west, east] = [90, -90, 180, -180];
  let last = points[0];
  for (const point of points) {
    south = Math.min(south, point.lat); north = Math.max(north, point.lat); west = Math.min(west, point.lon); east = Math.max(east, point.lon);
    const step = distanceKm(last.lat, last.lon, point.lat, point.lon);
    if (step < MIN_STEP_KM) continue;
    const heading = bearing(last.lat, last.lon, point.lat, point.lon);
    if (previousHeading !== null) { let delta = heading - previousHeading; if (delta > 180) delta -= 360; if (delta < -180) delta += 360; turn += delta; }
    previousHeading = heading; path += step; last = point;
  }
  const extentKm = distanceKm(south, west, north, east);
  const returned = distanceKm(points[0].lat, points[0].lon, points[points.length - 1].lat, points[points.length - 1].lon);
  if (Math.abs(turn) < MIN_TURN_DEG || extentKm > MAX_EXTENT_KM || path <= 0 || returned > MAX_RETURN_RATIO * path) return null;
  if (west < -90 && east > 90) return null; // across the antimeridian: not handled, no guess
  return { turns: Math.round(Math.abs(turn) / 360 * 10) / 10, extentKm: Math.round(extentKm), minutes: Math.round((points[points.length - 1].at - points[0].at) / 60),
    lat: Math.round((south + north) / 2 * 100) / 100, lon: Math.round((west + east) / 2 * 100) / 100 };
}

// The aircraft to ask traces for: airborne military aircraft inside a theater, surveillance-class types first, at most MAX_CANDIDATES.
export function pickCandidates(unique, specs) {
  const found = [];
  for (const item of unique.values()) {
    const spec = specs.findIndex(box => inside(box, item.lat, item.lon));
    if (spec >= 0) found.push({ ...item, spec });
  }
  return found.sort((a, b) => (PRIORITY.has(b.type) ? 1 : 0) - (PRIORITY.has(a.type) ? 1 : 0) || (a.hex < b.hex ? -1 : 1)).slice(0, MAX_CANDIDATES);
}

async function inBatches(items, size, work) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(work)));
  return out;
}

/** Rows from the orbiting aircraft: `found` is [{ spec, type, orbit, country? }]; one row per theater. */
export function orbitRows(found, specs, feedAt, feedMs) {
  const rows = [];
  specs.forEach((spec, index) => {
    const here = found.filter(item => item.spec === index);
    if (!here.length) return;
    const lat = Math.round(here.reduce((sum, item) => sum + item.orbit.lat, 0) / here.length * 100) / 100;
    const lon = Math.round(here.reduce((sum, item) => sum + item.orbit.lon, 0) / here.length * 100) / 100;
    const tally = key => { const map = new Map(); for (const item of here) if (item[key]) map.set(item[key], (map.get(item[key]) ?? 0) + 1); return [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4).map(([name, n]) => `${name} (${n})`).join(', '); };
    const types = tally('type'), countries = tally('country');
    const longest = Math.max(...here.map(item => item.orbit.minutes));
    rows.push({ kind: 'aviation', providerId: `orbit:${spec.id}`, source: SOURCE,
      title: `${spec.label}: ${here.length} military aircraft flying orbits`,
      summary: `${here.length} military aircraft in ${spec.label} flew orbits (circles or racetracks, at least two full turns within 150 km) in the last two hours, seen at ${stamp(feedMs)} UTC${types ? `; types ${types}` : ''}${countries ? `; registered in ${countries}` : ''}; the longest track covers ${longest} minutes. Positions are those of the adsb.lol receiver network; an orbit is no proof of a purpose and aircraft with their transponder off are not seen.`,
      url: `${spec.url}&view=orbits`, observedAt: feedAt, lat, lon, locationMethod: 'orbit-centre', locationPrecision: 'approximate', region: spec.label,
      severity: here.length >= 2 ? 'monitor' : 'info', aircraft: here.length, ...(types ? { types } : {}), ...(countries ? { operators: countries } : {}) });
  });
  return rows;
}

const countryOf = reply => { const name = reply?.response?.aircraft?.registered_owner_country_name; return typeof name === 'string' && /^[\p{L} .'-]{2,40}$/u.test(name) ? name : ''; };

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const request = { ...REQUEST, timeout: Math.max(1, Math.min(10000, Number(options.timeout) || 10000)) };
  const specs = theaterList(options.theaters ?? DEFAULT_THEATERS);
  if (!specs.length) return unavailableResult(SOURCE, 'No valid theaters configured', EXTRAS, now);
  const get = async url => { try { return await fetcher(url, request); } catch { return { error: 'network error' }; } };
  const shared = options.shared ?? !options.fetcher;
  const mil = await (shared ? sharedMilitaryList(get, MIL_URL) : get(MIL_URL));
  const feedAt = mil && !mil.error ? feedTime(mil.now) : null;
  if (!mil || mil.error || !Array.isArray(mil.ac) || !feedAt) return unavailableResult(SOURCE, 'ADSB-Orbits could not read the military list', EXTRAS, now);
  const { unique } = census(mil.ac);
  if (!unique.size) return unavailableResult(SOURCE, 'ADSB-Orbits received no airborne military aircraft with a current position: feed stalled?', EXTRAS, now);
  const feedMs = Date.parse(feedAt);
  const candidates = pickCandidates(unique, specs);
  const traces = await inBatches(candidates, CONCURRENCY, async item => ({ item, orbit: detectOrbit(await get(TRACE_URL(item.hex)), feedMs) }));
  const orbiting = traces.filter(entry => entry.orbit).map(entry => ({ spec: entry.item.spec, type: typeOf(entry.item.type), orbit: entry.orbit, hex: entry.item.hex }));
  // Registry lookups for the orbiting aircraft only, best effort and silent: the country they are registered in.
  const lookups = await inBatches(orbiting.slice(0, MAX_LOOKUPS), CONCURRENCY, async entry => countryOf(await get(ADSBDB_URL(entry.hex))));
  const found = orbiting.map((entry, index) => ({ spec: entry.spec, type: entry.type, orbit: entry.orbit, country: lookups[index] || '' }));
  const rows = orbitRows(found, specs, feedAt, feedMs);
  return freshResult(SOURCE, feedAt, rows, { ...EXTRAS, examinedRecords: candidates.length, truncatedRecords: Math.max(0, unique.size - candidates.length), orbitingAircraft: orbiting.length }, now);
}

// Run standalone
if (process.argv[1]?.endsWith('adsb-orbits.mjs')) {
  const result = await briefing();
  console.log(JSON.stringify({ ...result, observations: result.observations?.map(row => `${row.severity} ${row.title} | ${row.types || ''} | ${row.operators || ''} | ${row.lat},${row.lon}`) }, null, 2));
}
