import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createAisCollector, reconnectDelay, vesselName, AIS_URL, AIS_MESSAGE_TYPES } from '../apis/utils/ais-collector.mjs';
import { briefing, maritimeResult, AREAS, MAX_VESSELS, VESSEL_TYPES, vesselType } from '../apis/sources/ships.mjs';
import { POLICIES } from '../apis/utils/freshness.mjs';
import { FACT_FIELDS, HOME, normalizeLiveSources } from '../lib/intelligence/live-sources.mjs';
import { buildEvents } from '../lib/intelligence/events.mjs';
import { HistoryStore } from '../lib/intelligence/history.mjs';
import { synthesize } from '../dashboard/inject.mjs';

// No network: every test drives a fake WebSocket, fake timers and a fake clock. aisstream.io is never contacted.
const KEY = 'test-key-0123456789';
const T0 = Date.parse('2026-10-08T12:00:00Z');
const MIN = 60000;
const HORMUZ = { lat: 26.5, lon: 56.5 }, SUEZ = { lat: 30.5, lon: 32.3 };

// hangingClose: close() never fires onclose (a socket stuck in CLOSING).
function rig({ random = () => 0.5, hangingClose = false } = {}) {
  const sockets = [], timers = [], clock = { now: T0 };
  class FakeSocket {
    constructor(url) { this.url = url; this.sent = []; this.closed = null; sockets.push(this); }
    send(data) { this.sent.push(data); }
    close(code, reason) { this.closed = { code, reason }; if (!hangingClose) this.onclose?.({ code }); }
    open() { this.onopen?.(); }
    frame(data) { this.onmessage?.({ data }); }
    drop(code = 1006) { this.onclose?.({ code }); }
  }
  const setTimeout = (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; };
  const clearTimeout = timer => { if (timer) timer.cleared = true; };
  const collector = createAisCollector({ apiKey: KEY, areas: AREAS, WebSocket: FakeSocket, now: () => clock.now, setTimeout, clearTimeout, random, log: () => {} });
  const pending = () => timers.filter(timer => !timer.cleared && !timer.fired);
  const fire = timer => { timer.fired = true; timer.fn(); };
  return { sockets, timers, clock, collector, pending, fire };
}
const position = (mmsi, lat, lon, extra = {}, type = 'PositionReport') => JSON.stringify({ MessageType: type,
  MetaData: { MMSI: mmsi, ShipName: extra.metaName ?? '', latitude: lat, longitude: lon, time_utc: '2026-10-08 12:00:00 +0000 UTC' },
  Message: { [type]: { UserID: mmsi, Latitude: lat, Longitude: lon, Sog: extra.sog ?? 12.3, Cog: 90, TrueHeading: 90, NavigationalStatus: 0 } } });
const staticData = (mmsi, Name, Type) => JSON.stringify({ MessageType: 'ShipStaticData', MetaData: { MMSI: mmsi }, Message: { ShipStaticData: { UserID: mmsi, Name, Type, CallSign: 'ABCD', ImoNumber: 1234567, Destination: 'FUJAIRAH' } } });
const confirm = compression => JSON.stringify({ MessageType: 'SubscriptionConfirmation', Message: { CompressionEnabled: compression } });
const bytes = text => new TextEncoder().encode(text);
const started = () => { const r = rig(); r.collector.start(); r.sockets[0].open(); return r; };

test('the subscription goes out on open: the chokepoint boxes latitude first, the three message types and only the key', () => {
  const { sockets, collector } = rig();
  collector.start();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, AIS_URL);
  assert.equal(sockets[0].sent.length, 0, 'nothing before open');
  sockets[0].open();
  assert.equal(sockets[0].sent.length, 1);
  const sub = JSON.parse(sockets[0].sent[0]);
  assert.deepEqual(Object.keys(sub).sort(), ['APIKey', 'BoundingBoxes', 'FilterMessageTypes']);
  assert.equal(sub.APIKey, KEY);
  assert.deepEqual(sub.FilterMessageTypes, ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData']);
  assert.deepEqual(AIS_MESSAGE_TYPES, sub.FilterMessageTypes);
  assert.equal(sub.BoundingBoxes.length, 11);
  assert.deepEqual(sub.BoundingBoxes[0], [[24.5, 54.5], [28.5, 58.5]], 'Hormuz: [lat, lon] corners, +/-2 degrees');
  assert.deepEqual(sub.BoundingBoxes[9], [[63.8, -171], [67.8, -167]], 'Bering Strait');
  for (const box of sub.BoundingBoxes) for (const [lat, lon] of box) { assert(Math.abs(lat) <= 90); assert(Math.abs(lon) <= 180); }
  assert.equal(sockets[0].sent[0].split(KEY).length, 2, 'the key appears once, in APIKey');
});

test('binary, typed-array, Blob and string frames are decoded; positions land in their chokepoint', async () => {
  const { sockets, collector, clock } = started();
  sockets[0].frame(bytes(position(211000001, HORMUZ.lat, HORMUZ.lon)).buffer);
  sockets[0].frame(bytes(position(211000002, HORMUZ.lat + 1, HORMUZ.lon - 1)));
  sockets[0].frame(position(211000003, SUEZ.lat, SUEZ.lon, {}, 'StandardClassBPositionReport'));
  sockets[0].frame(new Blob([bytes(position(211000004, SUEZ.lat + 0.5, SUEZ.lon))]));
  await new Promise(resolve => setImmediate(resolve));
  const snap = collector.snapshot();
  assert.deepEqual(snap.areas.hormuz.map(v => v.mmsi).sort(), [211000001, 211000002]);
  assert.deepEqual(snap.areas.suez.map(v => v.mmsi).sort(), [211000003, 211000004]);
  assert.equal(snap.lastMessageAt, clock.now);
  assert.equal(snap.messages, 4);
  assert.equal(snap.connected, true);
});

