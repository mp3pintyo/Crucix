// NOAA National Hurricane Center / Central Pacific Hurricane Center: active tropical cyclones of the Atlantic and the eastern and central North Pacific.
// https://www.nhc.noaa.gov/CurrentStorms.json (status, no key; 15 KB) and the "NHC tropical weather summary" ArcGIS MapServer (forecast points 5, forecast
// track 6, forecast cone 7; no key; the server generalises the geometry: maxAllowableOffset=0.05 and geometryPrecision=2 turn 177 KB of cone polygons
// into 2 KB). Checked live on 2026-10-08 from Hungary: HTTP 200, 0.4-1 s. The layer idea and the two endpoints come from God's Eye View
// (bilawalsidhu/gods-eye-view, MIT); the adapter is Crucix's own.
// One row per active storm (kind disaster, the storm's position). The forecast track, points and cone go into the result's `geometry` for the map; they
// are not rows. A cone shows the uncertainty of the forecast CENTRE track, not the storm's size or the area it can harm. An empty `activeStorms` list is a
// valid answer ("none now"): the observation time is then the time of the request, because the service states it at request time.
import { safeFetch } from '../utils/fetch.mjs';
import { providerTime, freshResult, unavailableResult } from '../utils/freshness.mjs';

const SOURCE = 'NOAA-NHC';
const STATUS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const GIS = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer';
const PAGE = 'https://www.nhc.noaa.gov/';
const REQUEST = Object.freeze({ timeout: 15000, retries: 0, maxBytes: 1024 * 1024, headers: Object.freeze({ 'User-Agent': 'Crucix/2.x' }) });
const MAX_STORMS = 12;
const MAX_POINTS = 12;
const MAX_RING = 120;
const CACHE_MS = 5 * 60000;
const CLASSES = { TD: 'Tropical depression', STD: 'Subtropical depression', TS: 'Tropical storm', STS: 'Subtropical storm', HU: 'Hurricane', PTC: 'Post-tropical cyclone', PC: 'Post-tropical cyclone' };
const ID = /^(al|ep|cp)(\d{2})(\d{4})$/;
const state = { at: 0, result: null };
const EXTRAS = {
  attribution: 'NOAA/NWS National Hurricane Center and Central Pacific Hurricane Center',
  rights: 'U.S. government public data (NWS public-data terms); no endorsement implied.',
  license: 'U.S. public domain (NOAA/NWS)',
  licenseUrl: 'https://www.weather.gov/disclaimer',
  summary: 'Active tropical cyclones of the Atlantic and the eastern and central North Pacific, with the advisory forecast track and cone for the map. A cone is the uncertainty of the forecast centre track, not the storm size or the area at risk.'
};

const num = value => { const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const r2 = value => Math.round(value * 100) / 100;
const valid = (lat, lon) => lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** Severity by sustained wind (knots): depression, storm, hurricane, major hurricane (Cat 3+), Cat 4+. */
export function severityOf(kt) {
  return kt === null ? 'unknown' : kt >= 113 ? 'critical' : kt >= 96 ? 'high' : kt >= 64 ? 'elevated' : kt >= 34 ? 'moderate' : 'low';
}

/** Rows from CurrentStorms.json: one per active storm, at most 12, with a valid id, a name and a position. */
export function parseStorms(doc, now = Date.now()) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.activeStorms)) return null;
  const storms = [];
  for (const raw of doc.activeStorms.slice(0, MAX_STORMS)) {
    const id = typeof raw?.id === 'string' ? raw.id.toLowerCase() : '';
    const match = ID.exec(id), name = text(raw?.name, 40);
    const lat = num(raw?.latitudeNumeric), lon = num(raw?.longitudeNumeric);
    const observedAt = providerTime(raw?.lastUpdate);
    if (!match || !name || !valid(lat, lon) || !observedAt || Date.parse(observedAt) - now > 300000) continue;
    const kt = num(raw.intensity), mb = num(raw.pressure), dir = num(raw.movementDir), speed = num(raw.movementSpeed);
    const cls = CLASSES[text(raw.classification, 4).toUpperCase()] || 'Tropical cyclone';
    const advisory = raw.publicAdvisory && typeof raw.publicAdvisory.url === 'string' && /^https:\/\/www\.nhc\.noaa\.gov\//.test(raw.publicAdvisory.url) ? raw.publicAdvisory.url : PAGE;
    storms.push({ id, basin: match[1].toUpperCase(), number: Number(match[2]), name, cls, kt, mb, dir, speed, lat, lon, observedAt, advisory });
  }
  return storms;
}

