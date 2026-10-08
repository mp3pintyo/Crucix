// OpenSky Network — Real-time flight tracking
// Free for research. Tracks all aircraft with ADS-B transponders including many military.
// API credits per day: 400 anonymous, 4,000 with an account, 8,000 for active feeders.
// A /states/all box costs 1-4 credits by area; one round over the hotspots below costs 28.
// Authentication is OAuth2 client credentials only (basic auth was removed on 2026-03-18):
// https://opensky-network.org/my-opensky/account -> "Create a new API client" -> the
// clientId/clientSecret of credentials.json go into OPENSKY_CLIENT_ID/OPENSKY_CLIENT_SECRET.

import { safeFetch, readBoundedText } from '../utils/fetch.mjs';
import '../utils/env.mjs';

const BASE = 'https://opensky-network.org/api';
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const MINUTE = 60000;
const TOKEN_MARGIN_MS = 30000; // refresh a token 30 s before it expires
// Minimum time between rounds, less INTERVAL_SLACK_MS so a sweep timer firing a little early still refreshes.
// With the 15-minute sweep: 96 rounds = 2,688 credits/day (of 4,000) and 12 rounds = 336 (of 400);
// even back-to-back at interval - slack: at most 103 rounds = 2,884 and 13 rounds = 364.
const MIN_INTERVAL_MS = { authenticated: 15 * MINUTE, anonymous: 120 * MINUTE };
const INTERVAL_SLACK_MS = MINUTE;
const MAX_STALE_MS = 180 * MINUTE; // oldest result served as stale while requests are blocked
const MAX_BLOCK_MS = 24 * 60 * MINUTE; // credits reset daily; a larger retry header is not trusted
// A round must end before the orchestrator's 30 s source race.
const ROUND_BUDGET_MS = 25000;
const TOKEN_TIMEOUT_MS = 5000;
const HOTSPOT_TIMEOUT_MS = 20000;
const MIN_REQUEST_MS = 2000; // a request is not started with less time than this left

let tokenCache = { token: null, expiresAt: 0 };
let tokenRequest = null;                  // in-flight token request shared by the parallel hotspots
let lastRound = { at: 0, result: null };  // last round that got data (and so spent credits)
let blockedUntil = 0;                     // set by HTTP 429 from X-Rate-Limit-Retry-After-Seconds

export function resetState() {
  tokenCache = { token: null, expiresAt: 0 };
  tokenRequest = null;
  lastRound = { at: 0, result: null };
  blockedUntil = 0;
}

function credentials() {
  const id = process.env.OPENSKY_CLIENT_ID, secret = process.env.OPENSKY_CLIENT_SECRET;
  if (id && secret) return { id, secret };
  if (id || secret) return { warning: 'Only one of OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET is set; using anonymous access' };
  return {};
}

// Never returns the response body or the exception text: either could echo the client secret.
async function requestToken({ id, secret }, now, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout); // covers the body read too
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Crucix/2.2' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
      redirect: 'error', // never replay the client secret to a redirect target
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { error: `HTTP ${res.status}` };
    }
    let data = null;
    const text = await readBoundedText(res, 64 * 1024);
    try { data = JSON.parse(text); } catch { /* reported below */ }
    // Printable ASCII only: anything else must never reach an Authorization header.
    if (typeof data?.access_token !== 'string' || !/^[\x21-\x7e]+$/.test(data.access_token)) return { error: 'response without access_token' };
    const lifetime = Number(data.expires_in) > 0 ? Math.min(86400, Math.max(60, Number(data.expires_in))) : 1800;
    tokenCache = { token: data.access_token, expiresAt: now + lifetime * 1000 - TOKEN_MARGIN_MS };
    return { token: data.access_token };
  } catch {
    return { error: controller.signal.aborted ? 'token request timed out' : 'token request failed' };
  } finally { clearTimeout(timer); }
}

function getToken(creds, now, timeout) {
  if (tokenCache.token && now < tokenCache.expiresAt) return Promise.resolve({ token: tokenCache.token });
  tokenRequest ??= requestToken(creds, now, timeout).finally(() => { tokenRequest = null; });
  return tokenRequest;
}

