// Maritime chokepoints. Without AISSTREAM_API_KEY this briefing lists reference chokepoints only. With a key, the dashboard server
// keeps one aisstream.io WebSocket open (startMaritimeCollector, apis/utils/ais-collector.mjs) and this briefing reports, per
// chokepoint, the AIS-visible vessels that reported a position within +/-2 degrees of its centre in the last hour (one live row per
// chokepoint), plus the most recently seen vessels in `vessels`. The vessels are map markers of the maritime layer only
// (dashboard/inject.mjs): on purpose they never become live rows, events or history records. A one-shot briefing
// (node apis/briefing.mjs) does not open the stream.

import { createAisCollector, WINDOW_MS, REJECTED, REJECTED_REPEATEDLY } from '../utils/ais-collector.mjs';
import { freshResult, unavailableResult } from '../utils/freshness.mjs';

const SOURCE = 'Maritime';

// Key maritime chokepoints to monitor
const CHOKEPOINTS = {
  straitOfHormuz: { label: 'Strait of Hormuz', lat: 26.5, lon: 56.5, note: '20% of world oil' },
  suezCanal: { label: 'Suez Canal', lat: 30.5, lon: 32.3, note: '12% of world trade' },
  straitOfGibraltar: { label: 'Strait of Gibraltar', lat: 36.0, lon: -5.7, note: 'Gateway to Mediterranean, ~10-20% global trade influence' },
  straitOfMalacca: { label: 'Strait of Malacca', lat: 2.5, lon: 101.5, note: '25% of world trade' },
  babElMandeb: { label: 'Bab el-Mandeb', lat: 12.6, lon: 43.3, note: 'Red Sea gateway' },
  taiwanStrait: { label: 'Taiwan Strait', lat: 24.0, lon: 119.0, note: '88% of largest container ships' },
  bosporusStrait: { label: 'Bosphorus', lat: 41.1, lon: 29.1, note: 'Black Sea access' },
  panamaCanal: { label: 'Panama Canal', lat: 9.1, lon: -79.7, note: '5% of world trade' },
  capeOfGoodHope: { label: 'Cape of Good Hope', lat: -34.4, lon: 18.5, note: 'Suez alternative' },
  beringStrait: { label: 'Bering Strait', lat: 65.8, lon: -169, note: 'Arctic Pacific gateway' },
  lancasterSound: { label: 'Lancaster Sound', lat: 74.1, lon: -83, note: 'Northwest Passage gateway' },
};
// Row ids and metric names (<slug>_vessels); the slugs PortWatch also uses are the same.
const SLUGS = { straitOfHormuz: 'hormuz', suezCanal: 'suez', straitOfGibraltar: 'gibraltar', straitOfMalacca: 'malacca', babElMandeb: 'bab_el_mandeb',
  taiwanStrait: 'taiwan_strait', bosporusStrait: 'bosporus', panamaCanal: 'panama', capeOfGoodHope: 'cape_of_good_hope', beringStrait: 'bering_strait',
  lancasterSound: 'lancaster_sound' };
const BOX_DEGREES = 2;
export const AREAS = Object.freeze(Object.entries(CHOKEPOINTS).map(([key, cp]) => Object.freeze({ id: SLUGS[key],
  box: [[cp.lat - BOX_DEGREES, cp.lon - BOX_DEGREES], [cp.lat + BOX_DEGREES, cp.lon + BOX_DEGREES]] })));
export const MAX_VESSELS = 89; // vessel markers per briefing, shared fairly between the chokepoints
const MOVING_KN = 1;
const OK_MS = 5 * 60000; // newest message younger than this: current
const ERROR_MS = 10 * 60000; // older than this (or never, 10 minutes after the start): failed
const WARMUP_MS = 2 * 60000; // a reconnect after a gap of more than 10 minutes is stale, not failed, for this long
const PLANNED = [
  'Dark ship detection (AIS transponder shutoffs)',
  'Sanctions evasion (ship-to-ship transfers)',
  'Naval deployment tracking',
  'Port congestion (vessel dwell time)',
  'Chokepoint traffic anomalies',
  'Oil tanker route changes',
];
const SUMMARY = `AIS-visible vessels that reported a position within ${BOX_DEGREES} degrees of each chokepoint centre in the last 60 minutes (live aisstream.io stream); the most recently seen vessels are drawn on the maritime map layer. Moving means at least ${MOVING_KN} kn; tankers are AIS ship types 80-89, known only once a vessel has sent its static data. Ships with AIS off, and areas without receivers, are not counted, so a low count is not proof of low traffic.`;
const EXTRAS = {
  attribution: 'Live AIS data from aisstream.io (https://aisstream.io)',
  rights: 'aisstream.io is a free service without an SLA and has published no written licence or terms of use for the data. Counts include only ships whose AIS signal is received.',
};

