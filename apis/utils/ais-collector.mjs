// A persistent aisstream.io listener: one WebSocket that keeps the vessels recently seen in a few bounding boxes in memory.
// https://aisstream.io/documentation - the server expects one JSON subscription within 3 seconds of the connection opening
// ({ APIKey, BoundingBoxes: [[[lat, lon], [lat, lon]], ...], FilterMessageTypes }, latitude first), confirms it with a
// SubscriptionConfirmation message (an invalid one gets no answer) and then streams AIS messages as binary frames of UTF-8 JSON:
// { MessageType, MetaData, Message: { <MessageType>: { ... } } }. A key allows 3 connections (and so does an IP); there is no SLA.
// Started by the dashboard server only (server.mjs); a one-shot briefing never opens it. Briefings read snapshot() synchronously.
// Provider text never reaches the output unchecked: identities and positions are validated numbers, names are cut and stripped of
// control, bidi, zero-width and tag characters, and errors are fixed strings (the key is never logged or returned).
export const AIS_URL = 'wss://stream.aisstream.io/v0/stream';
export const AIS_MESSAGE_TYPES = Object.freeze(['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData']);
const POSITION_TYPES = new Set(['PositionReport', 'StandardClassBPositionReport']);
export const WINDOW_MS = 3600000; // a vessel counts for an area while its last position there is at most an hour old
const AREA_CAP = 2000; // vessels kept per area, the least recently seen go first
const STATIC_CAP = 5000; // names and ship types kept, the least recently updated go first
const MAX_FRAME_BYTES = 16384; // AIS messages are about 1 KB; a larger frame is not one
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 300000;
const HEALTHY_MS = 60000; // a connection that stayed open this long resets the backoff
const IDLE_CHECK_MS = 60000;
const STALL_MS = 600000; // an open connection without a message for this long is closed and reopened
const CLOSE_GRACE_MS = 5000; // a close that has not completed by then is abandoned
const CONNECT_TIMEOUT_MS = 30000; // a connection that has not opened by then is abandoned and retried
const NAME_CAP = 40;
const MAX_REJECTIONS = 5;
export const REJECTED = 'aisstream.io rejected the subscription (check AISSTREAM_API_KEY)';
export const REJECTED_REPEATEDLY = 'aisstream.io rejected the subscription repeatedly; check AISSTREAM_API_KEY and restart';

// A ship name keeps only the printable AIS 6-bit text set (letters, digits, space and its punctuation) minus "<", ">" and "@" (AIS pads
// names with "@"): every other character, control, bidi, zero-width, tag or lone surrogate, goes. Whitespace becomes one space.
// The input is cut before any regex runs; the regexes work on UTF-16 code units, so a surrogate half can never survive.
const NOT_AIS_TEXT = /[^A-Za-z0-9 !"#$%&'()*+,\-./:;=?[\\\]^_]/g;
export function vesselName(value) {
  if (typeof value !== 'string') return '';
  return value.slice(0, 120).replace(/\s+/g, ' ').replace(NOT_AIS_TEXT, '').replace(/ {2,}/g, ' ').trim().slice(0, NAME_CAP).trim();
}

// Exponential backoff with jitter: the attempt-th retry waits between half and all of min(5 min, 1 s x 2^attempt), never under 1 s.
export function reconnectDelay(attempt, random = Math.random) {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(Math.max(0, attempt), 20));
  const r = Number(random());
  return Math.max(BASE_DELAY_MS, Math.round(ceiling * (0.5 + (Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 1) * 0.5)));
}