// Get all current flights (global state vector)
export async function getAllFlights() {
  return safeFetch(`${BASE}/states/all`, { timeout: 30000 });
}

// Get flights in a bounding box (lat/lon)
export async function getFlightsInArea(lamin, lomin, lamax, lomax, opts = {}) {
  const params = new URLSearchParams({
    lamin: String(lamin),
    lomin: String(lomin),
    lamax: String(lamax),
    lomax: String(lomax),
  });
  return safeFetch(`${BASE}/states/all?${params}`, { timeout: 20000, ...opts });
}

// Get flights by specific aircraft (ICAO24 hex codes)
export async function getFlightsByIcao(icao24List) {
  const icao = Array.isArray(icao24List) ? icao24List : [icao24List];
  const params = icao.map(i => `icao24=${i}`).join('&');
  return safeFetch(`${BASE}/states/all?${params}`, { timeout: 20000 });
}

// Get departures from an airport in a time range
export async function getDepartures(airportIcao, begin, end) {
  const params = new URLSearchParams({
    airport: airportIcao,
    begin: String(Math.floor(begin / 1000)),
    end: String(Math.floor(end / 1000)),
  });
  return safeFetch(`${BASE}/flights/departure?${params}`);
}

// Get arrivals at an airport
export async function getArrivals(airportIcao, begin, end) {
  const params = new URLSearchParams({
    airport: airportIcao,
    begin: String(Math.floor(begin / 1000)),
    end: String(Math.floor(end / 1000)),
  });
  return safeFetch(`${BASE}/flights/arrival?${params}`);
}

// Key hotspot regions for monitoring
const HOTSPOTS = {
  middleEast: { lamin: 12, lomin: 30, lamax: 42, lomax: 65, label: 'Middle East' },
  taiwan: { lamin: 20, lomin: 115, lamax: 28, lomax: 125, label: 'Taiwan Strait' },
  ukraine: { lamin: 44, lomin: 22, lamax: 53, lomax: 41, label: 'Ukraine Region' },
  baltics: { lamin: 53, lomin: 19, lamax: 60, lomax: 29, label: 'Baltic Region' },
  southChinaSea: { lamin: 5, lomin: 105, lamax: 23, lomax: 122, label: 'South China Sea' },
  koreanPeninsula: { lamin: 33, lomin: 124, lamax: 43, lomax: 132, label: 'Korean Peninsula' },
  caribbean: { lamin: 18, lomin: -90, lamax: 30, lomax: -72, label: 'Caribbean' },
  gulfOfGuinea: { lamin: -2, lomin: -5, lamax: 8, lomax: 10, label: 'Gulf of Guinea' },
  capeRoute: { lamin: -38, lomin: 12, lamax: -28, lomax: 24, label: 'Cape Route' },
  hornOfAfrica: { lamin: 5, lomin: 40, lamax: 15, lomax: 55, label: 'Horn of Africa' },
};

// One hotspot; on HTTP 401 the token is replaced once (shared by all hotspots) and the hotspot retried once,
// if the round's remaining time allows it. No request may run past the deadline.
async function fetchHotspot(box, creds, token, now, deadline) {
  const remaining = () => deadline - Date.now();
  const get = bearer => getFlightsInArea(box.lamin, box.lomin, box.lamax, box.lomax, {
    timeout: Math.max(1, Math.min(HOTSPOT_TIMEOUT_MS, remaining())), retries: 0, retryAfterHeader: 'x-rate-limit-retry-after-seconds',
    ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
  });
  const data = await get(token);
  if (!token || data?.status !== 401) return data;
  if (tokenCache.token === token) tokenCache = { token: null, expiresAt: 0 };
  const noTime = { error: 'HTTP 401; no time left in this round to refresh the token' };
  if (remaining() < TOKEN_TIMEOUT_MS + MIN_REQUEST_MS) return noTime;
  const session = await getToken(creds, now, TOKEN_TIMEOUT_MS);
  if (session.error) return { error: `HTTP 401; token refresh failed: ${session.error}` };
  return remaining() < MIN_REQUEST_MS ? noTime : get(session.token);
}