test('positions outside every box and malformed messages are ignored', () => {
  const { sockets, collector } = started();
  const bad = [
    position(211000001, 0, 0), position(211000001, 91, 181), position(211000001, HORMUZ.lat, 200),
    position(12345, HORMUZ.lat, HORMUZ.lon), position(1234567890, HORMUZ.lat, HORMUZ.lon),
    JSON.stringify({ MessageType: 'PositionReport', Message: { PositionReport: { UserID: 211000001, Latitude: '26.5', Longitude: '56.5' } } }),
    JSON.stringify({ MessageType: 'PositionReport', Message: {} }), JSON.stringify({ MessageType: 'Interrogation', Message: { Interrogation: { UserID: 211000001 } } }),
    '{not json', '[]', 'null', '42', JSON.stringify({ MessageType: 'PositionReport' }), 'x'.repeat(20000), bytes('{"a":' + ' '.repeat(20000) + '1}'),
    position(211000001, NaN, HORMUZ.lon), undefined, 7,
  ];
  for (const frame of bad) sockets[0].frame(frame);
  const snap = collector.snapshot();
  assert.equal(Object.values(snap.areas).flat().length, 0);
  assert.equal(snap.messages, 0);
  assert.equal(snap.lastMessageAt, null);
  assert.equal(snap.ignored, bad.length);
  // A valid position outside every box (the English Channel) keeps the stream alive but counts nowhere.
  sockets[0].frame(position(211000001, 50.5, 1));
  const outside = collector.snapshot();
  assert.equal(Object.values(outside.areas).flat().length, 0);
  assert.equal(outside.messages, 1);
});

test('MMSI ranges that are not ships are ignored: SAR aircraft, SART/MOB/EPIRB, craft of a parent ship, aids to navigation', () => {
  const { sockets, collector } = started();
  for (const mmsi of [111234567, 970123456, 972000001, 974999999, 981234567, 991234567]) {
    sockets[0].frame(position(mmsi, HORMUZ.lat, HORMUZ.lon));
    sockets[0].frame(staticData(mmsi, 'NOT A SHIP', 70));
  }
  sockets[0].frame(JSON.stringify({ MessageType: 'PositionReport', MetaData: { MMSI: 991234567, latitude: HORMUZ.lat, longitude: HORMUZ.lon }, Message: { PositionReport: {} } }));
  assert.equal(collector.snapshot().areas.hormuz.length, 0);
  assert.equal(collector.snapshot().messages, 0);
  for (const mmsi of [211000001, 110000001, 969999999, 975000001]) sockets[0].frame(position(mmsi, HORMUZ.lat, HORMUZ.lon));
  assert.deepEqual(collector.snapshot().areas.hormuz.map(v => v.mmsi).sort(), [110000001, 211000001, 969999999, 975000001]);
});

test('a MetaData "__proto__" key cannot supply an identity or a position', () => {
  const { sockets, collector } = started();
  sockets[0].frame('{"MessageType":"PositionReport","MetaData":{"__proto__":{"mmsi":211000009,"latitude":26.5,"longitude":56.5}},"Message":{"PositionReport":{"Sog":1}}}');
  assert.equal(collector.snapshot().areas.hormuz.length, 0);
  assert.equal(collector.snapshot().messages, 0);
});

test('ship names keep only the AIS text set: other letters, symbols and lone surrogates go', () => {
  assert.equal(vesselName('MÜNCHEN EXPRESS'), 'MNCHEN EXPRESS');
  assert.equal(vesselName(`A${'\ud800'}B${'\udc00'}C`), 'ABC');
  assert.equal(vesselName('A~B{C}|D`E'), 'ABCDE');
  assert.equal(vesselName(`ST. MARY'S (2) #7 A/B-C: "X"; Y=Z?`), `ST. MARY'S (2) #7 A/B-C: "X"; Y=Z?`);
  assert.equal(vesselName('[1]^_!$%&*+,\\'), '[1]^_!$%&*+,\\');
  assert.equal(vesselName('@@@@@@'), '');
  assert.equal(vesselName('ÁÉÍ'), '');
});

test('repeated subscription rejections stop the reconnects until a restart, with a fixed message', () => {
  const { sockets, collector, pending, fire } = rig({ random: () => 1 });
  collector.start();
  const reject = () => { const ws = sockets.at(-1); ws.open(); ws.frame(JSON.stringify({ error: `Api Key Is Not Valid ${KEY}` })); ws.drop(1000); };
  // Accepted data between rejections resets the count.
  for (let i = 0; i < 4; i++) { reject(); fire(pending().find(t => t.ms !== 60000)); }
  sockets.at(-1).open(); sockets.at(-1).frame(position(211000001, HORMUZ.lat, HORMUZ.lon)); sockets.at(-1).drop(1006);
  fire(pending().find(t => t.ms !== 60000));
  for (let i = 0; i < 4; i++) { reject(); fire(pending().find(t => t.ms !== 60000)); }
  reject();
  assert.equal(pending().length, 0, 'the fifth consecutive rejection stops the reconnects');
  const count = sockets.length, snap = collector.snapshot();
  assert.equal(snap.lastError, 'aisstream.io rejected the subscription repeatedly; check AISSTREAM_API_KEY and restart');
  assert.equal(snap.connected, false);
  const out = maritimeResult(snap, T0);
  assert.equal(out.status, 'error');
  assert.equal(out.error, 'aisstream.io rejected the subscription repeatedly; check AISSTREAM_API_KEY and restart');
  assert.doesNotMatch(JSON.stringify([snap, out]), new RegExp(KEY));
  assert.equal(sockets.length, count);
});

test('spawned test servers run without an AIS key and the network fixture blocks WebSocket too', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const file of ['./server-start.test.mjs', './alerts-integration.test.mjs']) {
    const source = read(file), spawns = source.match(/env: \{ \.\.\.process\.env,[^}]*\}/g) || [];
    assert(spawns.length >= 1, file);
    for (const env of spawns) assert.match(env, /AISSTREAM_API_KEY: ''/, file);
  }
  const run = spawnSync(process.execPath, ['--import', new URL('./fixtures/block-network.mjs', import.meta.url).href, '-e',
    "try { new WebSocket('wss://stream.aisstream.io/v0/stream'); console.log('opened'); } catch (e) { console.log('blocked: ' + e.message); }"], { encoding: 'utf8' });
  assert.match(run.stdout, /^blocked: External network disabled in server test/);
});

