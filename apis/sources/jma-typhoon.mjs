// Japan Meteorological Agency (RSMC Tokyo): active tropical cyclones of the western North Pacific.
// https://www.jma.go.jp/bosai/typhoon/data/targetTc.json lists the active systems; https://www.jma.go.jp/bosai/typhoon/data/<TCxxxx>/specifications.json holds
// the advisory: the analysis (position, sustained wind, pressure, speed) and the forecast positions 12 to 120 hours ahead. No key; checked live on 2026-10-08
// from Hungary: HTTP 200, 0.8 s. The idea (a western Pacific cyclone layer next to the Atlantic one) comes from World Monitor (koala73/worldmonitor,
// scripts/natural/western-pacific-cyclones.mjs); the adapter is Crucix's own.
// One row per active system (kind disaster, the analysed centre). The forecast positions become `geometry` for the map, in the same shape as NOAA-NHC
// (track + points, no cone: the JMA gives probability circles, not a cone). An empty list is a valid answer ("none now"): the observation time is then
// the time of the request, because the service states it at request time.
import { safeFetch } from '../utils/fetch.mjs';
import { providerTime, freshResult, unavailableResult } from '../utils/freshness.mjs';
import { severityOf } from './nhc.mjs';

const SOURCE = 'JMA-Typhoon';
const LIST_URL = 'https://www.jma.go.jp/bosai/typhoon/data/targetTc.json';
const DETAIL_URL = id => `https://www.jma.go.jp/bosai/typhoon/data/${id}/specifications.json`;
const PAGE = 'https://www.jma.go.jp/bosai/map.html#contents=typhoon';
const REQUEST = Object.freeze({ timeout: 15000, retries: 0, maxBytes: 1024 * 1024, headers: Object.freeze({ 'User-Agent': 'Crucix/2.x' }) });
const MAX_STORMS = 6;
const MAX_POINTS = 12;
const CACHE_MS = 5 * 60000;
const ID = /^TC\d{4}$/;
const CLASSES = { TD: 'Tropical depression', TS: 'Tropical storm', STS: 'Severe tropical storm', TY: 'Typhoon', L: 'Low' };
const state = { at: 0, result: null };
const EXTRAS = {
  attribution: 'Japan Meteorological Agency (RSMC Tokyo - Typhoon Center)',
  rights: 'JMA website content may be used under the Government of Japan Standard Terms of Use (compatible with CC BY 4.0); the source is credited and no endorsement implied.',
  license: 'Government of Japan Standard Terms of Use 2.0 (CC BY 4.0 compatible)',
  licenseUrl: 'https://www.jma.go.jp/jma/en/copyright.html',
  summary: 'Active tropical cyclones of the western North Pacific from the Japan Meteorological Agency advisory: analysed centre, sustained wind, pressure, and the forecast positions up to five days ahead. The forecast positions are a track, not an area at risk.'
};

