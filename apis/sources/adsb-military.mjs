// Military air activity from adsb.lol, a community network of ADS-B receivers with open data (ODbL). https://www.adsb.lol/docs/open-data/api/
// Two kinds of rows come out of two kinds of requests (checked live on 2026-10-02):
//   - /v2/mil lists every military-registered aircraft of the world that the network currently sees (239 aircraft, 98 KB, about 75% of
//     them over the United States). It is turned into AGGREGATES: one row per theater (a lat/lon box) with the number of aircraft in it,
//     never one row per aircraft, and the row sits at the centre of the box.
//   - /v2/sqk/7700, /7600 and /7500 list the aircraft that transmit an emergency transponder code (any aircraft, civil or military).
//     Each of them is a row of its own, at its real position.
// The service wants no key (its terms say a key for feeders may be needed one day and ask production users to get in touch) and answers 403
// to a request without a User-Agent or with the plain "node" one (the fetch helper's own agent is fine). It rate-limits hard: measured on
// 2026-10-02, three requests in a burst always pass and a fourth within about three seconds of the previous one gets HTTP 429 (in 5 of 6
// trials it passed after a pause of 8 to 20 seconds). So the list of the world comes first, the two serious emergency codes follow together,
// and the last code waits ten seconds (see briefing). Payload shape: { ac: [...], msg, now, total, ctime, ptime }.
//   - `now` is the provider time in milliseconds (1790974197000 for 2026-10-02T20:49:57Z), the same moment as `ctime`.
//   - An aircraft has hex (ICAO address), flight (callsign, padded with blanks, or placeholders such as "@@@@@@@@"), t (ICAO type, sometimes
//     junk such as "P8 ?"), alt_baro (feet, or the string "ground"), lat/lon, seen_pos (seconds since its position was updated, 0 to about 55
//     on the live list) and seen (seconds since any message). Aircraft heard only through mode S have no lat/lon (a stale lastPosition
//     object instead), and the military list also holds surface vehicles and obstacles (emitter category C1 to C5) and tower beacons (t TWR).
// Only aircraft whose transponder is on are visible: military aircraft that fly with transponders off are not in this data at all.
// Provider text is never used as written: callsigns, types and hex codes must match a strict plain pattern or they are dropped, and the
// input is length-checked before any pattern runs on it, so hostile text cannot cost more than a few hundred characters of work.
import { safeFetch } from '../utils/fetch.mjs';
import { freshness, freshResult, unavailableResult, POLICIES } from '../utils/freshness.mjs';