test('MetaData is a case-insensitive fallback for the identity and the position', () => {
  const { sockets, collector } = started();
  sockets[0].frame(JSON.stringify({ MessageType: 'PositionReport', MetaData: { mmsi: 211000009, LATITUDE: HORMUZ.lat, Longitude: HORMUZ.lon, shipname: 'META NAME@@@' },
    Message: { PositionReport: { Sog: 0.2 } } }));
  const [vessel] = collector.snapshot().areas.hormuz;
  assert.equal(vessel.mmsi, 211000009);
  assert.equal(vessel.name, 'META NAME');
});

test('static data names are sanitised and capped, and attach to known and later vessels', () => {
  const { sockets, collector } = started();
  sockets[0].frame(position(211000001, HORMUZ.lat, HORMUZ.lon));
  // Bidi override and isolate, zero-width space, BEL, NEL (C1), a tag character, BOM, Arabic letter mark, LRM, markup and AIS "@" padding.
  const cp = (...codes) => String.fromCodePoint(...codes);
  const hostile = `EVIL${cp(0x202e)}KCAB${cp(0x2066, 0x200b)} SHIP${cp(0x07, 0x85, 0xe0041, 0xfeff, 0x061c, 0x200e)}<b>@@@@`;
  sockets[0].frame(staticData(211000001, hostile, 84));
  sockets[0].frame(staticData(211000002, 'X'.repeat(500), 71));
  sockets[0].frame(position(211000002, HORMUZ.lat, HORMUZ.lon + 1));
  const byId = new Map(collector.snapshot().areas.hormuz.map(v => [v.mmsi, v]));
  assert.equal(byId.get(211000001).name, 'EVILKCAB SHIP b');
  assert.equal(byId.get(211000001).shipType, 84);
  assert.equal(byId.get(211000002).name.length, 40);
  assert.equal(byId.get(211000002).shipType, 71);
  assert.doesNotMatch(byId.get(211000001).name, /[\p{Cc}\p{Cf}<>]/u);
  assert.equal(vesselName(42), '');
  assert.equal(vesselName('  A\n\tB  '), 'A B');
});

test('vessels older than an hour are pruned and each area is capped, oldest first', () => {
  const { sockets, collector, clock } = started();
  sockets[0].frame(position(211000001, HORMUZ.lat, HORMUZ.lon));
  clock.now += 30 * MIN;
  sockets[0].frame(position(211000002, HORMUZ.lat, HORMUZ.lon));
  clock.now += 31 * MIN;
  assert.deepEqual(collector.snapshot().areas.hormuz.map(v => v.mmsi), [211000002], 'the 61-minute-old vessel is gone');
  for (let i = 0; i < 2100; i++) sockets[0].frame(position(300000000 + i, SUEZ.lat, SUEZ.lon));
  const suez = collector.snapshot().areas.suez;
  assert.equal(suez.length, 2000);
  assert.equal(suez.at(-1).mmsi, 300000100, 'the first 100 were evicted');
  assert.equal(suez[0].mmsi, 300002099, 'most recent first');
});

test('reconnect backoff grows, stays within its jitter bounds, and resets after a healthy connection', () => {
  for (const [attempt, low, high] of [[0, 1000, 1000], [1, 1000, 2000], [3, 4000, 8000], [8, 128000, 256000], [9, 150000, 300000], [30, 150000, 300000]]) {
    assert.equal(reconnectDelay(attempt, () => 0), Math.max(1000, low), `attempt ${attempt} low`);
    assert.equal(reconnectDelay(attempt, () => 0.999999), high, `attempt ${attempt} high`);
    for (const r of [NaN, -1, 2]) { const d = reconnectDelay(attempt, () => r); assert(d >= 1000 && d <= 300000); }
  }
  const { sockets, collector, clock, pending, fire } = rig({ random: () => 1 });
  collector.start();
  const delays = [];
  for (let i = 0; i < 4; i++) {
    sockets.at(-1).drop();
    const retry = pending().find(t => t.ms >= 1000 && t.ms !== 60000);
    delays.push(retry.ms);
    fire(retry);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  assert.equal(collector.snapshot().reconnects, 4);
  assert.equal(collector.snapshot().lastError, 'AIS stream closed (code 1006)');
  // Open for two minutes but silent: not healthy, the backoff keeps growing.
  sockets.at(-1).open();
  clock.now += 2 * MIN;
  sockets.at(-1).drop();
  let retry = pending().find(t => t.ms !== 60000);
  assert.equal(retry.ms, 16000, 'an open but silent connection does not reset the backoff');
  fire(retry);
  // Open, receiving, for two minutes: healthy, the backoff starts again.
  sockets.at(-1).open();
  sockets.at(-1).frame(position(211000001, HORMUZ.lat, HORMUZ.lon));
  clock.now += 2 * MIN;
  sockets.at(-1).drop();
  retry = pending().find(t => t.ms !== 60000);
  assert.equal(retry.ms, 1000, 'reset after two healthy minutes');
  fire(retry);
  sockets.at(-1).open();
  const live = sockets.at(-1), count = sockets.length;
  collector.stop();
  assert.deepEqual(live.closed, { code: 1000, reason: 'stop' }, 'stop closes the live socket');
  assert.equal(pending().length, 0, 'stop clears the timers');
  assert.equal(collector.snapshot().connected, false);
  assert.equal(collector.snapshot().running, false);
  live.drop();
  assert.equal(sockets.length, count, 'no reconnect after stop');
  assert.equal(pending().length, 0, 'no timer after stop');
});

test('a silent server is retried with a growing backoff up to the 5-minute cap, not once a minute', () => {
  const { sockets, collector, clock, pending, fire } = rig({ random: () => 1 });
  collector.start();
  // Messages on an earlier connection must not make a new silent connection look idle at once.
  sockets[0].open();
  sockets[0].frame(position(211000001, HORMUZ.lat, HORMUZ.lon));
  const delays = [];
  for (let cycle = 0; cycle < 12; cycle++) {
    const ws = sockets.at(-1);
    if (cycle) ws.open();
    let checks = 0, retry;
    // Idle checks run every minute; the connection is closed once it has been silent for more than 10 minutes.
    while (!ws.closed) { clock.now += MIN; fire(pending().find(t => t.ms === 60000)); checks++; }
    assert.equal(checks, 11, `cycle ${cycle}: closed after 11 minutes of silence on this connection`);
    retry = pending().find(t => t.ms !== 60000);
    delays.push(retry.ms);
    clock.now += retry.ms;
    fire(retry);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000, 300000]);
});