const num = value => { const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const r2 = value => Math.round(value * 100) / 100;
const valid = (lat, lon) => lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const position = part => Array.isArray(part?.position?.deg) ? { lat: num(part.position.deg[0]), lon: num(part.position.deg[1]) } : { lat: null, lon: null };

/** One system from its specifications document, or null: needs the title part, an analysis part with a position and a valid time. */
export function parseSystem(id, doc, now = Date.now()) {
  if (!ID.test(id) || !Array.isArray(doc)) return null;
  const title = doc.find(part => part?.part === 'title');
  const analysis = doc.find(part => part && typeof part.part === 'object' && part.part?.en === 'Analysis');
  if (!title || !analysis) return null;
  const { lat, lon } = position(analysis);
  const observedAt = providerTime(analysis.validtime?.UTC);
  if (!valid(lat, lon) || !observedAt || Date.parse(observedAt) - now > 300000) return null;
  const code = text(title.category?.en, 4).toUpperCase();
  const number = text(title.typhoonNumber, 4);
  const name = text(title.name?.en, 40) || (number ? `No. ${number}` : id);
  const kt = num(analysis.maximumWind?.sustained?.kt), mb = num(analysis.pressure), speedKt = num(analysis.speed?.kt);
  const points = [];
  for (const part of doc) {
    const hours = num(part?.advancedHours), p = position(part);
    if (hours !== null && hours > 0 && hours <= 240 && valid(p.lat, p.lon) && points.length < MAX_POINTS) points.push({ lat: r2(p.lat), lon: r2(p.lon), hours, windKt: num(part.maximumWind?.sustained?.kt) });
  }
  points.sort((a, b) => a.hours - b.hours);
  return { id, number, name, cls: CLASSES[code] || 'Tropical cyclone', kt, mb, speedKt, lat, lon, observedAt, points };
}

function rowOf(system) {
  const moving = system.speedKt !== null ? `at ${Math.round(system.speedKt)} kt` : null;
  return { kind: 'disaster', providerId: `jma:${system.id}`, source: SOURCE,
    title: `${system.cls} ${system.name}${system.kt !== null ? `: ${system.kt} kt sustained winds` : ''}`,
    summary: `${system.cls} ${system.name} (JMA No. ${system.number || system.id}) at ${system.lat.toFixed(1)}, ${system.lon.toFixed(1)}${system.kt !== null ? ` with ${system.kt} kt sustained winds` : ''}${system.mb !== null ? ` and ${system.mb} hPa central pressure` : ''}${moving ? `, moving ${moving}` : ''}. Advisory analysis of the JMA (RSMC Tokyo); the forecast positions are a track, not an area at risk.`,
    url: PAGE, observedAt: system.observedAt, publishedAt: system.observedAt, severity: severityOf(system.kt),
    lat: system.lat, lon: system.lon, locationMethod: 'provider', locationPrecision: 'exact', region: 'Western Pacific',
    stormClass: system.cls, windKt: system.kt, pressureMb: system.mb, ...(moving ? { movement: moving } : {}) };
}

/** Result from the list of active ids and a map id -> specifications document. */
export function parseJma(list, details, now = Date.now()) {
  if (!Array.isArray(list)) return unavailableResult(SOURCE, 'JMA returned an unexpected response', EXTRAS, now);
  const systems = [];
  for (const entry of list.slice(0, MAX_STORMS)) {
    const id = typeof entry?.tropicalCyclone === 'string' ? entry.tropicalCyclone : '';
    const system = parseSystem(id, details?.[id], now);
    if (system) systems.push(system);
  }
  if (list.length && !systems.length && list.every(entry => entry && details?.[entry.tropicalCyclone] === undefined)) return unavailableResult(SOURCE, 'JMA advisories could not be read', EXTRAS, now);
  const newest = systems.reduce((latest, system) => Math.max(latest, Date.parse(system.observedAt)), 0);
  const geometry = systems.filter(system => system.points.length).map(system => ({ id: system.id, name: system.name,
    track: [[system.lat, system.lon], ...system.points.map(point => [point.lat, point.lon])], points: system.points, cone: [] }));
  return freshResult(SOURCE, systems.length ? new Date(newest).toISOString() : new Date(now).toISOString(), systems.map(rowOf),
    { ...EXTRAS, activeStorms: systems.length, geometry, examinedRecords: list.length }, now);
}

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  if (useCache && state.result && now >= state.at && now - state.at < CACHE_MS) return state.result;
  const request = { ...REQUEST, timeout: Math.max(1, Math.min(REQUEST.timeout, Number(options.timeout) || REQUEST.timeout)) };
  const get = async url => { const reply = await fetcher(url, request); if (reply?.error) throw new Error(String(reply.error)); return reply; };
  let list;
  try { list = await get(LIST_URL); } catch (error) {
    const reason = (error instanceof Error ? error.message : '').replace(/https?:\/\/\S*/gi, '').trim().slice(0, 120);
    return unavailableResult(SOURCE, `JMA request failed${reason ? `: ${reason}` : ''}`, EXTRAS, now);
  }
  const details = {};
  if (Array.isArray(list)) {
    const ids = list.slice(0, MAX_STORMS).map(entry => entry?.tropicalCyclone).filter(id => typeof id === 'string' && ID.test(id));
    await Promise.all(ids.map(async id => { try { details[id] = await get(DETAIL_URL(id)); } catch { /* one failed advisory leaves only that system out */ } }));
  }
  const result = parseJma(list, details, now);
  if (useCache && result.status !== 'error') { state.at = now; state.result = result; }
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('jma-typhoon.mjs')) {
  const result = await briefing();
  console.log(JSON.stringify({ ...result, geometry: result.geometry?.map(g => `${g.id} track ${g.track.length} points ${g.points.length}`) }, null, 2));
}