// A ship's MMSI: nine digits, not 0-prefixed (groups, coast stations), and none of the ITU-R M.585 ranges that are not ships:
// 111 (SAR aircraft), 970-974 (SART, MOB, EPIRB), 98 (craft associated with a parent ship), 99 (aids to navigation).
export const mmsiOf = value => {
  const number = typeof value === 'string' && /^\d{9}$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(number) || number < 100000000 || number > 999999999) return null;
  const prefix = Math.floor(number / 1000000);
  return prefix === 111 || prefix >= 970 && prefix <= 974 || prefix >= 980 ? null : number;
};
const finite = value => typeof value === 'number' && Number.isFinite(value);
// 91 / 181 mean "not available" in AIS; 0, 0 is a failed decode. 102.3 kn and 360 degrees are the "not available" speed and course.
const latOf = value => finite(value) && Math.abs(value) <= 90 ? value : null;
const lonOf = value => finite(value) && Math.abs(value) <= 180 ? value : null;
const sogOf = value => finite(value) && value >= 0 && value < 102.3 ? value : null;
const cogOf = value => finite(value) && value >= 0 && value < 360 ? value : null;
const typeOf = value => Number.isInteger(value) && value > 0 && value <= 99 ? value : null;
// MetaData key casing differs between messages (MMSI, ShipName, latitude ...): read it case-insensitively. A prototype-less object:
// a "__proto__" key stays a plain own key and cannot supply inherited fields.
function metaOf(meta) {
  const out = Object.create(null);
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) for (const [key, value] of Object.entries(meta).slice(0, 30)) out[key.toLowerCase()] = value;
  return out;
}
const inside = (box, lat, lon) => lat >= Math.min(box[0][0], box[1][0]) && lat <= Math.max(box[0][0], box[1][0])
  && lon >= Math.min(box[0][1], box[1][1]) && lon <= Math.max(box[0][1], box[1][1]);
// Map insertion order is the recency order: an update moves the key to the end, so the first key is always the oldest.
function put(map, key, value, cap) {
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) map.delete(map.keys().next().value);
}

/**
 * areas: [{ id, box: [[lat, lon], [lat, lon]] }]. WebSocket, now, setTimeout, clearTimeout, random and log are injectable for tests.
 */