test('a socket whose close never completes is dropped after a grace period and replaced through the backoff', () => {
  const { sockets, collector, clock, pending, fire } = rig({ hangingClose: true });
  collector.start();
  sockets[0].open();
  clock.now += 11 * MIN;
  fire(pending().find(t => t.ms === 60000));
  assert.equal(sockets[0].closed.code, 4000);
  assert.equal(sockets.length, 1, 'no new socket before the grace period');
  const grace = pending().find(t => t.ms === 5000);
  assert(grace, 'a 5 s grace timer');
  fire(grace);
  assert.equal(collector.snapshot().connected, false);
  assert.equal(sockets[0].onclose, null, 'the old socket is detached');
  assert.equal(sockets[0].onmessage, null);
  const retry = pending().find(t => t.ms >= 1000 && t.ms !== 60000 && t.ms !== 5000);
  assert(retry, 'a reconnect through the normal backoff');
  fire(retry);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.equal(JSON.parse(sockets[1].sent[0]).APIKey, KEY);
  // A late onclose of the dropped socket changes nothing.
  sockets[0].drop();
  assert.equal(collector.snapshot().connected, true);
  collector.stop();
  assert.equal(pending().length, 0);
});

test('a Blob frame that resolves after a reconnect or a stop is not used', async () => {
  const { sockets, collector, pending, fire } = started();
  let release;
  const slow = data => ({ size: data.length, arrayBuffer: () => new Promise(resolve => { release = () => resolve(bytes(data).buffer); }) });
  sockets[0].frame(slow(position(211000001, HORMUZ.lat, HORMUZ.lon)));
  sockets[0].drop();
  fire(pending().find(t => t.ms !== 60000));
  sockets[1].open();
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(collector.snapshot().messages, 0, 'a frame of the replaced socket is ignored');
  sockets[1].frame(slow(position(211000002, HORMUZ.lat, HORMUZ.lon)));
  collector.stop();
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(collector.snapshot().messages, 0, 'a frame resolved after stop is ignored');
});

test('an idle connection is closed and reopened; a rejected key is reported with a fixed message', () => {
  const { sockets, collector, clock, pending, fire } = started();
  clock.now += 11 * MIN;
  fire(pending().find(t => t.ms === 60000));
  assert.equal(sockets[0].closed.code, 4000);
  assert.equal(collector.snapshot().connected, false);
  assert.equal(collector.snapshot().lastError, 'No AIS messages for 10 minutes; reconnecting');
  fire(pending()[0]);
  sockets[1].open();
  sockets[1].frame(JSON.stringify({ error: `Api Key Is Not Valid ${KEY} <script>` }));
  assert.equal(collector.snapshot().lastError, 'aisstream.io rejected the subscription (check AISSTREAM_API_KEY)');
  assert.doesNotMatch(JSON.stringify(collector.snapshot()), new RegExp(KEY));
});

test('the subscription confirmation records whether compression is on; off becomes a warning', () => {
  const { sockets, collector } = started();
  assert.equal(collector.snapshot().compressionEnabled, null);
  sockets[0].frame(confirm(false));
  assert.equal(collector.snapshot().compressionEnabled, false);
  sockets[0].frame(position(211000001, HORMUZ.lat, HORMUZ.lon));
  const off = maritimeResult(collector.snapshot(), T0);
  assert.equal(off.status, 'ok');
  assert.match(off.message, /compression/);
  sockets[0].frame(confirm(true));
  assert.equal(maritimeResult(collector.snapshot(), T0).message, undefined);
});

test('without a key the briefing is the reference list, unchanged in shape', async () => {
  const out = await briefing({ apiKey: '' });
  assert.equal(out.source, 'Maritime/AIS');
  assert.equal(out.status, 'reference');
  assert.equal(Object.keys(out.chokepoints).length, 11);
  assert.deepEqual(out.chokepoints.straitOfHormuz, { label: 'Strait of Hormuz', lat: 26.5, lon: 56.5, note: '20% of world oil' });
  assert.deepEqual(out.monitoringCapabilities, []);
  assert.equal(out.observations, undefined);
  assert.deepEqual(normalizeLiveSources({ Maritime: out }, T0), [], 'a reference result is not a live source');
});

test('with a key but no running collector (one-shot CLI) the briefing stays a reference with a clear message', async () => {
  const out = await briefing({ apiKey: KEY, collector: null });
  assert.equal(out.status, 'reference');
  assert.match(out.message, /dashboard server/);
  assert.doesNotMatch(JSON.stringify(out), new RegExp(KEY));
  const stopped = rig().collector;
  assert.equal((await briefing({ apiKey: KEY, collector: stopped })).status, 'reference');
});

// 150 vessels at Hormuz, 5 at Suez (2 of them tankers, 1 anchored), all within the hour; one Suez name is hostile.
function busyStream() {
  const r = started(), { sockets, clock } = r;
  sockets[0].frame(confirm(true));
  for (let i = 0; i < 150; i++) { sockets[0].frame(position(400000000 + i, HORMUZ.lat, HORMUZ.lon + (i % 10) / 10)); clock.now += 1000; }
  for (let i = 0; i < 5; i++) { sockets[0].frame(position(500000000 + i, SUEZ.lat, SUEZ.lon, { sog: i === 0 ? 0.1 : 10 })); }
  sockets[0].frame(staticData(500000001, 'TANKER ONE', 80));
  sockets[0].frame(staticData(500000002, 'TANKER TWO', 89));
  sockets[0].frame(staticData(500000004, `EVIL${String.fromCodePoint(0x202e, 0x200b)}<img src=x onerror=alert(1)>${String.fromCodePoint(0xe0041)} SHIP`, 70));
  return { ...r, now: clock.now + 30000 };
}