const SOURCE = 'ADSB-Military';
const API = 'https://api.adsb.lol/v2';
const MIL_URL = `${API}/mil`;
// The map page (a tar1090 fork; globe.adsb.lol redirects here and keeps the query): ?icao=<hex> selects an aircraft, ?lat&lon&zoom centres the map;
// the script reads only the parameters it knows, so the extra ?theater=<id> of an aggregate row (a unique link per row) changes nothing.
const MAP_PAGE = 'https://adsb.lol/';
// The emergency codes in request order (the serious ones first, see briefing): meaning and row severity. 7600 is a radio failure, no attack.
const CODES = new Map([['7700', ['general emergency', 'high']], ['7500', ['unlawful interference (hijacking)', 'high']], ['7600', ['radio failure (lost communications)', 'moderate']]]);
const MAX_AIRCRAFT = 5000; // examined per list (the live military list has about 240)
const MAX_SQUAWK_AIRCRAFT = 200;
const MAX_SQUAWK_ROWS = 20;
const MAX_THEATERS = 12;
const MAX_CONFIGURED = 50;
const MAX_POSITION_AGE_S = 120; // an aircraft whose position is older than this is not current
const SURGE_FACTOR = 3;
const SURGE_MIN_AIRCRAFT = 10;
const MAX_PREVIOUS_AGE_MS = 6 * 3600000; // a previous sweep older than this is no baseline (a paused server, or a very long refresh interval)
const MEMORY_ENTRIES = 64;
const MIN_MS = 946684800000; // 2000-01-01 and 2100-01-01 in milliseconds: a value in seconds or a zero is not a provider time
const MAX_MS = 4102444800000;
const REQUEST = Object.freeze({ timeout: 10000, retries: 0, maxBytes: 2 * 1024 * 1024 });
const BURST = 3; // requests the provider lets through at once: the military list and the first two emergency codes
const PAUSE_MS = 10000; // the wait before every further request
const BUDGET_MS = 26000; // runSource gives a source 30 s; a request that cannot finish within this is not started
const STALLED_EMPTY = 'ADSB-Military received an empty military list: feed stalled?';
const STALLED_NONE = 'ADSB-Military received no airborne aircraft with a current position: feed stalled?';
const RANK = { high: 0, moderate: 1, monitor: 2, info: 3 };
const NOT_AIRCRAFT = new Set(['GND', 'TWR']); // type designators of ground vehicles and tower beacons
const SURFACE_CATEGORIES = ['C1', 'C2', 'C3', 'C4', 'C5']; // ADS-B emitter categories: surface vehicles and obstacles
const SUMMARY = 'Military air activity as seen by the adsb.lol receiver network: per theater, the number of military-registered aircraft that are airborne and reported a position in the last two minutes (an aggregate for the whole box, shown at its centre, not an aircraft position), plus every aircraft anywhere that transmits an emergency transponder code (7700, 7600, 7500). These are ADS-B-visible aircraft only: military aircraft with their transponders off, and areas without receivers, do not appear, so a low count is not proof of low activity.';
const EXTRAS = {
  attribution: 'Contains information from adsb.lol (https://adsb.lol), made available under the Open Data Commons Open Database License (ODbL) v1.0',
  rights: 'The adsb.lol API and all data adsb.lol makes public are licensed under the Open Data Commons Open Database License (ODbL) v1.0: credit adsb.lol and share derived databases alike. The API is free to use today; its terms say that an API key obtained by feeding may be required in the future and ask users who want to use it for production to contact the operator. Only aircraft whose transponder is on are visible: aircraft flying with transponders off are not in the data.',
  license: 'ODbL 1.0',
  licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
  summary: SUMMARY,
};

// The default theaters, the same as publicSources.adsbTheaters in crucix.config.mjs (which documents the boxes and the rules).
export const DEFAULT_THEATERS = Object.freeze([
  { id: 'black-sea', label: 'Black Sea and Ukraine', latMin: 40.5, latMax: 52.5, lonMin: 24, lonMax: 42 },
  { id: 'east-med', label: 'Eastern Mediterranean', latMin: 30, latMax: 38, lonMin: 22, lonMax: 36.5 },
  { id: 'middle-east-gulf', label: 'Middle East and Gulf', latMin: 12, latMax: 38, lonMin: 34, lonMax: 62 },
  { id: 'baltic', label: 'Baltic Sea', latMin: 53.5, latMax: 66, lonMin: 9, lonMax: 30 },
  { id: 'south-china-sea-taiwan', label: 'South China Sea and Taiwan', latMin: 5, latMax: 27, lonMin: 105, lonMax: 124 },
  { id: 'korea', label: 'Korean Peninsula', latMin: 33, latMax: 43, lonMin: 124, lonMax: 131.5 },
  { id: 'central-europe', label: 'Central Europe', latMin: 44, latMax: 53.5, lonMin: 8, lonMax: 24 },
]);

// The count of every theater at the previous sweep, the only state of this source. Keys carry the box, so a changed box is a new theater.
const MEMORY = new Map();

// Provider or configuration text becomes inert plain text: markup, control, bidi and zero-width characters go, whitespace collapses.
// The input is cut to 400 characters BEFORE any regex runs and the tag pattern cannot rescan: linear on hostile text.
const clean = (value, cap) => typeof value === 'string'
  ? value.slice(0, 400).replace(/<[^<>]*>/g, '').replace(/\p{Cf}/gu, '').replace(/[\p{Cc}\s]+/gu, ' ').replace(/[<>]/g, '').trim().slice(0, cap).trim() : '';
// Transport errors become a short reason; a URL or an upstream message never reaches the result.
function failure(error) {
  const reason = typeof error === 'string' ? error.slice(0, 300).replace(/https?:\/\/\S*/gi, '').trim().slice(0, 120) : '';
  return `ADSB-Military request failed${reason ? `: ${reason}` : ''}`;
}