export function createAisCollector({ apiKey, areas = [], WebSocket = globalThis.WebSocket, now = Date.now, setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout, random = Math.random, log = message => console.log(`[Maritime] ${message}`) } = {}) {
  const zones = areas.map(area => ({ id: String(area.id), box: area.box, vessels: new Map() }));
  const statics = new Map();
  const state = { running: false, connected: false, startedAt: null, openedAt: null, lastMessageAt: null, compressionEnabled: null,
    reconnects: 0, lastError: null, messages: 0, ignored: 0, blocked: false, reconnectingSince: null };
  // connectionMessageAt: the last message on the CURRENT connection (null until it receives one), for the idle check and the backoff reset.
  // rejections: subscription rejections since the last accepted AIS message; at MAX_REJECTIONS the collector stops reconnecting.
  // closing: the socket the idle check is closing (its close may never complete). reconnectingSince (state): when the collector began
  // replacing its connection (an idle close or any lost connection); cleared by the next accepted AIS message.
  let socket = null, retryTimer = null, idleTimer = null, attempt = 0, connectionMessageAt = null, rejections = 0, closing = null;
  const decoder = new TextDecoder();

  const timer = (fn, ms) => { const handle = setTimeout(fn, ms); handle?.unref?.(); return handle; };
  function clearTimers() {
    if (retryTimer) clearTimeout(retryTimer);
    if (idleTimer) clearTimeout(idleTimer);
    retryTimer = idleTimer = null;
  }

  function subscription() {
    return JSON.stringify({ APIKey: apiKey, BoundingBoxes: zones.map(zone => zone.box), FilterMessageTypes: [...AIS_MESSAGE_TYPES] });
  }

  // Idle is measured on this connection only: its last message, else the moment it opened.
  function idleCheck() {
    idleTimer = null;
    if (!state.running || !socket || !state.connected) return;
    if (now() - (connectionMessageAt ?? state.openedAt) > STALL_MS) {
      state.lastError = 'No AIS messages for 10 minutes; reconnecting';
      state.reconnectingSince ??= now();
      const ws = socket;
      closing = ws;
      try { ws.close(4000, 'idle'); } catch { /* the grace timer below recovers */ }
      // A socket whose close never completes (no onclose) is detached and replaced through the normal backoff.
      if (socket === ws) idleTimer = timer(() => { idleTimer = null; if (socket !== ws) return; detach(ws); closed(ws, null); }, CLOSE_GRACE_MS);
      return;
    }
    idleTimer = timer(idleCheck, IDLE_CHECK_MS);
  }

  function detach(ws) { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; }

  function closed(ws, code) {
    if (socket !== ws) return;
    socket = null; closing = null;
    // Only a connection that received messages and stayed open for a while resets the backoff.
    if (state.connected && connectionMessageAt !== null && state.openedAt !== null && now() - state.openedAt >= HEALTHY_MS) attempt = 0;
    state.connected = false;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!state.running) return;
    if (!state.lastError || state.lastError === 'AIS stream connection error') state.lastError = `AIS stream closed${code ? ` (code ${code})` : ''}`;
    schedule();
  }

  function schedule() {
    if (!state.running || state.blocked || retryTimer) return;
    const delay = reconnectDelay(attempt++, random);
    state.reconnects++;
    state.reconnectingSince ??= now();
    log(`AIS stream reconnecting in ${Math.round(delay / 1000)} s`);
    retryTimer = timer(() => { retryTimer = null; connect(); }, delay);
  }

  function connect() {
    if (!state.running) return;
    if (typeof WebSocket !== 'function') { state.lastError = 'WebSocket is not available in this Node.js runtime'; return; }
    let ws;
    try { ws = new WebSocket(AIS_URL); } catch { state.lastError = 'AIS stream connection failed'; schedule(); return; }
    socket = ws;
    try { ws.binaryType = 'arraybuffer'; } catch { /* Blob frames are handled too */ }
    // A handshake that never completes (e.g. started just before the host slept) is detached and replaced through the normal backoff;
    // onopen replaces this timer with the idle check.
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = timer(() => {
      idleTimer = null;
      if (socket !== ws || state.connected) return;
      state.lastError = 'AIS stream connection timed out';
      detach(ws);
      try { ws.close(); } catch { /* abandoned either way */ }
      closed(ws, null);
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (socket !== ws) return;
      state.connected = true; state.openedAt = now(); state.compressionEnabled = null; connectionMessageAt = null;
      try { ws.send(subscription()); } catch { state.lastError = 'AIS subscription could not be sent'; }
      log('AIS stream connected');
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = timer(idleCheck, IDLE_CHECK_MS);
    };
    ws.onmessage = event => { if (socket === ws) receive(event?.data, ws); };
    ws.onerror = () => { if (socket === ws) state.lastError ??= 'AIS stream connection error'; };
    ws.onclose = event => closed(ws, Number.isInteger(event?.code) ? event.code : null);
  }

  // One frame of the current connection: counted for its idle check when it was used.
  function frame(text, ws) {
    if (!state.running || socket !== ws) return;
    if (handle(text)) connectionMessageAt = now();
  }

  // Frames arrive as ArrayBuffer (binaryType), a typed array, a Blob or a string; anything over the size cap is dropped unread.
  // A Blob resolves later: by then the collector may be stopped or on another socket, and the frame is then dropped.
  function receive(data, ws) {
    if (typeof data === 'string') return frame(data.length <= MAX_FRAME_BYTES ? data : null, ws);
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return frame(data.byteLength <= MAX_FRAME_BYTES ? decoder.decode(data) : null, ws);
    if (data && typeof data.arrayBuffer === 'function' && finite(data.size)) {
      if (data.size > MAX_FRAME_BYTES) return frame(null, ws);
      return data.arrayBuffer().then(buffer => frame(decoder.decode(buffer), ws), () => frame(null, ws));
    }
    frame(null, ws);
  }

  /** One decoded frame: returns true when it was used. Exposed for tests. */
  function handle(text) {
    let message = null;
    try { message = typeof text === 'string' ? JSON.parse(text) : null; } catch { message = null; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { state.ignored++; return false; }
    // An invalid key gets {"error": "..."} and a closed socket; the provider text is not kept.
    // MAX_REJECTIONS in a row without accepted data in between: a wrong or revoked key; stop reconnecting until a restart.
    if (Object.hasOwn(message, 'error')) {
      state.ignored++;
      if (++rejections < MAX_REJECTIONS) { state.lastError = REJECTED; return false; }
      state.lastError = REJECTED_REPEATEDLY; state.blocked = true;
      clearTimers();
      // A close the idle check started has lost its grace timer: drop that socket now (no reconnect follows, the collector is blocked).
      if (closing && closing === socket) { const ws = closing; detach(ws); closed(ws, null); }
      return false;
    }
    const type = message.MessageType;
    if (type === 'SubscriptionConfirmation') {
      const compression = message.Message?.CompressionEnabled;
      state.compressionEnabled = typeof compression === 'boolean' ? compression : null;
      if (!state.blocked) state.lastError = null;
      return true;
    }
    if (typeof type !== 'string' || !AIS_MESSAGE_TYPES.includes(type)) { state.ignored++; return false; }
    const body = message.Message && typeof message.Message === 'object' ? message.Message[type] : null;
    if (!body || typeof body !== 'object') { state.ignored++; return false; }
    const meta = metaOf(message.MetaData);
    const mmsi = mmsiOf(body.UserID) ?? mmsiOf(meta.mmsi);
    if (mmsi === null) { state.ignored++; return false; }
    const at = now();
    const metaName = vesselName(meta.shipname);
    if (type === 'ShipStaticData') {
      const known = statics.get(mmsi);
      const entry = { name: vesselName(body.Name) || metaName || known?.name || '', shipType: typeOf(body.Type) ?? known?.shipType ?? null, updatedAt: at };
      put(statics, mmsi, entry, STATIC_CAP);
      for (const zone of zones) { const vessel = zone.vessels.get(mmsi); if (vessel) { vessel.name = entry.name || vessel.name; vessel.shipType = entry.shipType ?? vessel.shipType; } }
    } else {
      const lat = latOf(body.Latitude) ?? latOf(meta.latitude), lon = lonOf(body.Longitude) ?? lonOf(meta.longitude);
      if (lat === null || lon === null || lat === 0 && lon === 0) { state.ignored++; return false; }
      const zone = zones.find(item => inside(item.box, lat, lon));
      if (zone) {
        const known = statics.get(mmsi), previous = zone.vessels.get(mmsi);
        put(zone.vessels, mmsi, { mmsi, lastSeen: at, lat, lon, sog: sogOf(body.Sog), cog: cogOf(body.Cog),
          name: known?.name || metaName || previous?.name || '', shipType: known?.shipType ?? previous?.shipType ?? null }, AREA_CAP);
      }
    }
    state.messages++;
    rejections = 0;
    state.lastMessageAt = at;
    state.reconnectingSince = null;
    return true;
  }

  function prune(at) {
    const cutoff = at - WINDOW_MS;
    for (const zone of zones) for (const [mmsi, vessel] of zone.vessels) { if (vessel.lastSeen >= cutoff) break; zone.vessels.delete(mmsi); }
  }

  return {
    start() {
      if (state.running) return this;
      state.running = true; state.startedAt = now(); state.reconnectingSince = null; attempt = 0;
      connect();
      return this;
    },
    stop() {
      state.running = false; state.connected = false; state.reconnectingSince = null;
      clearTimers();
      const ws = socket; socket = null; closing = null;
      try { ws?.close(1000, 'stop'); } catch { /* already closed */ }
    },
    /** Runs the idle check now instead of at its next timer: after a host sleep the timers fire late, and a briefing calls this first. */
    check() {
      if (!state.running || state.blocked || !socket || !state.connected || closing === socket) return this;
      if (idleTimer) clearTimeout(idleTimer);
      idleCheck();
      return this;
    },
    handle,
    /** The collector state and, per area, the vessels seen within the last hour, most recently seen first. */
    snapshot(at = now()) {
      prune(at);
      return { running: state.running, blocked: state.blocked, connected: state.connected, startedAt: state.startedAt, lastMessageAt: state.lastMessageAt,
        openedAt: state.connected ? state.openedAt : null, reconnectingSince: state.reconnectingSince,
        compressionEnabled: state.compressionEnabled, reconnects: state.reconnects, lastError: state.lastError, messages: state.messages, ignored: state.ignored,
        areas: Object.fromEntries(zones.map(zone => [zone.id, [...zone.vessels.values()].reverse().map(vessel => ({ ...vessel }))])) };
    },
  };
}
