import test from 'node:test';
import assert from 'node:assert/strict';
import { detectOrbit, pickCandidates, orbitRows, briefing } from '../apis/sources/adsb-orbits.mjs';
import { resetSharedMilitaryList, sharedMilitaryList, theaterList, DEFAULT_THEATERS } from '../apis/sources/adsb-military.mjs';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const START = NOW / 1000 - 6000;                      // the trace starts 100 minutes before "now"
// A trace of `count` points every 20 s, built from a function of the point index; 380 kt ground speed unless told otherwise.
const trace = (count, at, gs = 380) => ({ timestamp: START, trace: Array.from({ length: count }, (_, i) => { const [lat, lon] = at(i); return [i * 20, lat, lon, 25000, gs, 0]; }) });
// A circle of 20 km radius, one turn every 60 points (20 minutes): five turns in 300 points.
const circle = i => [35 + 0.18 * Math.sin(i * Math.PI / 30), 35 + 0.22 * Math.cos(i * Math.PI / 30)];
// A racetrack, clockwise: a 0.4-degree leg east, a half-circle of 0.1 degrees, the leg back west, the second half-circle; 90 points a lap.
function racetrack(i) {
  const L = 0.4, R = 0.1, total = 2 * L + 2 * Math.PI * R, s = (i % 90) / 90 * total;
  if (s < L) return [35 + R, 35 - L / 2 + s];
  if (s < L + Math.PI * R) { const a = (s - L) / R; return [35 + R * Math.cos(a), 35 + L / 2 + R * Math.sin(a)]; }
  if (s < 2 * L + Math.PI * R) return [35 - R, 35 + L / 2 - (s - L - Math.PI * R)];
  const a = (s - 2 * L - Math.PI * R) / R;
  return [35 - R * Math.cos(a), 35 - L / 2 - R * Math.sin(a)];
}

test('detectOrbit: a circle and a racetrack are orbits; a straight line, a slow or grounded track, a stale track and a wide loop are not', () => {
  const round = detectOrbit(trace(300, circle), NOW);
  assert.ok(round && round.turns >= 4 && round.extentKm < 60, JSON.stringify(round));
  assert.ok(Math.abs(round.lat - 35) < 0.05 && Math.abs(round.lon - 35) < 0.05, 'the centre of the orbit');
  assert.ok(detectOrbit(trace(300, racetrack), NOW), 'a racetrack turns in one direction at each end');
  assert.equal(detectOrbit(trace(300, i => [35 + i * 0.01, 35]), NOW), null, 'a straight line');
  assert.equal(detectOrbit(trace(300, circle, 60), NOW), null, 'below 100 knots');
  assert.equal(detectOrbit({ ...trace(300, circle), trace: trace(300, circle).trace.map(r => [r[0], r[1], r[2], 'ground', 10, 0]) }, NOW), null, 'on the ground');
  assert.equal(detectOrbit(trace(300, circle), NOW + 30 * 60000), null, 'the last position is older than 10 minutes');
  assert.equal(detectOrbit(trace(300, i => [35 + 1.5 * Math.sin(i * Math.PI / 30), 35 + 2 * Math.cos(i * Math.PI / 30)]), NOW), null, 'a loop wider than 150 km');
  assert.equal(detectOrbit(trace(10, circle), NOW), null, 'too few points');
  assert.equal(detectOrbit(null, NOW), null);
  assert.equal(detectOrbit({ timestamp: 'x', trace: [] }, NOW), null);
});

const item = (hex, type, lat, lon) => ({ hex, type, lat, lon, seen: 1, callsign: '' });
test('pickCandidates: only aircraft inside a theater, surveillance-class types first, at most 12', () => {
  const specs = theaterList(DEFAULT_THEATERS);
  const unique = new Map();
  for (let i = 0; i < 20; i++) { const hex = 'a000' + i.toString(16).padStart(2, '0'); unique.set(hex, item(hex, 'H60', 48, 15)); }
  unique.set('bbbbbb', item('bbbbbb', 'RC13', 48, 15));
  unique.set('cccccc', item('cccccc', 'RC13', 0, -30));       // mid-Atlantic: no theater
  const picked = pickCandidates(unique, specs);
  assert.equal(picked.length, 12);
  assert.equal(picked[0].hex, 'bbbbbb', 'the surveillance type leads');
  assert.ok(!picked.some(entry => entry.hex === 'cccccc'));
});