const round3 = value => (Math.round(value * 1000) || 0) / 1000;
const stamp = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const feedTime = value => Number.isFinite(value) && value >= MIN_MS && value <= MAX_MS ? new Date(value).toISOString() : null;
const hexOf = value => typeof value === 'string' && value.length === 6 && /^[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;
// A callsign has at most 8 letters and digits (the list pads it with blanks and sometimes holds placeholders such as "@@@@@@@@"); a type designator 2 to 4.
const callsignOf = value => { const text = typeof value === 'string' ? value.slice(0, 16).trim().toUpperCase() : ''; return /^[A-Z0-9]{2,8}$/.test(text) ? text : ''; };
const typeOf = value => { const text = typeof value === 'string' ? value.slice(0, 8).trim().toUpperCase() : ''; return /^[A-Z0-9]{2,4}$/.test(text) ? text : ''; };
const positioned = a => Number.isFinite(a.lat) && Number.isFinite(a.lon) && Math.abs(a.lat) <= 90 && Math.abs(a.lon) <= 180 && !(a.lat === 0 && a.lon === 0); // 0, 0 is a failed decode
const recent = a => Number.isFinite(a.seen_pos) && a.seen_pos >= 0 && a.seen_pos <= MAX_POSITION_AGE_S;
const surface = a => SURFACE_CATEGORIES.includes(a.category) || typeof a.t === 'string' && a.t.length <= 8 && NOT_AIRCRAFT.has(a.t.trim().toUpperCase());
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

// Theaters: boxes with an id, a label and edges. A box with lonMin > lonMax crosses the antimeridian. Invalid entries and repeated ids are skipped.
// History merges rows with the same kind and link, so every row link carries the theater id (the map ignores the unknown parameter).
function theaterList(list) {
  const input = list === undefined ? DEFAULT_THEATERS : Array.isArray(list) ? list : [];
  const ids = new Set(), out = [];
  for (const raw of input.slice(0, MAX_CONFIGURED)) {
    if (out.length >= MAX_THEATERS) break;
    if (!isObject(raw)) continue;
    const id = typeof raw.id === 'string' && raw.id.length <= 40 && /^[a-z0-9][a-z0-9-]*$/.test(raw.id) ? raw.id : null;
    const { latMin, latMax, lonMin, lonMax } = raw;
    const within = (value, limit) => Number.isFinite(value) && Math.abs(value) <= limit;
    if (!id || ids.has(id) || !within(latMin, 90) || !within(latMax, 90) || !within(lonMin, 180) || !within(lonMax, 180) || !(latMin < latMax) || lonMin === lonMax) continue;
    const lonSpan = lonMin < lonMax ? lonMax - lonMin : lonMax + 360 - lonMin;
    const lat = round3((latMin + latMax) / 2);
    let lon = lonMin + lonSpan / 2;
    if (lon > 180) lon -= 360;
    lon = round3(lon);
    // A map about 1000 px wide shows about 1400 / 2^zoom degrees of longitude.
    const zoom = Math.min(9, Math.max(2, Math.floor(Math.log2(1400 / Math.max(lonSpan, (latMax - latMin) * 1.6)))));
    const url = `${MAP_PAGE}?${new URLSearchParams({ lat: String(lat), lon: String(lon), zoom: String(zoom), theater: id })}`;
    ids.add(id);
    out.push({ id, label: clean(raw.label, 60) || id, latMin, latMax, lonMin, lonMax, lat, lon, key: `${id}|${latMin},${latMax},${lonMin},${lonMax}`, index: out.length, url });
  }
  return out;
}
const inside = (box, lat, lon) => lat >= box.latMin && lat <= box.latMax && (box.lonMin < box.lonMax ? lon >= box.lonMin && lon <= box.lonMax : lon >= box.lonMin || lon <= box.lonMax);

// The aircraft of the military list that count, one per ICAO address (listed twice: the fresher position).
function census(list) {
  const examined = list.slice(0, MAX_AIRCRAFT), unique = new Map();
  for (const a of examined) {
    const item = counted(a);
    if (item && (!unique.has(item.hex) || item.seen < unique.get(item.hex).seen)) unique.set(item.hex, item);
  }
  return { examined, unique };
}
// One aircraft of the military list that counts: airborne, with a fresh position, a usable address, and not a surface vehicle or a beacon.
function counted(a) {
  if (!isObject(a)) return null;
  const hex = hexOf(a.hex);
  if (!hex || !positioned(a) || !recent(a) || a.alt_baro === 'ground' || surface(a)) return null;
  return { hex, lat: a.lat, lon: a.lon, seen: a.seen_pos, type: typeOf(a.t), callsign: callsignOf(a.flight) };
}
// Types by count and then name, callsigns sorted: the same text whatever the order of the list.
function describe(members) {
  const types = new Map(), callsigns = new Set();
  for (const member of members) { if (member.type) types.set(member.type, (types.get(member.type) ?? 0) + 1); if (member.callsign) callsigns.add(member.callsign); }
  const common = [...types].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 3).map(([type, n]) => `${type} (${n})`).join(', ');
  const names = [...callsigns].sort();
  return { types: common, callsigns: names.length ? `${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}` : '' };
}