function rowOf(storm) {
  const moving = storm.dir !== null && storm.speed !== null ? `${Math.round(storm.dir)}° at ${Math.round(storm.speed)} kt` : null;
  return { kind: 'disaster', providerId: `nhc:${storm.id}`, source: SOURCE,
    title: `${storm.cls} ${storm.name}${storm.kt !== null ? `: ${storm.kt} kt sustained winds` : ''}`,
    summary: `${storm.cls} ${storm.name} (${storm.id.toUpperCase()}) at ${storm.lat.toFixed(1)}, ${storm.lon.toFixed(1)}${storm.kt !== null ? ` with ${storm.kt} kt sustained winds` : ''}${storm.mb !== null ? ` and ${storm.mb} mb central pressure` : ''}${moving ? `, moving ${moving}` : ''}. Advisory position of the NHC/CPHC; the forecast cone is the uncertainty of the centre track.`,
    url: storm.advisory, observedAt: storm.observedAt, publishedAt: storm.observedAt, severity: severityOf(storm.kt),
    lat: storm.lat, lon: storm.lon, locationMethod: 'provider', locationPrecision: 'exact', region: storm.basin === 'AL' ? 'Atlantic' : storm.basin === 'EP' ? 'Eastern Pacific' : 'Central Pacific',
    stormClass: storm.cls, windKt: storm.kt, pressureMb: storm.mb, ...(moving ? { movement: moving } : {}) };
}

// A GeoJSON ring [[lon, lat], ...] as [[lat, lon], ...], rounded, at most MAX_RING points (the last point is kept).
function ring(coordinates) {
  if (!Array.isArray(coordinates)) return [];
  const pairs = coordinates.filter(c => Array.isArray(c) && valid(num(c[1]), num(c[0]))).map(c => [r2(c[1]), r2(c[0])]);
  if (pairs.length <= MAX_RING) return pairs;
  const step = Math.ceil(pairs.length / MAX_RING), out = pairs.filter((_, index) => index % step === 0);
  if (out[out.length - 1] !== pairs[pairs.length - 1]) out.push(pairs[pairs.length - 1]);
  return out;
}
const keyOf = props => props && typeof props === 'object' && typeof props.basin === 'string' && Number.isInteger(Number(props.stormnum)) ? `${props.basin.toUpperCase()}${Number(props.stormnum)}` : '';

/**
 * Geometry for the map from the three layers' GeoJSON, joined to the active storms by basin and storm number.
 * Returns [{ id, name, track: [[lat, lon]], points: [{ lat, lon, hours, windKt }], cone: [[lat, lon]] }], at most one entry per active storm.
 */