let collector = null;

/** Opens the aisstream.io stream for the life of the process (the dashboard server only). A no-op without a key or when running. */
export function startMaritimeCollector(apiKey = process.env.AISSTREAM_API_KEY, options = {}) {
  if (collector || typeof apiKey !== 'string' || !apiKey.trim()) return collector;
  collector = createAisCollector({ ...options, apiKey: apiKey.trim(), areas: AREAS }).start();
  return collector;
}

export function stopMaritimeCollector() {
  collector?.stop();
  collector = null;
}

function reference(message) {
  return {
    source: 'Maritime/AIS',
    timestamp: new Date().toISOString(),
    status: 'reference',
    message,
    chokepoints: CHOKEPOINTS,
    monitoringCapabilities: [],
    plannedMonitoringCapabilities: PLANNED,
    hint: 'Live vessel counts need AISSTREAM_API_KEY and the dashboard server (node server.mjs), which keeps the aisstream.io stream open',
  };
}

const iso = ms => new Date(ms).toISOString();
const knots = value => value === null ? null : Math.round(value * 10) / 10;
// AIS ship type code groups as keys; the dashboard names them in its language (locales: maritime.type_<key>).
export const VESSEL_TYPES = Object.freeze(['tanker', 'cargo', 'passenger', 'highspeed', 'fishing', 'towing', 'tug', 'military', 'sailing', 'pleasure', 'pilot', 'sar', 'other']);
export function vesselType(code) {
  if (code === null || code === undefined) return null;
  if (code >= 80 && code <= 89) return 'tanker';
  if (code >= 70 && code <= 79) return 'cargo';
  if (code >= 60 && code <= 69) return 'passenger';
  if (code >= 40 && code <= 49) return 'highspeed';
  return { 30: 'fishing', 31: 'towing', 32: 'towing', 35: 'military', 36: 'sailing', 37: 'pleasure', 50: 'pilot', 51: 'sar', 52: 'tug' }[code] || 'other';
}

function chokepointRow(key, vessels, lastMessageAt) {
  const cp = CHOKEPOINTS[key], slug = SLUGS[key];
  const moving = vessels.filter(v => v.sog !== null && v.sog >= MOVING_KN).length, tankers = vessels.filter(v => vesselType(v.shipType) === 'tanker').length;
  const typed = vessels.filter(v => v.shipType !== null).length, n = vessels.length, plural = n === 1 ? '' : 's';
  return { kind: 'maritime', providerId: `ais:${slug}:${iso(lastMessageAt).slice(0, 13)}`, place: cp.label,
    title: `${cp.label}: ${n} vessel${plural} in the last hour (${moving} moving, ${tankers} tanker${tankers === 1 ? '' : 's'})`,
    summary: `${n} AIS-visible vessel${plural} reported a position within ${BOX_DEGREES} degrees of the ${cp.label} centre in the last 60 minutes; ${moving} moving at ${MOVING_KN} kn or more; ${tankers} tanker${tankers === 1 ? '' : 's'} (ship type known for ${typed}). Live aisstream.io data; ships with AIS off are not counted.`,
    observedAt: iso(lastMessageAt), severity: 'info', vessels: n, moving, tankers,
    lat: cp.lat, lon: cp.lon, locationMethod: 'configured-point', locationPrecision: 'approximate', chokepoint: slug };
}

// A map marker, not a live row: structured fields that the dashboard words in its own language. The name was sanitised by the
// collector (vesselName; '' when unknown), area is the chokepoint slug, vesselType a type-group key, the rest validated numbers.
function vesselMarker(key, vessel) {
  return { name: vessel.name || '', mmsi: vessel.mmsi, lat: vessel.lat, lon: vessel.lon, speedKn: knots(vessel.sog), vesselType: vesselType(vessel.shipType),
    area: SLUGS[key], lastSeen: iso(vessel.lastSeen) };
}

// Round robin over the chokepoints (each list most recent first), so one busy strait cannot take every marker; most recent first overall.
function fairVessels(lists, limit) {
  const picked = [], queues = lists.map(([key, vessels]) => ({ key, vessels, next: 0 }));
  while (picked.length < limit && queues.some(q => q.next < q.vessels.length)) {
    for (const q of queues) if (picked.length < limit && q.next < q.vessels.length) picked.push([q.key, q.vessels[q.next++]]);
  }
  return picked.sort((a, b) => b[1].lastSeen - a[1].lastSeen);
}