test('orbitRows: one aggregate row per theater, without callsigns or ICAO addresses, at the mean centre of the orbits', () => {
  const specs = theaterList(DEFAULT_THEATERS);
  const orbit = (lat, lon, minutes) => ({ lat, lon, minutes, turns: 3, extentKm: 40 });
  const rows = orbitRows([{ spec: 3, type: 'KC35', orbit: orbit(58, 20, 90), country: 'United States' }, { spec: 3, type: 'E3TF', orbit: orbit(60, 22, 70), country: '' }, { spec: 0, type: 'P8', orbit: orbit(45, 33, 50), country: 'United States' }],
    specs, '2026-10-08T12:00:00.000Z', NOW);
  assert.equal(rows.length, 2);
  const baltic = rows.find(row => row.providerId === 'orbit:baltic');
  assert.deepEqual([baltic.aircraft, baltic.severity, baltic.lat, baltic.lon, baltic.locationMethod], [2, 'monitor', 59, 21, 'orbit-centre']);
  assert.match(baltic.types, /E3TF \(1\)/);
  assert.equal(baltic.operators, 'United States (1)');
  assert.notEqual(baltic.url, specs[3].url, 'its link differs from the ADSB-Military theater row');
  assert.equal(rows.find(row => row.providerId === 'orbit:black-sea').severity, 'info');
  assert.doesNotMatch(JSON.stringify(rows), /hex|callsign/i);
});

// A military list with two aircraft in the Baltic theater; only aircraft ae0001 has a circling trace.
const mil = { now: NOW, ac: [{ hex: 'ae0001', t: 'KC35', flight: 'QID123', lat: 58, lon: 20, alt_baro: 25000, seen_pos: 1 }, { hex: 'ae0002', t: 'C17', flight: 'RCH1', lat: 57, lon: 18, alt_baro: 30000, seen_pos: 2 }] };
function fake({ failTraces = false, failRegistry = false } = {}) {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url.endsWith('/v2/mil')) return mil;
    if (url.includes('/trace_full_')) { if (failTraces) throw new Error('down'); return url.includes('ae0001') ? trace(300, i => [58 + (circle(i)[0] - 35), 20 + (circle(i)[1] - 35)]) : trace(300, i => [57 + i * 0.005, 18]); }
    if (url.includes('adsbdb')) { if (failRegistry) throw new Error('down'); return { response: { aircraft: { registered_owner_country_name: 'United States' } } }; }
    return { error: 'unexpected' };
  };
  return { fetcher, calls };
}

test('briefing: the orbiting aircraft becomes one aggregate row; a failed registry lookup or trace is silent; a dead feed is an error', async () => {
  const ok = fake();
  const result = await briefing({ fetcher: ok.fetcher, now: NOW, shared: false });
  assert.equal(result.status, 'ok');
  assert.equal(result.observations.length, 1);
  assert.deepEqual([result.observations[0].providerId, result.observations[0].aircraft, result.observations[0].operators], ['orbit:baltic', 1, 'United States (1)']);
  assert.equal(ok.calls.filter(url => url.includes('/trace_full_')).length, 2);
  assert.equal(ok.calls.filter(url => url.includes('adsbdb')).length, 1, 'registry lookups for the orbiting aircraft only');
  const noRegistry = await briefing({ fetcher: fake({ failRegistry: true }).fetcher, now: NOW, shared: false });
  assert.equal(noRegistry.observations[0].operators, undefined);
  const noTraces = await briefing({ fetcher: fake({ failTraces: true }).fetcher, now: NOW, shared: false });
  assert.deepEqual([noTraces.status, noTraces.observations.length], ['ok', 0]);
  assert.equal((await briefing({ fetcher: async () => ({ error: 'HTTP 429' }), now: NOW, shared: false })).status, 'error');
});

test('two sources of one sweep share one request for the military list; a failed answer is not kept', async () => {
  resetSharedMilitaryList();
  let calls = 0;
  const get = async () => { calls++; return mil; };
  const [a, b] = await Promise.all([sharedMilitaryList(get, 'u'), sharedMilitaryList(get, 'u')]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  resetSharedMilitaryList();
  const bad = async () => { calls++; return { error: 'HTTP 429' }; };
  await sharedMilitaryList(bad, 'u');
  const before = calls;
  await sharedMilitaryList(get, 'u');
  assert.equal(calls, before + 1, 'after an error the next caller asks again');
  resetSharedMilitaryList();
});