// A result for the whole source without any request.
function failure(error, now) {
  const hotspots = Object.entries(HOTSPOTS).map(([key, box]) => ({
    region: box.label, key, totalAircraft: 0, byCountry: {}, noCallsign: 0, highAltitude: 0, error,
  }));
  return { source: 'OpenSky', timestamp: new Date(now).toISOString(), hotspots, error,
    hotspotErrors: hotspots.map(h => ({ region: h.region, error })) };
}

function cached(message) {
  const { warning } = credentials();
  return { ...lastRound.result, stale: true, message: warning ? `${message}; ${warning}` : message };
}

function blocked(now) {
  const message = `OpenSky credit limit reached; retry after ${new Date(blockedUntil).toISOString()}`;
  const age = now - lastRound.at;
  return lastRound.result && age >= 0 && age <= MAX_STALE_MS ? cached(message) : failure(message, now);
}

// Briefing — check hotspot regions for flight activity
export async function briefing({ now = Date.now() } = {}) {
  if (now < blockedUntil) return blocked(now);
  const deadline = Date.now() + ROUND_BUDGET_MS;
  const creds = credentials();
  const interval = creds.secret ? MIN_INTERVAL_MS.authenticated : MIN_INTERVAL_MS.anonymous;
  const nextRound = lastRound.at + interval - INTERVAL_SLACK_MS; // always within MAX_STALE_MS of lastRound
  if (lastRound.result && now >= lastRound.at && now < nextRound) {
    return cached(`Cached OpenSky result; next request after ${new Date(nextRound).toISOString()}`);
  }
  let token = null;
  if (creds.secret) {
    const session = await getToken(creds, now, TOKEN_TIMEOUT_MS);
    if (session.error) {
      return failure(`OpenSky authentication failed (${session.error}); no anonymous fallback, check OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET`, now);
    }
    token = session.token;
  }

  const limits = []; // waits requested by HTTP 429 answers
  const hotspotEntries = Object.entries(HOTSPOTS);
  const results = await Promise.all(
    hotspotEntries.map(async ([key, box]) => {
      const data = await fetchHotspot(box, creds, token, now, deadline);
      if (data?.status === 429) limits.push(data.retryAfterMs ?? interval);
      const error = data?.error || null;
      const states = data?.states || [];
      return {
        region: box.label,
        key,
        totalAircraft: states.length,
        // states format: [icao24, callsign, origin_country, ...]
        byCountry: states.reduce((acc, s) => {
          const country = s[2] || 'Unknown';
          acc[country] = (acc[country] || 0) + 1;
          return acc;
        }, {}),
        // Flag potentially interesting (military often have no callsign or specific patterns)
        noCallsign: states.filter(s => !s[1]?.trim()).length,
        highAltitude: states.filter(s => s[7] && s[7] > 12000).length, // >12km altitude
        ...(error ? { error } : {}),
      };
    })
  );

  const hotspotErrors = results
    .filter(r => r.error)
    .map(r => ({ region: r.region, error: r.error }));

  const result = {
    source: 'OpenSky',
    timestamp: new Date(now).toISOString(),
    hotspots: results,
    ...(hotspotErrors.length ? {
      error: hotspotErrors.length === results.length
        ? `OpenSky unavailable across all hotspots: ${hotspotErrors[0].error}`
        : `OpenSky unavailable for ${hotspotErrors.length}/${results.length} hotspots`,
      hotspotErrors,
    } : {}),
    ...(creds.warning ? { message: creds.warning } : {}),
  };
  if (hotspotErrors.length < results.length) lastRound = { at: now, result };
  if (limits.length) {
    blockedUntil = now + Math.min(MAX_BLOCK_MS, Math.max(...limits));
    if (hotspotErrors.length === results.length) return blocked(now);
  }
  return result;
}

if (process.argv[1]?.endsWith('opensky.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
