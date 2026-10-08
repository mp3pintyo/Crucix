// FAA National Airspace System status: ground stops, ground delay programs and arrival/departure delays at the busiest U.S. airports.
// https://nasstatus.faa.gov/api/airport-status-information (XML, no key; 2 KB when quiet). Checked live on 2026-10-08 from Hungary: HTTP 200, 1 s. The idea (an airport
// disruption layer from the FAA feed) comes from World Monitor (koala73/worldmonitor, seed-aviation.mjs); the adapter is Crucix's own.
// One row per airport with an active programme, at the airport's reference position (a fixed table below; an airport that is not in it still gets its row, without a
// position). The "Airport Closures" list is NOT used: on the day of measuring it held NOTAM restrictions such as "closed to non-scheduled transient GA aircraft" from
// May, not closures of the airport, so reading them as closures would be wrong. Durations come as text ("1 hour and 23 minutes") and are read as minutes. An empty list
// is a valid answer ("no programme now"): the observation time is then the update time the service states.
import { safeFetch } from '../utils/fetch.mjs';
import { providerTime, freshResult, unavailableResult } from '../utils/freshness.mjs';
import { parseXml } from '../utils/xml.mjs';

const SOURCE = 'FAA-Airports';
const URL_ = 'https://nasstatus.faa.gov/api/airport-status-information';
const PAGE = 'https://nasstatus.faa.gov/';
const CACHE_MS = 5 * 60000;
const MAX_ROWS = 40;
const REQUEST = Object.freeze({ timeout: 15000, retries: 0, maxBytes: 1024 * 1024, format: 'text', headers: Object.freeze({ 'User-Agent': 'Crucix/2.x', Accept: 'application/xml' }) });
// IATA -> [name, lat, lon]: the busiest U.S. hubs the FAA lists, plus Montreal and Toronto, which the same feed carries.
const AIRPORTS = Object.freeze({
  ATL: ['Atlanta', 33.6367, -84.4281], AUS: ['Austin', 30.1945, -97.6699], BNA: ['Nashville', 36.1263, -86.6774], BOS: ['Boston Logan', 42.3656, -71.0096], BWI: ['Baltimore/Washington', 39.1754, -76.6683],
  CLE: ['Cleveland', 41.4117, -81.8498], CLT: ['Charlotte', 35.2144, -80.9473], CVG: ['Cincinnati', 39.0488, -84.6678], DCA: ['Washington Reagan', 38.8512, -77.0402], DEN: ['Denver', 39.8561, -104.6737],
  DFW: ['Dallas/Fort Worth', 32.8998, -97.0403], DTW: ['Detroit', 42.2124, -83.3534], EWR: ['Newark', 40.6925, -74.1687], FLL: ['Fort Lauderdale', 26.0726, -80.1527], HNL: ['Honolulu', 21.3187, -157.9224],
  IAD: ['Washington Dulles', 38.9531, -77.4565], IAH: ['Houston Intercontinental', 29.9902, -95.3368], IND: ['Indianapolis', 39.7173, -86.2944], JFK: ['New York JFK', 40.6413, -73.7781], LAS: ['Las Vegas', 36.084, -115.1537],
  LAX: ['Los Angeles', 33.9416, -118.4085], LGA: ['New York LaGuardia', 40.7769, -73.874], MCI: ['Kansas City', 39.2976, -94.7139], MCO: ['Orlando', 28.4312, -81.3081], MDW: ['Chicago Midway', 41.7868, -87.7522],
  MEM: ['Memphis', 35.0424, -89.9767], MIA: ['Miami', 25.7959, -80.287], MKE: ['Milwaukee', 42.9472, -87.8966], MSP: ['Minneapolis/St Paul', 44.8848, -93.2223], OAK: ['Oakland', 37.7213, -122.2208],
  ORD: ["Chicago O'Hare", 41.9742, -87.9073], PDX: ['Portland', 45.5898, -122.5951], PHL: ['Philadelphia', 39.8744, -75.2424], PHX: ['Phoenix', 33.4342, -112.0116], PIT: ['Pittsburgh', 40.4915, -80.2329],
  RDU: ['Raleigh/Durham', 35.8776, -78.7875], SAN: ['San Diego', 32.7338, -117.1933], SEA: ['Seattle/Tacoma', 47.4502, -122.3088], SFO: ['San Francisco', 37.6213, -122.379], SJC: ['San Jose', 37.3639, -121.9289],
  SLC: ['Salt Lake City', 40.7899, -111.9791], SMF: ['Sacramento', 38.6954, -121.5908], SNA: ['Orange County', 33.6757, -117.8683], STL: ['St Louis', 38.7487, -90.37], TPA: ['Tampa', 27.9755, -82.5332],
  ANC: ['Anchorage', 61.1744, -149.9964], YUL: ['Montreal', 45.4706, -73.7408], YYZ: ['Toronto Pearson', 43.6777, -79.6248],
});
const EXTRAS = {
  attribution: 'Source: Federal Aviation Administration, National Airspace System Status (nasstatus.faa.gov)',
  rights: 'FAA NAS status data is published by a U.S. government agency for public use; no endorsement implied.',
  license: 'U.S. government public data (FAA)',
  licenseUrl: 'https://www.faa.gov/web_policies',
  summary: 'Ground stops, ground delay programs and arrival/departure delays announced by the FAA at busy airports, at the airport\'s reference position. The "Airport Closures" list is not used: it holds NOTAM restrictions, not closures of the airport. A programme is a delay announcement, not a count of delayed flights.'
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** "Thu Oct 8 17:24:27 2026 GMT" -> ISO time, or null. */
export function updateTime(raw) {
  const m = typeof raw === 'string' ? /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+GMT$/.exec(raw.trim().slice(0, 60)) : null;
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : 0;
  return month ? providerTime(`${m[6]}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}T${m[3]}:${m[4]}:${m[5]}Z`) : null;
}

/** "1 hour and 23 minutes" / "45 minutes" / "2 hours" -> minutes, or null. */
export function minutesOf(raw) {
  if (typeof raw !== 'string' || raw.length > 60) return null;
  const hours = /(\d{1,2})\s*hours?/i.exec(raw), minutes = /(\d{1,3})\s*min/i.exec(raw);
  return hours || minutes ? (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0) : null;
}

/** Severity by the average delay (minutes); a ground stop holds departures and is high. */
export function severityOf(kind, avgMinutes) {
  if (kind === 'ground stop') return 'high';
  return avgMinutes === null ? 'moderate' : avgMinutes >= 90 ? 'high' : avgMinutes >= 60 ? 'elevated' : avgMinutes >= 30 ? 'moderate' : 'low';
}

const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const list = value => Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];