test('a live briefing: one live row per chokepoint with metrics and facts, the vessels as markers, and the legacy chokepoints', async () => {
  const { collector, clock, now } = busyStream();
  const out = await briefing({ apiKey: KEY, collector, now });
  assert.equal(out.source, 'Maritime');
  assert.equal(out.status, 'ok');
  assert.equal(out.observedAt, new Date(clock.now).toISOString());
  assert.equal(out.observations.length, 11, 'only the chokepoint rows are live rows');
  const counts = out.observations, vessels = out.vessels;
  assert.deepEqual(counts.map(row => row.chokepoint), AREAS.map(area => area.id));
  const suez = counts.find(row => row.chokepoint === 'suez');
  assert.deepEqual([suez.vessels, suez.moving, suez.tankers], [5, 4, 2]);
  assert.equal(suez.title, 'Suez Canal: 5 vessels in the last hour (4 moving, 2 tankers)');
  assert.equal(suez.providerId, `ais:suez:${new Date(clock.now).toISOString().slice(0, 13)}`);
  assert.deepEqual([suez.lat, suez.lon, suez.kind], [30.5, 32.3, 'maritime']);
  assert.equal(counts.find(row => row.chokepoint === 'panama').vessels, 0);
  assert.equal(vessels.length, MAX_VESSELS);
  assert.equal(vessels.filter(v => v.area === 'suez').length, 5, 'the quiet strait keeps all of its vessels');
  assert.equal(vessels.filter(v => v.area === 'hormuz').length, 84);
  assert(vessels.every((v, i) => i === 0 || v.lastSeen <= vessels[i - 1].lastSeen), 'most recent first');
  assert.deepEqual(vessels.find(v => v.mmsi === 500000001), { name: 'TANKER ONE', mmsi: 500000001, lat: SUEZ.lat, lon: SUEZ.lon, speedKn: 10, vesselType: 'tanker', area: 'suez', lastSeen: new Date(clock.now).toISOString() });
  assert.equal(vessels.find(v => v.mmsi === 500000003).name, '', 'no name yet: the dashboard shows the MMSI');
  assert.equal(vessels.find(v => v.mmsi === 500000003).vesselType, null);
  assert.equal(vessels.find(v => v.mmsi === 500000004).name, 'EVILimg src=x onerror=alert(1) SHIP');
  assert.equal(out.metrics.suez_vessels, 5);
  assert.equal(out.metrics.hormuz_vessels, 150);
  assert.equal(Object.keys(out.metrics).length, 11);
  assert.deepEqual(out.chokepoints.suezCanal, { label: 'Suez Canal', lat: 30.5, lon: 32.3, note: '12% of world trade', vessels: 5, moving: 4, tankers: 2 });

  const [live] = normalizeLiveSources({ Maritime: out }, now);
  assert.equal(live.status, 'ok');
  assert.equal(live.observations.length, 11);
  assert.deepEqual(live.observations.find(row => row.title.startsWith('Suez Canal')).facts, [{ label: 'vessels', value: 5 }, { label: 'moving', value: 4 }, { label: 'tankers', value: 2 }]);
  assert.equal(live.metrics.suez_vessels, 5);
  assert.equal(live.vessels, undefined, 'the vessels never reach the live source');
  const events = buildEvents({ meta: { timestamp: new Date(now).toISOString() }, liveSources: [live] }, { now });
  assert.equal(events.length, 11);
  assert(events.every(event => event.kind === 'maritime'));
});