/** The live result from a collector snapshot (exported for tests). */
export function maritimeResult(snapshot, now = Date.now()) {
  const last = Number.isFinite(snapshot.lastMessageAt) ? snapshot.lastMessageAt : null;
  const age = last === null ? null : now - last;
  const extras = { ...EXTRAS, summary: SUMMARY, chokepoints: CHOKEPOINTS, monitoringCapabilities: [], plannedMonitoringCapabilities: PLANNED,
    collector: { connected: snapshot.connected, reconnects: snapshot.reconnects, compressionEnabled: snapshot.compressionEnabled } };
  // Repeated rejections stopped the collector: failed until a restart, whatever the age of the last message.
  if (snapshot.blocked) return unavailableResult(SOURCE, REJECTED_REPEATEDLY, extras, now);
  if (age === null || age > ERROR_MS) {
    const rejected = snapshot.lastError === REJECTED;
    if (age === null && !rejected && Number.isFinite(snapshot.startedAt) && now - snapshot.startedAt <= ERROR_MS) {
      return { ...freshResult(SOURCE, null, [], extras, now), message: 'Waiting for the first AIS messages from aisstream.io' };
    }
    // A gap the collector has just begun to repair (after a host sleep the idle check runs only at the sweep): stale while the old
    // connection closes, the reconnect waits, or the new connection has no message yet, for WARMUP_MS from the start of the repair
    // (reconnectingSince is set once per repair and cleared only by an AIS message, so a long outage cannot turn stale again).
    const since = Number.isFinite(snapshot.reconnectingSince) ? snapshot.reconnectingSince : null;
    const fresh = Number.isFinite(snapshot.openedAt) && snapshot.openedAt >= since;
    if (!rejected && since !== null && now - since <= WARMUP_MS && (!snapshot.connected || !fresh || now - snapshot.openedAt <= WARMUP_MS)) {
      return { ...freshResult(SOURCE, last === null ? null : iso(last), [], extras, now), status: 'stale', stale: true, observations: [],
        message: 'AIS stream reconnecting after a gap; waiting for messages' };
    }
    const error = rejected ? snapshot.lastError : !snapshot.connected ? 'AIS stream disconnected; reconnecting' : 'No AIS messages for more than 10 minutes';
    return unavailableResult(SOURCE, error, extras, now);
  }
  if (age > OK_MS || !snapshot.connected) {
    return { ...freshResult(SOURCE, iso(last), [], extras, now), status: 'stale', stale: true, observations: [],
      message: snapshot.connected ? 'No AIS messages for more than 5 minutes' : 'AIS stream reconnecting' };
  }
  const lists = Object.keys(CHOKEPOINTS).map(key => [key, (snapshot.areas?.[SLUGS[key]] || []).filter(v => now - v.lastSeen <= WINDOW_MS)]);
  const counts = lists.map(([key, vessels]) => chokepointRow(key, vessels, last));
  const vessels = fairVessels(lists, MAX_VESSELS).map(([key, vessel]) => vesselMarker(key, vessel));
  const legacy = Object.fromEntries(Object.entries(CHOKEPOINTS).map(([key, cp], i) => [key, { ...cp, vessels: counts[i].vessels, moving: counts[i].moving, tankers: counts[i].tankers }]));
  const out = freshResult(SOURCE, iso(last), counts, { ...extras, chokepoints: legacy, vessels,
    monitoringCapabilities: ['Chokepoint vessel counts (live AIS, last 60 minutes)', 'Recently seen vessels on the maritime map layer'] }, now);
  out.metrics = Object.fromEntries(counts.map(row => [`${row.chokepoint}_vessels`, row.vessels]));
  // aisstream.io limits the bandwidth of uncompressed connections; the server says in its confirmation whether compression is on.
  if (snapshot.compressionEnabled === false) out.message = 'aisstream.io did not enable compression on this connection; uncompressed connections may be bandwidth-limited';
  return out;
}

// Reads the running collector synchronously; options.apiKey, options.collector and options.now are for tests.
export async function briefing(options = {}) {
  const key = options.apiKey ?? process.env.AISSTREAM_API_KEY;
  if (!key) return reference('Reference chokepoints only; set AISSTREAM_API_KEY and run the dashboard server for live vessel counts');
  const live = options.collector === undefined ? collector : options.collector;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  // The idle check first: a connection that died while the host slept starts reconnecting now, before the snapshot is read.
  live?.check?.();
  const snapshot = live ? live.snapshot(now) : null;
  if (!snapshot?.running) return reference('AIS key configured; the live aisstream.io collector runs only inside the dashboard server (node server.mjs), so this briefing lists reference chokepoints');
  return maritimeResult(snapshot, now);
}

if (process.argv[1]?.endsWith('ships.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