// Every object stored under one of these keys, anywhere below the root (the lists are nested two levels deep).
function collect(node, key, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return out;
  for (const [name, value] of Object.entries(node)) {
    if (name === key) out.push(...list(value).filter(item => item && typeof item === 'object'));
    else collect(value, key, out, depth + 1);
  }
  return out;
}

/** Programmes of an XML document: { observedAt, programmes: [{ airport, kind, reason, avgMinutes, maxMinutes }] }, or null when it is not the FAA document. */
export function parseFaaXml(xml) {
  let doc;
  try { doc = parseXml(xml); } catch { return null; }
  const root = doc?.AIRPORT_STATUS_INFORMATION;
  if (!root || typeof root !== 'object') return null;
  const observedAt = updateTime(typeof root.Update_Time === 'string' ? root.Update_Time : '');
  const byAirport = new Map();
  const add = (item, kind) => {
    const airport = text(item.ARPT, 4).toUpperCase();
    if (!/^[A-Z]{3,4}$/.test(airport)) return;
    const avg = kind === 'ground delay' ? minutesOf(item.Avg) : (() => { const lo = minutesOf(item.Min), hi = minutesOf(item.Max); return lo !== null && hi !== null ? Math.round((lo + hi) / 2) : lo ?? hi; })();
    const entry = { airport, kind, reason: text(item.Reason, 80) || 'not stated', avgMinutes: avg, maxMinutes: minutesOf(item.Max) };
    const known = byAirport.get(airport);
    // One row per airport: a ground stop beats a delay, a longer average beats a shorter one.
    if (!known || (kind === 'ground stop' && known.kind !== 'ground stop') || (known.kind !== 'ground stop' && (entry.avgMinutes ?? 0) > (known.avgMinutes ?? 0))) byAirport.set(airport, entry);
  };
  for (const item of collect(root, 'Ground_Delay')) add(item, 'ground delay');
  for (const item of collect(root, 'Ground_Stop')) add(item, 'ground stop');
  for (const item of collect(root, 'Delay')) add(item, 'arrival/departure delay');
  return { observedAt, programmes: [...byAirport.values()] };
}