// An aircraft of an emergency list: the code must be one of the three, the aircraft must have a fresh real position. `feedMs` is the time of that
// list's own answer; the position time is that minus seen_pos.
function emergency(a, feedMs) {
  if (!isObject(a)) return null;
  const code = typeof a.squawk === 'string' && CODES.has(a.squawk) ? a.squawk : null;
  const hex = hexOf(a.hex);
  if (!code || !hex || !positioned(a) || !recent(a) || surface(a)) return null;
  const [meaning, severity] = CODES.get(code);
  const positionMs = Math.round(feedMs - a.seen_pos * 1000);
  const callsign = callsignOf(a.flight), type = typeOf(a.t);
  const altitude = a.alt_baro === 'ground' ? ', on the ground' : Number.isFinite(a.alt_baro) && Math.abs(a.alt_baro) <= 100000 ? `, at ${Math.round(a.alt_baro)} ft` : '';
  const providerId = `sqk:${hex}:${code}`;
  return { positionMs, severity, row: { kind: 'aviation', providerId, title: `Emergency squawk ${code}: ${callsign || hex}`,
    summary: `${callsign ? `Aircraft ${callsign}` : 'An aircraft'} (ICAO address ${hex}${type ? `, type ${type}` : ''}) is transmitting transponder code ${code}: ${meaning}${altitude}. Position reported at ${stamp(positionMs)} UTC (adsb.lol). A transponder code is set by the crew and is not a confirmed emergency: codes are also set by mistake or during tests.`,
    source: SOURCE, url: `${MAP_PAGE}?${new URLSearchParams({ icao: hex })}`, observedAt: new Date(positionMs).toISOString(),
    lat: a.lat, lon: a.lon, locationMethod: 'provider', locationPrecision: 'exact', severity } };
}

// Emergency rows of up to three lists: one per aircraft and code (the freshest position), the serious codes first, newest first, at most 20.
function emergencies(payloads, now) {
  const lists = Array.isArray(payloads) ? payloads.slice(0, CODES.size) : [];
  const found = new Map();
  let failed = 0;
  for (const payload of lists) {
    const feedMs = isObject(payload) && !payload.error && Array.isArray(payload.ac) ? Date.parse(feedTime(payload.now) ?? '') : NaN;
    if (!Number.isFinite(feedMs)) { failed++; continue; }
    for (const a of payload.ac.slice(0, MAX_SQUAWK_AIRCRAFT)) {
      const item = emergency(a, feedMs);
      if (!item || !freshness(new Date(item.positionMs).toISOString(), POLICIES[SOURCE].observationMaxAgeMs, now).fresh) continue;
      const known = found.get(item.row.providerId);
      if (!known || item.positionMs > known.positionMs) found.set(item.row.providerId, item);
    }
  }
  const ranked = [...found.values()].sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.positionMs - a.positionMs || (a.row.providerId < b.row.providerId ? -1 : a.row.providerId > b.row.providerId ? 1 : 0));
  return { rows: ranked.slice(0, MAX_SQUAWK_ROWS).map(item => item.row), cut: Math.max(0, ranked.length - MAX_SQUAWK_ROWS), failed, lists: lists.length };
}

