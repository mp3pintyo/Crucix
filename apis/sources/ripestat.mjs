// Public RIPE RIS routing snapshots, collected at 00:00, 08:00 and 16:00 UTC.
// https://stat.ripe.net/docs/data-api/api-endpoints/routing-status
// A snapshot is published some time after it is taken, so the freshness ceiling (POLICIES.RIPEstat)
// is the 8 h cadence plus a margin for that lag and the 30 min cache, still well under two cadences.
import { safeFetch } from '../utils/fetch.mjs';
import { POLICIES, providerTime, freshness, freshResult, unavailableResult } from '../utils/freshness.mjs';

const SOURCE = 'RIPEstat';
const MAX_AGE = POLICIES[SOURCE].maxAgeMs;
const CACHE_MS = 30 * 60000;
const cache = new Map();
const REQUEST = Object.freeze({ timeout: 10000, retries: 0, maxBytes: 2 * 1024 * 1024 });
const ATTRIBUTION = 'RIPE NCC / RIPEstat, RIS route collectors';

function asn(value) {
  if (typeof value !== 'string' || !/^AS\d{1,10}$/.test(value)) return null;
  const number = Number(value.slice(2));
  return Number.isInteger(number) && number >= 1 && number <= 4294967295 ? `AS${number}` : null;
}

function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function visibility(value) {
  const peersSeeing = count(value?.ris_peers_seeing);
  const totalPeers = count(value?.total_ris_peers);
  return { peersSeeing, totalPeers,
    fraction: peersSeeing !== null && totalPeers > 0 && peersSeeing <= totalPeers ? peersSeeing / totalPeers : null };
}

function percent(value) { return value === null ? 'unknown' : `${(value * 100).toFixed(1)}%`; }

export function parseRoutingStatus(payload, { now = Date.now(), resource } = {}) {
  const extras = { attribution: ATTRIBUTION, summary: 'RIPE RIS batch routing snapshot; collector visibility is not a diagnosis of an outage.' };
  if (payload?.error) return unavailableResult(SOURCE, payload.error, extras, now);
  if (!payload || payload.status !== 'ok') return unavailableResult(SOURCE, 'RIPEstat returned an unsuccessful response', extras, now);
  if (payload.data_call_status !== 'supported') return unavailableResult(SOURCE, 'RIPEstat routing-status endpoint is not supported', extras, now);
  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return freshResult(SOURCE, null, [], extras, now);
  const returnedAsn = typeof data.resource === 'string' ? asn(data.resource.startsWith('AS') ? data.resource : `AS${data.resource}`) : null;
  const requestedAsn = resource === undefined ? null : asn(resource);
  if (requestedAsn && returnedAsn && requestedAsn !== returnedAsn) return unavailableResult(SOURCE, 'RIPEstat returned a different resource', extras, now);
  const identifier = returnedAsn || requestedAsn;
  const v4 = visibility(data.visibility?.v4);
  const v6 = visibility(data.visibility?.v6);
  const announcedPrefixes = { v4: count(data.announced_space?.v4?.prefixes), v6: count(data.announced_space?.v6?.prefixes) };
  const observedNeighbours = count(data.observed_neighbours);
  const hasMetrics = [v4.peersSeeing, v6.peersSeeing, announcedPrefixes.v4, announcedPrefixes.v6, observedNeighbours].some(value => value !== null);
  // query_time is documented UTC; first_seen/last_seen are historical routing facts.
  const observedAt = providerTime(data.query_time, { assumeUTC: true });
  const observations = identifier && hasMetrics ? [{
    providerId: `${identifier}:${observedAt || 'unknown'}`,
    title: `${identifier} routing snapshot`,
    summary: `RIS collector batch snapshot for ${identifier}: IPv4 visibility ${percent(v4.fraction)}, IPv6 visibility ${percent(v6.fraction)}; ${observedNeighbours ?? 'unknown'} observed BGP neighbours.`,
    source: SOURCE, url: `https://stat.ripe.net/resource/${identifier}`,
    observedAt, publishedAt: observedAt, kind: 'network', severity: 'info',
    resource: identifier, visibility: { v4, v6 }, announcedPrefixes, observedNeighbours,
  }] : [];
  const metrics = { resource: identifier, ipv4VisibilityFraction: v4.fraction, ipv6VisibilityFraction: v6.fraction,
    ipv4Prefixes: announcedPrefixes.v4, ipv6Prefixes: announcedPrefixes.v6, observedNeighbours };
  return freshResult(SOURCE, observations.length ? observedAt : null, observations, { ...extras, metrics }, now);
}

async function request(resource, fetcher, now, useCache) {
  const previous = cache.get(resource);
  if (useCache && previous?.fetcher === fetcher && now >= previous.collectedAt && now - previous.collectedAt < CACHE_MS) return previous.payload;
  const url = new URL('https://stat.ripe.net/data/routing-status/data.json');
  url.searchParams.set('resource', resource); url.searchParams.set('sourceapp', 'Crucix');
  let payload;
  try { payload = await fetcher(url.href, REQUEST); }
  catch { payload = { error: 'RIPEstat request failed' }; }
  if (useCache && !payload?.error && parseRoutingStatus(payload, { now, resource }).status === 'ok') {
    if (cache.size >= 16 && !cache.has(resource)) cache.delete(cache.keys().next().value);
    cache.set(resource, { payload, fetcher, collectedAt: now });
  }
  return payload;
}

export async function briefing(options = {}) {
  const now = options.now ?? Date.now();
  const resources = options.resources === undefined ? ['AS5483'] : Array.isArray(options.resources)
    ? [...new Set(options.resources.slice(0, 100).map(asn).filter(Boolean))].slice(0, 3) : [];
  const extras = { attribution: ATTRIBUTION, summary: 'RIPE RIS batch routing snapshots; collector visibility is not a diagnosis of an outage.', resources };
  if (!resources.length) return unavailableResult(SOURCE, 'No valid AS resources requested', extras, now);
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  const results = await Promise.all(resources.map(async resource => parseRoutingStatus(await request(resource, fetcher, now, useCache), { now, resource })));
  const errors = results.map((result, index) => result.error ? { resource: resources[index], error: result.error } : null).filter(Boolean);
  if (errors.length === results.length) return unavailableResult(SOURCE, 'RIPEstat requests unavailable', { ...extras, errors }, now);
  const dates = results.map(result => result.observedAt).filter(Boolean).sort();
  const freshDates = dates.filter(date => freshness(date, MAX_AGE, now).fresh);
  const observedAt = freshDates.at(-1) || dates.at(-1) || null;
  const observations = results.flatMap(result => result.observations);
  const metrics = Object.fromEntries(results.filter(result => result.status === 'ok').map(result => [result.metrics.resource, result.metrics]));
  const result = freshResult(SOURCE, observedAt, observations, { ...extras, metrics, ...(errors.length ? { errors } : {}) }, now);
  result.rejectedObservations += results.reduce((sum, row) => sum + row.rejectedObservations, 0);
  return result;
}