function rowOf(programme, observedAt) {
  const place = AIRPORTS[programme.airport];
  const where = place ? `${place[0]} (${programme.airport})` : programme.airport;
  const length = programme.avgMinutes !== null ? `, average delay ${programme.avgMinutes} min${programme.maxMinutes !== null ? `, up to ${programme.maxMinutes} min` : ''}` : '';
  return { kind: 'aviation', providerId: `faa:${programme.airport}`, source: SOURCE,
    title: `${where}: ${programme.kind}${programme.avgMinutes !== null ? `, ${programme.avgMinutes} min average` : ''}`,
    summary: `FAA ${programme.kind} at ${where}, reason: ${programme.reason}${length}. A delay announcement of the FAA, not a count of delayed flights.`,
    url: PAGE, observedAt, publishedAt: observedAt, severity: severityOf(programme.kind, programme.avgMinutes), region: 'United States',
    ...(place ? { lat: place[1], lon: place[2], locationMethod: 'airport', locationPrecision: 'exact' } : {}),
    delayKind: programme.kind, ...(programme.avgMinutes !== null ? { avgDelayMin: programme.avgMinutes } : {}), reason: programme.reason };
}

export function parseFaa(xml, now = Date.now()) {
  const parsed = parseFaaXml(xml);
  if (!parsed || !parsed.observedAt) return unavailableResult(SOURCE, 'The FAA returned an unexpected response', EXTRAS, now);
  if (Date.parse(parsed.observedAt) - now > 300000) return unavailableResult(SOURCE, 'The FAA update time lies in the future', EXTRAS, now);
  const rows = parsed.programmes.slice(0, MAX_ROWS).map(programme => rowOf(programme, parsed.observedAt));
  return freshResult(SOURCE, parsed.observedAt, rows, { ...EXTRAS, activePrograms: parsed.programmes.length, examinedRecords: parsed.programmes.length }, now);
}

const cache = { at: 0, result: null };

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  if (useCache && cache.result && now >= cache.at && now - cache.at < CACHE_MS) return cache.result;
  const request = { ...REQUEST, timeout: Math.max(1, Math.min(REQUEST.timeout, Number(options.timeout) || REQUEST.timeout)) };
  let reply;
  try { reply = await fetcher(URL_, request); } catch (error) { reply = { error: error instanceof Error ? error.message : 'network error' }; }
  const result = typeof reply?.rawText === 'string' ? parseFaa(reply.rawText, now)
    : unavailableResult(SOURCE, `FAA request failed${typeof reply?.error === 'string' ? `: ${reply.error.replace(/https?:\/\/\S*/gi, '').trim().slice(0, 120)}` : ''}`, EXTRAS, now);
  if (useCache && result.status !== 'error') { cache.at = now; cache.result = result; }
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('faa-airports.mjs')) console.log(JSON.stringify(await briefing(), null, 2));