// The previous sweep counts as a baseline only when it is older than this one and at most six hours old.
const comparable = (entry, at) => isObject(entry) && Number.isFinite(entry.at) && Number.isFinite(entry.count) && at > entry.at && at - entry.at <= MAX_PREVIOUS_AGE_MS ? entry : null;
// Records this sweep's counts (the empty theaters as zero) and cleans up: entries that are too old or have no usable shape go, the map is bounded.
function remember(memory, counts, at) {
  for (const [key, entry] of memory) if (!isObject(entry) || !Number.isFinite(entry.at) || at - entry.at > MAX_PREVIOUS_AGE_MS) memory.delete(key);
  for (const [key, count] of counts) {
    const old = memory.get(key);
    if (isObject(old) && old.at >= at) continue; // the same sweep read again, or an older one: keep the earlier base
    memory.delete(key); memory.set(key, { count, at });
  }
  while (memory.size > MEMORY_ENTRIES) memory.delete(memory.keys().next().value);
}

// `milPayload` is the /v2/mil answer, `squawkPayloads` the answers for 7700, 7500 and 7600 (in any order). `previous` is the count memory (a Map; nothing is
// remembered or compared without it): it is read to rate the theaters and then updated, but only by a sweep that came out ok.
export function parseAdsbMilitary(milPayload, squawkPayloads = [], { now = Date.now(), theaters, previous } = {}) {
  const specs = theaterList(theaters);
  if (!specs.length) return unavailableResult(SOURCE, 'No valid theaters configured', EXTRAS, now);
  if (milPayload?.error) return unavailableResult(SOURCE, failure(milPayload.error), EXTRAS, now);
  if (!isObject(milPayload) || !Array.isArray(milPayload.ac)) return unavailableResult(SOURCE, 'ADSB-Military returned an unexpected response', EXTRAS, now);
  const feedAt = feedTime(milPayload.now), feedMs = feedAt ? Date.parse(feedAt) : NaN;
  const memory = previous instanceof Map ? previous : null;

  // A stalled feed: the list is empty (it normally holds 200 aircraft or more), or nothing in it is airborne with a current position. That is no
  // "zero aircraft" to publish as a metric or to remember as a count: the result is an error and the memory is not touched.
  const { examined, unique } = census(milPayload.ac);
  if (!examined.length) return unavailableResult(SOURCE, STALLED_EMPTY, EXTRAS, now);
  if (!unique.size) return unavailableResult(SOURCE, STALLED_NONE, EXTRAS, now);
  const members = specs.map(() => []);
  for (const item of unique.values()) { const theater = specs.findIndex(spec => inside(spec, item.lat, item.lon)); if (theater >= 0) members[theater].push(item); }

  const counts = new Map(specs.map((spec, i) => [spec.key, members[i].length]));
  // Without a provider time there is no row at all (the result is stale): nothing below may format a time that does not exist.
  const theaterRows = specs.flatMap((spec, i) => {
    const count = members[i].length;
    if (!count || !feedAt) return [];
    const base = memory ? comparable(memory.get(spec.key), feedMs) : null;
    const surge = Boolean(base) && count >= SURGE_MIN_AIRCRAFT && count >= SURGE_FACTOR * base.count;
    const { types, callsigns } = describe(members[i]);
    const before = base ? ` Previous sweep (${Math.round((feedMs - base.at) / 60000)} min earlier): ${base.count} aircraft.` : '';
    return [{ count, index: i, row: { kind: 'aviation', providerId: `mil:${spec.id}`, title: `${spec.label}: ${count} military aircraft`,
      summary: `${spec.label} had ${count} military aircraft airborne with a position report from the last two minutes at ${stamp(feedMs)} UTC, from the military-aircraft list of the adsb.lol ADS-B receiver network, inside the box ${spec.latMin} to ${spec.latMax} degrees latitude, ${spec.lonMin} to ${spec.lonMax} degrees longitude. This is an aggregate for the whole box, shown at the box centre; it is not the position of any aircraft.${types ? ` Most common: ${types}.` : ''}${callsigns ? ` Callsigns: ${callsigns}.` : ''}${before} Aircraft with their transponder off are invisible to this count, so it understates real activity.`,
      source: SOURCE, url: spec.url, observedAt: feedAt, lat: spec.lat, lon: spec.lon, locationMethod: 'theater-centre', locationPrecision: 'approximate', region: spec.label,
      severity: surge ? 'monitor' : 'info', aircraft: count, ...(types ? { types } : {}) } }];
  }).sort((a, b) => RANK[a.row.severity] - RANK[b.row.severity] || b.count - a.count || a.index - b.index);

  const alarms = emergencies(squawkPayloads, now);
  const note = alarms.failed ? ` Note: ${alarms.failed} of ${alarms.lists} emergency squawk lookups failed, so emergency rows may be missing.` : '';
  const out = freshResult(SOURCE, feedAt, [...alarms.rows, ...theaterRows.map(item => item.row)], { ...EXTRAS, summary: SUMMARY + note, examinedRecords: examined.length,
    truncatedRecords: Math.max(0, milPayload.ac.length - examined.length) + alarms.cut }, now);
  if (out.status === 'ok') {
    // The alert registry reads this: aircraft in all theaters and outside them.
    out.metrics = { mil_aircraft_total: unique.size };
    if (memory) remember(memory, counts, feedMs);
  }
  return out;
}