export function parseGeometry(storms, points, track, cone) {
  const byKey = new Map(storms.map(storm => [`${storm.basin}${storm.number}`, { id: storm.id, name: storm.name, track: [], points: [], cone: [] }]));
  const features = doc => doc && Array.isArray(doc.features) ? doc.features.slice(0, 400) : [];
  for (const feature of features(track)) {
    const entry = byKey.get(keyOf(feature?.properties)), g = feature?.geometry;
    if (!entry || !g) continue;
    if (g.type === 'LineString') entry.track = ring(g.coordinates);
    else if (g.type === 'MultiLineString' && Array.isArray(g.coordinates)) entry.track = ring(g.coordinates.flat(1));
  }
  for (const feature of features(cone)) {
    const entry = byKey.get(keyOf(feature?.properties)), g = feature?.geometry;
    if (!entry || !g) continue;
    const outer = g.type === 'Polygon' ? g.coordinates?.[0] : g.type === 'MultiPolygon' ? g.coordinates?.[0]?.[0] : null;
    if (outer) entry.cone = ring(outer);
  }
  for (const feature of features(points)) {
    const entry = byKey.get(keyOf(feature?.properties)), p = feature?.properties, g = feature?.geometry;
    if (!entry || !g || g.type !== 'Point' || !Array.isArray(g.coordinates) || entry.points.length >= MAX_POINTS) continue;
    const lat = num(g.coordinates[1]), lon = num(g.coordinates[0]), hours = num(p?.tau);
    if (valid(lat, lon) && hours !== null && hours >= 0 && hours <= 240) entry.points.push({ lat: r2(lat), lon: r2(lon), hours, windKt: num(p?.maxwind) });
  }
  return [...byKey.values()].map(entry => ({ ...entry, points: entry.points.sort((a, b) => a.hours - b.hours) })).filter(entry => entry.track.length || entry.cone.length || entry.points.length);
}

const query = (layer, fields) => `${GIS}/${layer}/query?${new URLSearchParams({ where: '1=1', outFields: fields, outSR: '4326', maxAllowableOffset: '0.05', geometryPrecision: '2', f: 'geojson' })}`;

export function parseNhc(doc, geometryDocs, now = Date.now()) {
  const storms = parseStorms(doc, now);
  if (!storms) return unavailableResult(SOURCE, 'NHC returned an unexpected response', EXTRAS, now);
  const geometry = geometryDocs ? parseGeometry(storms, geometryDocs.points, geometryDocs.track, geometryDocs.cone) : [];
  const newest = storms.reduce((latest, storm) => Math.max(latest, Date.parse(storm.observedAt)), 0);
  return freshResult(SOURCE, storms.length ? new Date(newest).toISOString() : new Date(now).toISOString(), storms.map(rowOf),
    { ...EXTRAS, activeStorms: storms.length, geometry, geometryAvailable: !storms.length || geometry.length > 0, examinedRecords: storms.length }, now);
}

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  if (useCache && state.result && now >= state.at && now - state.at < CACHE_MS) return state.result;
  const request = { ...REQUEST, timeout: Math.max(1, Math.min(REQUEST.timeout, Number(options.timeout) || REQUEST.timeout)) };
  const get = async url => { const reply = await fetcher(url, request); if (reply?.error) throw new Error(String(reply.error)); return reply; };
  let doc;
  try { doc = await get(STATUS_URL); } catch (error) {
    const reason = (error instanceof Error ? error.message : '').replace(/https?:\/\/\S*/gi, '').trim().slice(0, 120);
    return unavailableResult(SOURCE, `NHC request failed${reason ? `: ${reason}` : ''}`, EXTRAS, now);
  }
  let geometryDocs = null;
  if (Array.isArray(doc?.activeStorms) && doc.activeStorms.length) {
    // The geometry is a bonus: if a layer fails the storms are still reported, without the track or cone.
    const [points, track, cone] = await Promise.all([get(query(5, 'stormnum,basin,tau,maxwind')), get(query(6, 'stormnum,basin')), get(query(7, 'stormnum,basin'))].map(promise => promise.catch(() => null)));
    geometryDocs = points && track && cone ? { points, track, cone } : null;
  }
  const result = parseNhc(doc, geometryDocs, now);
  if (useCache && result.status !== 'error') { state.at = now; state.result = result; }
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('nhc.mjs')) {
  const result = await briefing();
  console.log(JSON.stringify({ ...result, geometry: result.geometry?.map(g => `${g.id} track ${g.track.length} points ${g.points.length} cone ${g.cone.length}`) }, null, 2));
}