test('the dashboard draws the vessels in the maritime layer, sanitised, and keeps them out of events and history', async t => {
  const { collector, now } = busyStream();
  const out = await briefing({ apiKey: KEY, collector, now });
  // A copy edited on disk (runs/latest.json) is checked again: bad coordinates go, text is stripped and capped.
  const tampered = { ...out, vessels: [{ name: `XÉ${String.fromCodePoint(0x2066)}\u0007${'\ud800'} ${'Y'.repeat(80)}`, lat: 10, lon: 50, mmsi: 1, area: 'Not A Key', vesselType: '<b>', speedKn: 400, lastSeen: 'yesterday' },
    { name: 'NOWHERE', lat: 95, lon: 0 }, { name: '', lat: 1, lon: 1 }, null, ...out.vessels] };
  const dir = mkdtempSync(join(tmpdir(), 'crucix-ais-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = await synthesize({ crucix: { timestamp: new Date(now).toISOString() }, sources: { Maritime: tampered } }, { news: [], runsDir: dir, now });
  assert.equal(data.chokepoints.length, 11, 'the chokepoint layer is unchanged');
  assert.equal(data.aisVessels.length, MAX_VESSELS - 3, 'the first 89 entries are read; the three unusable ones are dropped');
  assert.deepEqual(data.aisVessels[0], { name: `X ${'Y'.repeat(38)}`, mmsi: null, area: null, speedKn: null, vesselType: null, lastSeen: null, lat: 10, lon: 50 }, 'every field is checked again');
  const evil = data.aisVessels.find(v => v.name.startsWith('EVIL'));
  assert.deepEqual(evil, { name: 'EVILimg src=x onerror=alert(1) SHIP', mmsi: 500000004, area: 'suez', speedKn: 10, vesselType: 'cargo', lastSeen: new Date(now - 30000).toISOString(), lat: SUEZ.lat, lon: SUEZ.lon });
  assert.equal(data.aisVessels.find(v => v.mmsi === 500000003).name, '', 'a vessel without a name stays: it has an MMSI');
  for (const v of data.aisVessels) { assert.doesNotMatch(v.name, /[\p{Cc}\p{Cf}<>]/u); assert(v.name.length <= 40); }
  const liveMaritime = data.liveSources.find(row => row.source === 'Maritime');
  assert.equal(liveMaritime.observations.length, 11);
  const names = out.vessels.map(v => v.name);
  assert.equal(data.events.filter(event => event.source?.name === 'Maritime').length, 11, 'one event per chokepoint, none per vessel');
  assert(!data.events.some(event => names.includes(event.title)), 'no vessel becomes an event');
  const history = new HistoryStore(dir, { now: () => now });
  history.add(data.events);
  assert(!history.query({ limit: 200 }).items.some(item => names.includes(item.title)), 'no vessel reaches the history');
  // Without a current live result there are no markers.
  const stale = await synthesize({ crucix: { timestamp: new Date(now).toISOString() }, sources: { Maritime: { ...tampered, status: 'stale', stale: true } } }, { news: [], runsDir: dir, now });
  assert.deepEqual(stale.aisVessels, []);
  const reference = await synthesize({ crucix: { timestamp: new Date(now).toISOString() }, sources: { Maritime: await briefing({ apiKey: '' }) } }, { news: [], runsDir: dir, now });
  assert.deepEqual(reference.aisVessels, []);
  assert.equal(reference.chokepoints.length, 11);
});

test('jarvis.html draws the AIS markers in the maritime layer through text-only popups', () => {
  const html = readFileSync(new URL('../dashboard/public/jarvis.html', import.meta.url), 'utf8');
  assert.match(html, /for\(const key of \['air','thermal','chokepoints','aisVessels',/, 'normalizeSnapshot keeps the array');
  assert.match(html, /D\.aisVessels\.forEach\(v=>\{const s=aisVesselText\(v\);points\.push\(\{[^\n]*type:'maritime'[^\n]*popHead:s\.head,popMeta:t\('maritime\.meta','AIS \(aisstream\.io\)'\),popText:s\.text,noEvent:true\}\)\}\);/);
  assert.match(html, /D\.aisVessels\.forEach\(v=>\{const s=aisVesselText\(v\);addPt\([^\n]*showPopup\(ev,s\.head,s\.text,t\('maritime\.meta','AIS \(aisstream\.io\)'\)/);
  assert.match(html, /popup\.querySelector\('\.pp-head'\)\.textContent=head/, 'popups are textContent');
  // A vessel popup never offers "Event details": vessels are no events, and a title match with one would be a false link.
  assert.match(html, /function showPopup\(event,head,text,meta,lat,lng,alt,noEvent\)\{/);
  assert.match(html, /const match=!noEvent&&D\.events\.find\(/);
  assert.match(html, /showPopup\(ev, pt\.popHead, pt\.popText, pt\.popMeta, pt\.lat, pt\.lng, pt\.alt, pt\.noEvent\)/);
  assert.match(html, /D\.aisVessels\.forEach\(v=>\{const s=aisVesselText\(v\);points\.push\(\{[^\n]*noEvent:true[^\n]*\}\)\}\);/);
  assert.match(html, /showPopup\(ev,s\.head,s\.text,t\('maritime\.meta','AIS \(aisstream\.io\)'\),null,null,null,true\)/);
  assert.match(readFileSync(new URL('../dashboard/public/pwa.js', import.meta.url), 'utf8'), /'chokepoints','aisVessels'/, 'kept offline too');
});

// aisVesselText of jarvis.html run with a locale, its t() and getAge() (as the page defines them).
function vesselText(lang) {
  const html = readFileSync(new URL('../dashboard/public/jarvis.html', import.meta.url), 'utf8');
  const code = html.match(/function aisVesselText\(v\)\{[^\n]*/);
  assert(code, 'aisVesselText is defined on one line');
  const L = { ...JSON.parse(readFileSync(new URL(`../locales/${lang}.json`, import.meta.url), 'utf8')), meta: { code: lang } };
  const t = (path, fallback) => { let value = L; for (const key of path.split('.')) { if (value && typeof value === 'object' && key in value) value = value[key]; else return fallback || path; } return value; };
  const getAge = () => `5 ${t('status.minutesAgo', 'min ago')}`;
  return vm.runInNewContext(code[0] + '\naisVesselText', { L, t, getAge, Number, Object, String });
}

test('the vessel popup is worded in the dashboard language: area, speed, type, MMSI and last signal', () => {
  const v = { name: 'TANKER ONE', mmsi: 441384000, area: 'cape_of_good_hope', speedKn: 12.5, vesselType: 'tanker', lastSeen: '2026-10-08T13:10:00.000Z', lat: -34, lon: 18 };
  assert.deepEqual({ ...vesselText('en')(v) }, { head: 'TANKER ONE', text: 'Cape of Good Hope · 12.5 kn · tanker · MMSI 441384000 · last seen 5 min ago' });
  assert.deepEqual({ ...vesselText('hu')(v) }, { head: 'TANKER ONE', text: 'Jóreménység foka · 12,5 csomó · tartályhajó · MMSI 441384000 · utolsó jelzés: 5 perce' });
  assert.deepEqual({ ...vesselText('fr')(v) }, { head: 'TANKER ONE', text: 'Cap de Bonne-Espérance · 12,5 nœuds · navire-citerne · MMSI 441384000 · dernier signal : 5 min auparavant' });
  const unnamed = { ...v, name: '', speedKn: null, vesselType: null };
  assert.deepEqual({ ...vesselText('hu')(unnamed) }, { head: 'MMSI 441384000', text: 'Jóreménység foka · ismeretlen sebesség · ismeretlen típus · utolsó jelzés: 5 perce' });
  // Every type group and chokepoint the source can emit has a word in every language.
  for (const lang of ['en', 'hu', 'fr']) {
    const render = vesselText(lang);
    for (const type of VESSEL_TYPES) assert.doesNotMatch(render({ ...v, vesselType: type }).text, /maritime\.|type_/, `${lang}: ${type}`);
    for (const area of AREAS) assert.doesNotMatch(render({ ...v, area: area.id }).text, /maritime\.|area_/, `${lang}: ${area.id}`);
  }
  for (let code = 0; code <= 99; code++) { const type = vesselType(code); assert(type === null || VESSEL_TYPES.includes(type), `code ${code}`); }
});

test('health follows the age of the newest message: ok, stale, error', () => {
  const { sockets, collector, clock } = started();
  sockets[0].frame(position(211000001, HORMUZ.lat, HORMUZ.lon));
  const at = clock.now;
  assert.equal(maritimeResult(collector.snapshot(at + 4 * MIN), at + 4 * MIN).status, 'ok');
  const stale = maritimeResult(collector.snapshot(at + 6 * MIN), at + 6 * MIN);
  assert.equal(stale.status, 'stale'); assert.equal(stale.stale, true); assert.deepEqual(stale.observations, []);
  assert.equal(Object.keys(stale.chokepoints).length, 11, 'the static layer keeps its points');
  const old = maritimeResult(collector.snapshot(at + 11 * MIN), at + 11 * MIN);
  assert.equal(old.status, 'error'); assert.equal(old.error, 'No AIS messages for more than 10 minutes');
  assert.equal(Object.keys(old.chokepoints).length, 11);
  sockets[0].drop();
  assert.equal(maritimeResult(collector.snapshot(at + MIN), at + MIN).status, 'stale', 'a short reconnect is not an outage');
  const reconnecting = maritimeResult(collector.snapshot(at + 9 * MIN), at + 9 * MIN);
  assert.equal(reconnecting.status, 'stale', 'disconnected with the last message 5-10 minutes old is stale');
  assert.equal(reconnecting.message, 'AIS stream reconnecting');
  const down = maritimeResult(collector.snapshot(at + 11 * MIN), at + 11 * MIN);
  assert.equal(down.status, 'error'); assert.equal(down.error, 'AIS stream disconnected; reconnecting');
  const waiting = rig(); waiting.collector.start(); waiting.sockets[0].open();
  assert.equal(maritimeResult(waiting.collector.snapshot(), T0 + MIN).status, 'stale');
  assert.equal(maritimeResult(waiting.collector.snapshot(), T0 + 11 * MIN).status, 'error');
  for (const result of [stale, old, down]) assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY));
});

test('after a host sleep the sweep runs the idle check first: a gap being reconnected is stale, not an outage', async () => {
  const { sockets, collector, clock, pending, fire } = started();
  sockets[0].frame(position(211000001, HORMUZ.lat, HORMUZ.lon));
  // The host slept 25 minutes: no timer fired, the collector still reports the dead connection as open.
  clock.now += 25 * MIN;
  const before = collector.snapshot();
  assert.equal(before.connected, true); assert.equal(before.lastMessageAt, T0); assert.equal(before.reconnectingSince, null);
  const woke = await briefing({ apiKey: KEY, collector, now: clock.now });
  assert.equal(woke.status, 'stale'); assert.equal(woke.stale, true); assert.deepEqual(woke.observations, []);
  assert.equal(woke.message, 'AIS stream reconnecting after a gap; waiting for messages');
  assert.equal(woke.error, undefined);
  assert.equal(Object.keys(woke.chokepoints).length, 11, 'the static layer keeps its points');
  assert.equal(sockets[0].closed.code, 4000, 'the briefing closed the dead connection');
  assert.equal(collector.snapshot().reconnectingSince, clock.now);
  // Reconnected, no message yet, within the warm-up: still stale.
  const retry = pending().find(t => t.ms !== 60000);
  clock.now += retry.ms; fire(retry);
  sockets[1].open();
  clock.now += MIN;
  assert.equal((await briefing({ apiKey: KEY, collector, now: clock.now })).status, 'stale');
  // The first message on the new connection: current again.
  sockets[1].frame(position(211000002, HORMUZ.lat, HORMUZ.lon));
  const back = await briefing({ apiKey: KEY, collector, now: clock.now });
  assert.equal(back.status, 'ok');
  assert.equal(collector.snapshot().reconnectingSince, null);
});

test('a dead connection whose close hangs is stale while it is replaced, and the sweep does not restart its close', async () => {
  const { sockets, collector, clock, pending, fire } = rig({ hangingClose: true });
  collector.start(); sockets[0].open();
  sockets[0].frame(position(211000001, HORMUZ.lat, HORMUZ.lon));
  clock.now += 25 * MIN;
  // The watchdog fired on wake and is waiting for the close; the sweep reads now.
  fire(pending().find(t => t.ms === 60000));
  const grace = pending().find(t => t.ms === 5000);
  assert(grace);
  const out = await briefing({ apiKey: KEY, collector, now: clock.now });
  assert.equal(collector.snapshot().connected, true, 'the close has not completed');
  assert.equal(out.status, 'stale'); assert.equal(out.message, 'AIS stream reconnecting after a gap; waiting for messages');
  assert.equal(grace.cleared, false, 'the pending grace timer is kept');
  assert.equal(pending().filter(t => t.ms === 5000).length, 1);
  // The grace period ends: the socket is detached and replaced through the backoff; the repair keeps its start.
  const start = clock.now;
  clock.now += 5000; fire(grace);
  const after = collector.snapshot();
  assert.equal(after.connected, false); assert.equal(sockets[0].onclose, null);
  assert.equal(after.reconnectingSince, start);
  assert.equal((await briefing({ apiKey: KEY, collector, now: clock.now })).status, 'stale');
  const retry = pending().find(t => t.ms !== 60000 && t.ms !== 30000);
  assert(retry, 'a reconnect is scheduled');
  clock.now += retry.ms; fire(retry);
  sockets[1].open();
  // A message on the new connection would end the repair; a silent one past the 2-minute window is an outage again.
  clock.now = start + 3 * MIN;
  const late = await briefing({ apiKey: KEY, collector, now: clock.now });
  assert.equal(late.status, 'error'); assert.equal(late.error, 'No AIS messages for more than 10 minutes');
  assert.equal(collector.snapshot().reconnectingSince, start);
});

test('genuine outages stay errors: failing reconnects past the 2-minute window, then no flip back to stale', async () => {
  const { sockets, collector, clock, pending, fire } = started();
  sockets[0].frame(position(211000001, HORMUZ.lat, HORMUZ.lon));
  clock.now += 25 * MIN;
  await briefing({ apiKey: KEY, collector, now: clock.now });
  const start = clock.now;
  // Every reconnect fails on the collector clock (retry, connect, close, schedule): stale while the repair is young, then failed.
  const statuses = [];
  for (let i = 0; i < 9; i++) {
    const retry = pending().find(t => t.ms !== 60000 && t.ms !== 30000);
    clock.now += retry.ms; fire(retry);
    sockets.at(-1).drop(1006);
    assert.equal(collector.snapshot().reconnectingSince, start, `attempt ${i}: the repair keeps its first start`);
    const out = await briefing({ apiKey: KEY, collector, now: clock.now });
    statuses.push(out.status);
    if (clock.now - start <= 2 * MIN) assert.equal(out.status, 'stale', `attempt ${i}`);
    else { assert.equal(out.status, 'error', `attempt ${i}`); assert.equal(out.error, 'AIS stream disconnected; reconnecting'); }
  }
  assert(statuses.includes('stale') && statuses.at(-1) === 'error');
  assert.equal(statuses.indexOf('error'), statuses.lastIndexOf('stale') + 1, 'no stale after the first error');
  // A connection that opens but stays silent, then is dropped by the server: still failed, never stale again.
  const retry = pending().find(t => t.ms !== 60000 && t.ms !== 30000);
  clock.now += retry.ms; fire(retry);
  sockets.at(-1).open();
  clock.now += MIN;
  const silent = await briefing({ apiKey: KEY, collector, now: clock.now });
  assert.equal(silent.status, 'error'); assert.equal(silent.error, 'No AIS messages for more than 10 minutes');
  sockets.at(-1).drop(1006);
  const dropped = await briefing({ apiKey: KEY, collector, now: clock.now });
  assert.equal(dropped.status, 'error'); assert.equal(dropped.error, 'AIS stream disconnected; reconnecting');
  // A rejected key is never shown as a reconnect.
  fire(pending().find(t => t.ms !== 60000 && t.ms !== 30000));
  sockets.at(-1).open();
  sockets.at(-1).frame(JSON.stringify({ error: 'Api Key Is Not Valid' }));
  sockets.at(-1).drop(1000);
  const rejected = maritimeResult(collector.snapshot(clock.now), clock.now);
  assert.equal(rejected.status, 'error'); assert.equal(rejected.error, 'aisstream.io rejected the subscription (check AISSTREAM_API_KEY)');
});

test('a handshake that never completes is abandoned after 30 seconds and retried through the backoff', () => {
  const { sockets, collector, clock, pending, fire } = rig();
  collector.start();
  const timeout = pending().find(t => t.ms === 30000);
  assert(timeout, 'a connect timeout while the socket is connecting');
  collector.check();
  assert.equal(pending().length, 1, 'check() leaves a connecting socket alone');
  clock.now += 30000; fire(timeout);
  const snap = collector.snapshot();
  assert.equal(snap.connected, false); assert.equal(snap.lastError, 'AIS stream connection timed out');
  assert.equal(snap.reconnectingSince, clock.now);
  assert.equal(sockets[0].onopen, null, 'the stuck socket is detached'); assert(sockets[0].closed);
  sockets[0].open();
  assert.equal(collector.snapshot().connected, false, 'a late open of the abandoned socket changes nothing');
  const retry = pending().find(t => t.ms !== 30000);
  clock.now += retry.ms; fire(retry);
  assert.equal(sockets.length, 2);
  const next = pending().find(t => t.ms === 30000);
  sockets[1].open();
  assert.equal(next.cleared, true, 'opening replaces the connect timeout with the idle check');
  assert(pending().some(t => t.ms === 60000));
  assert.equal(collector.snapshot().connected, true);
});

test('the rejection breaker does not leave an idle-closing socket behind, and check() does nothing once blocked', () => {
  const { sockets, collector, clock, pending, fire } = rig({ hangingClose: true, random: () => 1 });
  collector.start();
  const reject = ws => ws.frame(JSON.stringify({ error: 'Api Key Is Not Valid' }));
  for (let i = 0; i < 4; i++) { const ws = sockets.at(-1); ws.open(); reject(ws); ws.drop(1000); fire(pending().find(t => t.ms !== 60000)); }
  // The fifth connection goes silent; its idle close hangs, and the fifth rejection arrives during the grace period.
  const ws = sockets.at(-1);
  ws.open();
  clock.now += 11 * MIN;
  fire(pending().find(t => t.ms === 60000));
  assert(pending().some(t => t.ms === 5000));
  reject(ws);
  const snap = collector.snapshot();
  assert.equal(snap.blocked, true); assert.equal(snap.connected, false);
  assert.equal(ws.onclose, null, 'the closing socket is detached');
  assert.equal(pending().length, 0, 'no timer and no reconnect');
  collector.check();
  assert.equal(pending().length, 0, 'check() does not re-arm the watchdog on a blocked collector');
  assert.equal(maritimeResult(snap, clock.now).error, 'aisstream.io rejected the subscription repeatedly; check AISSTREAM_API_KEY and restart');
});

test('Maritime is registered in POLICIES, the browser policy copy, HOME and FACT_FIELDS', () => {
  const window = {};
  vm.runInContext(readFileSync(new URL('../dashboard/public/live-sources.js', import.meta.url), 'utf8'), vm.createContext({ window, Date, URL, Object, Array, Number, JSON, Set }));
  assert.deepEqual(POLICIES.Maritime, { maxAgeMs: 25 * MIN, observationMaxAgeMs: 25 * MIN });
  assert.deepEqual(JSON.parse(JSON.stringify(window.CrucixLiveSources.policies.Maritime)), POLICIES.Maritime);
  assert.match(HOME.Maritime, /^https:\/\/aisstream\.io\//);
  assert.deepEqual(FACT_FIELDS.Maritime, ['vessels', 'moving', 'tankers']);
});