// One request for the military list when two sources of a sweep read it at the same time (the provider refuses a fourth request of a burst):
// the answer of the last 20 seconds is handed to every caller. A failed answer is not kept.
let SHARED = null;
export function sharedMilitaryList(get, url = MIL_URL, now = Date.now()) {
  if (SHARED && SHARED.url === url && now - SHARED.at < 20000) return SHARED.promise;
  const promise = get(url).then(reply => { if (!isObject(reply) || reply.error) SHARED = null; return reply; });
  SHARED = { url, at: now, promise };
  return promise;
}
export function resetSharedMilitaryList() { SHARED = null; }
export { theaterList, inside, census, typeOf, feedTime, clean, stamp, MAP_PAGE };

// options: theaters, previous (the count memory), fetcher, timeout; pause (ms before each request after the first three) and budget (ms) are test seams.
export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  if (!theaterList(options.theaters).length) return unavailableResult(SOURCE, 'No valid theaters configured', EXTRAS, now);
  const started = Date.now();
  const fetcher = options.fetcher || safeFetch;
  const request = { ...REQUEST, timeout: Math.max(1, Math.min(10000, Number(options.timeout) || 10000)) };
  const pause = Number.isFinite(options.pause) && options.pause >= 0 ? options.pause : PAUSE_MS;
  const budget = Number.isFinite(options.budget) ? options.budget : BUDGET_MS;
  const get = async url => { try { return await fetcher(url, request); } catch { return { error: 'network error' }; } };
  const settings = { now, theaters: options.theaters, previous: options.previous ?? MEMORY };
  // The military list first, alone: if the provider is going to refuse a request of the burst, it must not be this one.
  // In a real sweep ADSB-Orbits reads the same list: both share one request (see sharedMilitaryList).
  const mil = await (options.shared ?? !options.fetcher ? sharedMilitaryList(get, MIL_URL) : get(MIL_URL));
  // Without a usable military list (an error, another shape, no provider time, a stalled feed: empty or nothing current in it) there is no result
  // to add emergency rows to: ask no further (no three requests, no pause).
  if (!isObject(mil) || mil.error || !Array.isArray(mil.ac) || feedTime(mil.now) === null || !census(mil.ac).unique.size) return parseAdsbMilitary(mil, [], settings);
  const urls = [...CODES.keys()].map(code => `${API}/sqk/${code}`);
  const squawks = await Promise.all(urls.slice(0, BURST - 1).map(get));
  // Further lists wait, one by one, and are skipped (counted as failed) when they could not finish within the time a source has.
  for (const url of urls.slice(BURST - 1)) {
    if (Date.now() - started + pause + request.timeout > budget) { squawks.push({ error: 'skipped' }); continue; }
    if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause));
    squawks.push(await get(url));
  }
  return parseAdsbMilitary(mil, squawks, settings);
}
