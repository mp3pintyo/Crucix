// Orbital launches: the next ones (within 14 days) and the last ones (within 7 days) from The Space Devs' Launch Library 2.
// https://ll.thespacedevs.com/2.3.0/launches/{upcoming,previous}/?mode=normal (no key; checked live on 2026-10-08 from Hungary: HTTP 200, 0.3-0.9 s, about
// 10 KB a launch; anonymous use is limited to 15 calls an hour, so a sweep makes 2 and the answers are cached for 15 minutes). Idea and endpoint from God's
// Eye View (bilawalsidhu/gods-eye-view, MIT); the adapter is Crucix's own.
// One row per launch, located at its pad. Launches of a government or military payload (mission type "Government/Top Secret" or "Military") are rated
// moderate and a failed launch elevated; everything else is informational. The row's observation time is the entry's `last_updated`; the launch time is
// `startsAt`. Launch Library gives launch context and timing, not live telemetry; "net" is the no-earlier-than time and can move.
import { safeFetch } from '../utils/fetch.mjs';
import { providerTime, freshResult, unavailableResult } from '../utils/freshness.mjs';

const SOURCE = 'Launch-Library';
const BASE = 'https://ll.thespacedevs.com/2.3.0/launches';
const PAGE = 'https://thespacedevs.com/llapi';
const REQUEST = Object.freeze({ timeout: 15000, retries: 0, maxBytes: 2 * 1024 * 1024, headers: Object.freeze({ 'User-Agent': 'Crucix/2.x' }) });
const DAY = 86400000;
const AHEAD_MS = 14 * DAY;
const BEHIND_MS = 7 * DAY;
const MAX_ROWS = 24;
const CACHE_MS = 15 * 60000;
const MILITARY = /^(government\/top secret|military|government)/i;
const FAILED = new Set([4, 7]); // Launch Failure, Launch was a Partial Failure
const state = { at: 0, result: null };
const EXTRAS = {
  attribution: 'The Space Devs, Launch Library 2 (https://thespacedevs.com/llapi)',
  rights: 'Launch Library 2 data may be used and shared in any form; attribution is encouraged. Anonymous use is limited to 15 calls an hour.',
  license: 'The Space Devs terms of use',
  licenseUrl: 'https://github.com/TheSpaceDevs/Tutorials/blob/main/faqs/faq_TSD.md#terms-of-use',
  summary: 'Orbital launches in the next 14 days and the last 7 days, located at their launch pad. "Net" is the no-earlier-than time and can move; this is launch context, not live telemetry.'
};

const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const num = value => { const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value; return typeof n === 'number' && Number.isFinite(n) ? n : null; };

/** One Launch Library 2 entry as a row, or null when it lacks a name, a launch time, a pad position or an update time. */
export function launchRow(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, 140), id = text(raw.id, 60);
  const net = providerTime(raw.net), updated = providerTime(raw.last_updated);
  const lat = num(raw.pad?.latitude), lon = num(raw.pad?.longitude);
  if (!name || !id || !net || !updated || lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const offset = Date.parse(net) - now;
  if (offset > AHEAD_MS || offset < -BEHIND_MS) return null;
  const missionType = text(raw.mission?.type, 60), orbit = text(raw.mission?.orbit?.abbrev, 12), provider = text(raw.launch_service_provider?.name, 80);
  const rocket = text(raw.rocket?.configuration?.full_name, 100) || name.split('|')[0].trim();
  const pad = text(raw.pad?.name, 80), site = text(raw.pad?.location?.name, 100), status = text(raw.status?.name, 40);
  const done = offset < 0;
  const severity = FAILED.has(raw.status?.id) ? 'elevated' : MILITARY.test(missionType) ? 'moderate' : 'info';
  return { kind: 'launch', providerId: `ll2:${id}`, source: SOURCE, title: name,
    summary: `${done ? 'Launched' : 'Planned'} ${net.slice(0, 16).replace('T', ' ')} UTC from ${[pad, site].filter(Boolean).join(', ') || 'an unnamed pad'}${status ? ` (status: ${status})` : ''}${missionType ? `. Mission type: ${missionType}${orbit ? `, orbit ${orbit}` : ''}` : ''}${provider ? `. Provider: ${provider}` : ''}. "Net" is the no-earlier-than time and can move.`,
    url: PAGE, observedAt: updated, publishedAt: updated, startsAt: net, severity,
    lat, lon, locationMethod: 'provider', locationPrecision: 'exact', ...(text(raw.pad?.country?.alpha_3_code, 3) ? { country: text(raw.pad.country.alpha_3_code, 3) } : {}),
    rocket, ...(missionType ? { missionType } : {}), ...(orbit ? { orbit } : {}), ...(provider ? { provider } : {}), ...(pad ? { pad } : {}), ...(status ? { launchStatus: status } : {}) };
}

export function parseLaunches(upcoming, previous, now = Date.now()) {
  const lists = [upcoming, previous];
  if (lists.some(list => !list || typeof list !== 'object' || !Array.isArray(list.results) || list.results.length > 200)) return unavailableResult(SOURCE, 'Launch Library returned an unexpected response', EXTRAS, now);
  const seen = new Set();
  const rows = [...upcoming.results, ...previous.results].map(raw => launchRow(raw, now)).filter(row => row && !seen.has(row.providerId) && seen.add(row.providerId))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(0, MAX_ROWS);
  const newest = [...upcoming.results, ...previous.results].reduce((latest, raw) => Math.max(latest, Date.parse(providerTime(raw?.last_updated) || '') || 0), 0);
  return freshResult(SOURCE, newest ? new Date(newest).toISOString() : null, rows, { ...EXTRAS, examinedRecords: upcoming.results.length + previous.results.length }, now);
}

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  if (useCache && state.result && now >= state.at && now - state.at < CACHE_MS) return state.result;
  const request = { ...REQUEST, timeout: Math.max(1, Math.min(REQUEST.timeout, Number(options.timeout) || REQUEST.timeout)) };
  const ask = async path => { const reply = await fetcher(`${BASE}/${path}/?${new URLSearchParams({ mode: 'normal', limit: path === 'upcoming' ? '25' : '12', ordering: path === 'upcoming' ? 'net' : '-net' })}`, request); if (reply?.error) throw new Error(String(reply.error)); return reply; };
  let upcoming, previous;
  try { [upcoming, previous] = await Promise.all([ask('upcoming'), ask('previous')]); } catch (error) {
    const reason = (error instanceof Error ? error.message : '').replace(/https?:\/\/\S*/gi, '').trim().slice(0, 120);
    // Anonymous use is rate limited (15 an hour): serve the last good answer for up to an hour, marked by its own old timestamps.
    if (state.result && now >= state.at && now - state.at < 3600000) return state.result;
    return unavailableResult(SOURCE, `Launch Library request failed${reason ? `: ${reason}` : ''}`, EXTRAS, now);
  }
  const result = parseLaunches(upcoming, previous, now);
  if (useCache && result.status !== 'error') { state.at = now; state.result = result; }
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('launches.mjs')) {
  const result = await briefing();
  console.log(JSON.stringify({ ...result, observations: result.observations?.map(row => `${row.severity} ${row.startsAt} ${row.title} | ${row.pad} | ${row.missionType || ''}`) }, null, 2));
}
