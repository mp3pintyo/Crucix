import test from 'node:test';
import assert from 'node:assert/strict';
import { briefing, resetState } from '../apis/sources/opensky.mjs';
import { runSource } from '../apis/briefing.mjs';

const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const now = Date.parse('2026-10-08T12:00:00Z');
const MINUTE = 60000;
const ID = 'crucix-test-client';
const SECRET = 'top-secret-client-value';
// states: [icao24, callsign, origin_country, time_position, last_contact, lon, lat, baro_altitude, ...]
const STATES = { time: 1, states: [['abc123', 'DLH1  ', 'Germany', 0, 0, 10, 50, 11000], ['def456', '', 'Turkey', 0, 0, 30, 40, 13000]] };
const json = (body, init) => new Response(JSON.stringify(body), { status: 200, ...init });

function useEnv(t, id, secret) {
  const saved = { OPENSKY_CLIENT_ID: process.env.OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET: process.env.OPENSKY_CLIENT_SECRET };
  const set = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  set('OPENSKY_CLIENT_ID', id); set('OPENSKY_CLIENT_SECRET', secret);
  t.after(() => { for (const [key, value] of Object.entries(saved)) set(key, value); });
  resetState();
}

// Routes the token endpoint and /states/all; records every request.
function mockOpenSky(t, { token = n => json({ access_token: `tok-${n}`, expires_in: 1800 }), states = () => json(STATES) } = {}) {
  const calls = { token: [], states: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === TOKEN_URL) { calls.token.push(init); return token(calls.token.length, init); }
    const auth = new Headers(init.headers).get('authorization');
    calls.states.push({ url: String(url), auth });
    return states({ url: String(url), auth, n: calls.states.length, init });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('without credentials every hotspot is requested anonymously', async t => {
  useEnv(t, undefined, undefined);
  const calls = mockOpenSky(t);
  const result = await briefing({ now });
  assert.equal(calls.token.length, 0);
  assert.equal(calls.states.length, 10);
  assert.ok(calls.states.every(call => call.auth === null), 'no Authorization header');
  assert.equal(result.source, 'OpenSky'); assert.equal(result.hotspots.length, 10);
  assert.equal(result.error, undefined); assert.equal(result.stale, undefined);
  const first = result.hotspots[0];
  assert.deepEqual({ region: first.region, key: first.key, totalAircraft: first.totalAircraft, noCallsign: first.noCallsign, highAltitude: first.highAltitude },
    { region: 'Middle East', key: 'middleEast', totalAircraft: 2, noCallsign: 1, highAltitude: 1 });
  assert.deepEqual(first.byCountry, { Germany: 1, Turkey: 1 });
});

test('only one of the two credentials falls back to anonymous access and says so', async t => {
  useEnv(t, ID, undefined);
  const calls = mockOpenSky(t);
  const result = await briefing({ now });
  assert.equal(calls.token.length, 0);
  assert.ok(calls.states.every(call => call.auth === null));
  assert.equal(result.error, undefined);
  assert.match(result.message, /OPENSKY_CLIENT_ID/); assert.match(result.message, /OPENSKY_CLIENT_SECRET/); assert.match(result.message, /anonymous/i);
  const cached = await briefing({ now: now + MINUTE });
  assert.equal(cached.stale, true); assert.equal(calls.states.length, 10);
  assert.match(cached.message, /Cached OpenSky result/); assert.match(cached.message, /Only one of OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET/);
});

test('with credentials ten parallel hotspots share one token request and all send the Bearer token', async t => {
  useEnv(t, ID, SECRET);
  const calls = mockOpenSky(t);
  const result = await briefing({ now });
  assert.equal(calls.token.length, 1, 'singleflight token request');
  const init = calls.token[0];
  assert.equal(init.method, 'POST');
  assert.equal(new Headers(init.headers).get('content-type'), 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(String(init.body));
  assert.deepEqual(Object.fromEntries(form), { grant_type: 'client_credentials', client_id: ID, client_secret: SECRET });
  assert.ok(init.signal, 'the token request is bounded');
  assert.equal(init.redirect, 'error', 'the client secret is never replayed to a redirect target');
  assert.equal(calls.states.length, 10);
  assert.ok(calls.states.every(call => call.auth === 'Bearer tok-1'));
  assert.equal(result.error, undefined);
  assert.doesNotMatch(JSON.stringify(result), /tok-1|top-secret/);
});

test('the token is reused until 30 s before expires_in and refreshed after that', async t => {
  useEnv(t, ID, SECRET);
  const calls = mockOpenSky(t);
  await briefing({ now });
  await briefing({ now: now + 1769 * 1000 });
  assert.equal(calls.token.length, 1, 'still valid 31 s before the 1800 s expiry');
  assert.ok(calls.states.slice(10).every(call => call.auth === 'Bearer tok-1'));
  resetState();
  calls.token.length = 0; calls.states.length = 0;
  await briefing({ now });
  await briefing({ now: now + 1771 * 1000 });
  assert.equal(calls.token.length, 2, 'refreshed 29 s before the 1800 s expiry');
  assert.ok(calls.states.slice(10).every(call => call.auth === 'Bearer tok-2'));
});

test('a short expires_in is honoured', async t => {
  useEnv(t, ID, SECRET);
  const calls = mockOpenSky(t, { token: n => json({ access_token: `tok-${n}`, expires_in: 600 }) });
  await briefing({ now });
  await briefing({ now: now + 15 * MINUTE });
  assert.equal(calls.token.length, 2);
});

test('expires_in is clamped to 24 hours at most', async t => {
  useEnv(t, ID, SECRET);
  const calls = mockOpenSky(t, { token: n => json({ access_token: `tok-${n}`, expires_in: 1e9 }) });
  await briefing({ now });
  await briefing({ now: now + 86400 * 1000 });
  assert.equal(calls.token.length, 2);
});

test('expires_in is clamped to 60 s at least, so a fresh token is not refetched within the round', async t => {
  useEnv(t, ID, SECRET);
  let releaseLate;
  const late = new Promise(resolve => { releaseLate = resolve; });
  const calls = mockOpenSky(t, {
    token: n => json({ access_token: `tok-${n}`, expires_in: 1 }),
    states: async ({ auth, n }) => {
      if (auth === 'Bearer tok-1') { if (n > 1) await late; return new Response('expired', { status: 401 }); }
      releaseLate();
      return json(STATES);
    },
  });
  await briefing({ now });
  assert.equal(calls.token.length, 2);
});

test('HTTP 401 invalidates the token, fetches one new token for all hotspots and retries each hotspot once', async t => {
  useEnv(t, ID, SECRET);
  const calls = mockOpenSky(t, { states: ({ auth }) => auth === 'Bearer tok-1' ? new Response('expired', { status: 401 }) : json(STATES) });
  const result = await briefing({ now });
  assert.equal(calls.token.length, 2, 'one refresh shared by ten concurrent 401s');
  assert.equal(calls.states.length, 20);
  assert.ok(calls.states.slice(10).every(call => call.auth === 'Bearer tok-2'));
  assert.equal(result.error, undefined);
  assert.equal(result.hotspots[0].totalAircraft, 2);
});

test('a late HTTP 401 for the old token neither clears the refreshed token nor requests a third one', async t => {
  useEnv(t, ID, SECRET);
  let releaseLate;
  const late = new Promise(resolve => { releaseLate = resolve; });
  const calls = mockOpenSky(t, { states: async ({ auth, n }) => {
    if (auth === 'Bearer tok-1') {
      if (n > 1) await late; // nine hotspots answer only after the refreshed token is in use
      return new Response('expired', { status: 401 });
    }
    releaseLate();
    return json(STATES);
  } });
  const result = await briefing({ now });
  assert.equal(calls.token.length, 2, 'the late 401s reuse tok-2');
  assert.equal(calls.states.length, 20);
  assert.ok(calls.states.filter(call => call.auth !== 'Bearer tok-1').every(call => call.auth === 'Bearer tok-2'));
  assert.equal(result.error, undefined);
});

test('a persistent HTTP 401 is retried only once per hotspot', async t => {
  useEnv(t, ID, SECRET);
  const calls = mockOpenSky(t, { states: () => new Response('denied', { status: 401 }) });
  const result = await briefing({ now });
  assert.equal(calls.token.length, 2);
  assert.equal(calls.states.length, 20);
  assert.match(result.error, /HTTP 401/);
});

test('a round never outlasts its 25 s budget, so it cannot outlive the 30 s source race', async t => {
  useEnv(t, ID, SECRET);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const hang = init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const after = (ms, response) => new Promise(resolve => setTimeout(() => resolve(response), ms));
  const token = n => json({ access_token: `tok-${n}`, expires_in: 1800 });
  // Every request takes as long as the fake clock lets it: a hung request ends only when its own timeout aborts it.
  const run = async () => {
    resetState();
    calls.token.length = 0; calls.states.length = 0;
    const start = Date.now(); let end = null;
    const pending = briefing().then(result => { end = Date.now(); return result; });
    for (let i = 0; i < 600 && end === null; i++) { t.mock.timers.tick(100); await new Promise(resolve => setImmediate(resolve)); }
    assert.notEqual(end, null, 'the round finished within 60 s of fake time');
    return { result: await pending, elapsed: end - start };
  };
  let tokenImpl, statesImpl;
  const calls = mockOpenSky(t, { token: (n, init) => tokenImpl(n, init), states: args => statesImpl(args) });

  // Slow token, 401 late in the round, refresh that never answers.
  tokenImpl = (n, init) => n === 1 ? after(4000, token(1)) : hang(init);
  statesImpl = () => after(13000, new Response('expired', { status: 401 }));
  let { result, elapsed } = await run();
  assert.ok(elapsed <= 25000, `slow refresh: ${elapsed} ms`); assert.equal(calls.token.length, 2, 'the refresh was attempted');
  assert.match(result.hotspotErrors[0].error, /token refresh failed: token request timed out/);

  // Early 401, quick refresh, retry that never answers.
  tokenImpl = n => token(n);
  statesImpl = ({ auth, init }) => auth === 'Bearer tok-1' ? after(6000, new Response('expired', { status: 401 })) : hang(init);
  ({ result, elapsed } = await run());
  assert.ok(elapsed <= 25000, `slow retry: ${elapsed} ms`); assert.match(result.error, /timed out/);

  // 401 so late that no refresh fits: reported as an error without another token request.
  let tokens = 0;
  tokenImpl = n => { tokens++; return after(4000, token(n)); };
  statesImpl = () => after(19500, new Response('expired', { status: 401 }));
  ({ result, elapsed } = await run());
  assert.ok(elapsed <= 25000, `late 401: ${elapsed} ms`); assert.equal(tokens, 1, 'no refresh without budget');
  assert.match(result.hotspotErrors[0].error, /HTTP 401/);
});

test('a failing token endpoint is an authentication error without secrets and without a silent anonymous fallback', async t => {
  useEnv(t, ID, SECRET);
  let reply;
  const calls = mockOpenSky(t, { token: () => reply() });
  for (reply of [
    () => new Response(`invalid_client ${SECRET}`, { status: 401 }),
    () => new Response(`{"echo":"${SECRET}"`, { status: 200 }),
    () => json({ token_type: 'bearer' }),
    () => json({ access_token: 'tok with space', expires_in: 1800 }),
    () => json({ access_token: 'tok\r\nX-Injected: 1', expires_in: 1800 }),
    () => json({ access_token: 'tök', expires_in: 1800 }),
    () => json({ access_token: 42, expires_in: 1800 }),
    () => { throw new Error(`connect failed client_secret=${SECRET}`); },
  ]) {
    resetState();
    const result = await briefing({ now });
    assert.equal(calls.states.length, 0, 'no anonymous requests');
    assert.match(result.error, /authentication failed/i);
    assert.match(result.error, /no anonymous fallback/i);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
    assert.equal(result.hotspots.length, 10);
  }
});

test('HTTP 429 is not retried and blocks every request until the provider retry time', async t => {
  useEnv(t, undefined, undefined);
  const calls = mockOpenSky(t, { states: () => new Response('limit', { status: 429, headers: { 'X-Rate-Limit-Retry-After-Seconds': '3600', 'X-Rate-Limit-Remaining': '0' } }) });
  const result = await briefing({ now });
  assert.equal(calls.states.length, 10, 'no retry on 429');
  const until = new Date(now + 3600 * 1000).toISOString();
  assert.match(result.error, /credit limit reached/i); assert.ok(result.error.includes(until));
  const blocked = await briefing({ now: now + 30 * MINUTE });
  assert.equal(calls.states.length, 10, 'no request while blocked');
  assert.match(blocked.error, /credit limit reached/i); assert.ok(blocked.error.includes(until));
  assert.equal(blocked.hotspots.length, 10);
  await briefing({ now: now + 61 * MINUTE });
  assert.equal(calls.states.length, 20, 'requests resume after the retry time');
});

test('while blocked by HTTP 429 the last good result is served as stale', async t => {
  useEnv(t, ID, SECRET);
  let limited = false;
  const calls = mockOpenSky(t, { states: () => limited ? new Response('limit', { status: 429, headers: { 'X-Rate-Limit-Retry-After-Seconds': '7200' } }) : json(STATES) });
  const good = await briefing({ now });
  limited = true;
  const hit = await briefing({ now: now + 15 * MINUTE });
  assert.equal(calls.states.length, 20);
  assert.equal(hit.stale, true); assert.equal(hit.error, undefined);
  assert.deepEqual(hit.hotspots, good.hotspots); assert.equal(hit.timestamp, good.timestamp, 'the original observation time is kept');
  assert.match(hit.message, /credit limit/i);
  const later = await briefing({ now: now + 60 * MINUTE });
  assert.equal(calls.states.length, 20, 'no request while blocked');
  assert.equal(later.stale, true); assert.deepEqual(later.hotspots, good.hotspots);
});

test('a huge X-Rate-Limit-Retry-After-Seconds blocks for 24 hours at most and never throws', async t => {
  useEnv(t, undefined, undefined);
  const calls = mockOpenSky(t, { states: () => new Response('limit', { status: 429, headers: { 'X-Rate-Limit-Retry-After-Seconds': '99999999999999999' } }) });
  const result = await briefing({ now });
  const until = new Date(now + 24 * 60 * MINUTE).toISOString();
  assert.ok(result.error.includes(until), result.error);
  assert.ok((await briefing({ now: now + 24 * 60 * MINUTE - 1 })).error.includes(until));
  assert.equal(calls.states.length, 10);
  await briefing({ now: now + 24 * 60 * MINUTE });
  assert.equal(calls.states.length, 20, 'requests resume after 24 hours');
});

test('HTTP 429 without X-Rate-Limit-Retry-After-Seconds blocks for the round interval', async t => {
  useEnv(t, undefined, undefined);
  const calls = mockOpenSky(t, { states: () => new Response('limit', { status: 429 }) });
  const result = await briefing({ now });
  const until = new Date(now + 120 * MINUTE).toISOString();
  assert.ok(result.error.includes(until), result.error);
  assert.ok((await briefing({ now: now + 119 * MINUTE })).error.includes(until));
  assert.equal(calls.states.length, 10, 'no request while blocked');
});

test('stale data is served for at most 3 hours while blocked, then the credit-limit error', async t => {
  useEnv(t, undefined, undefined);
  let limited = false;
  const calls = mockOpenSky(t, { states: () => limited ? new Response('limit', { status: 429, headers: { 'X-Rate-Limit-Retry-After-Seconds': String(6 * 3600) } }) : json(STATES) });
  const good = await briefing({ now });
  limited = true;
  const hit = await briefing({ now: now + 120 * MINUTE });
  assert.equal(hit.stale, true); assert.deepEqual(hit.hotspots, good.hotspots);
  const edge = await briefing({ now: now + 180 * MINUTE });
  assert.equal(edge.stale, true, 'three hours old is still served'); assert.equal(edge.error, undefined);
  const expired = await briefing({ now: now + 180 * MINUTE + 1 });
  assert.equal(expired.stale, undefined);
  assert.match(expired.error, /credit limit reached; retry after 2026-10-08T20:00:00\.000Z/);
  assert.equal(expired.hotspots.length, 10); assert.ok(expired.hotspots.every(h => h.error && h.totalAircraft === 0));
  assert.equal(calls.states.length, 20, 'no request while blocked');
});

test('an anonymous round inside the 120-minute interval (less 60 s slack) returns the cached result without fetching', async t => {
  useEnv(t, undefined, undefined);
  const calls = mockOpenSky(t);
  const first = await briefing({ now });
  const cached = await briefing({ now: now + 118 * MINUTE });
  assert.equal(calls.states.length, 10);
  assert.equal(cached.stale, true); assert.deepEqual(cached.hotspots, first.hotspots); assert.equal(cached.timestamp, first.timestamp);
  assert.match(cached.message, /next request after 2026-10-08T13:59:00\.000Z/);
  assert.equal(first.stale, undefined, 'the cached copy does not alter the original');
  await briefing({ now: now + 119 * MINUTE });
  assert.equal(calls.states.length, 20);
});

test('an authenticated round inside the 15-minute interval (less 60 s slack) returns the cached result without fetching', async t => {
  useEnv(t, ID, SECRET);
  const calls = mockOpenSky(t);
  await briefing({ now });
  assert.equal((await briefing({ now: now + 14 * MINUTE - 1 })).stale, true);
  assert.equal(calls.states.length, 10);
  await briefing({ now: now + 14 * MINUTE });
  assert.equal(calls.states.length, 20);
});

test('a 15-minute sweep that fires a few seconds early still refreshes', async t => {
  useEnv(t, ID, SECRET);
  const calls = mockOpenSky(t);
  let at = now;
  for (const jitter of [0, -3000, 2000, -5000, -1000]) {
    at += 15 * MINUTE + jitter;
    const result = await briefing({ now: at });
    assert.equal(result.stale, undefined, `sweep ${new Date(at).toISOString()}`);
  }
  assert.equal(calls.states.length, 50);
});

test('a cached round reaches the orchestrator as stale, not as an error', async t => {
  useEnv(t, undefined, undefined);
  mockOpenSky(t);
  assert.equal((await runSource('OpenSky', () => briefing({ now }))).status, 'ok');
  assert.equal((await runSource('OpenSky', () => briefing({ now: now + MINUTE }))).status, 'stale');
});

test('a round without any successful hotspot does not start the interval', async t => {
  useEnv(t, undefined, undefined);
  let down = true;
  const calls = mockOpenSky(t, { states: () => down ? new Response('down', { status: 404 }) : json(STATES) });
  const failed = await briefing({ now });
  assert.match(failed.error, /unavailable across all hotspots/);
  down = false;
  const next = await briefing({ now: now + MINUTE });
  assert.equal(calls.states.length, 20); assert.equal(next.error, undefined);
});
