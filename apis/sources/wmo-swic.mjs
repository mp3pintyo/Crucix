// WMO Severe Weather Information Centre (SWIC): the official weather warnings that national meteorological services publish as CAP messages,
// collected by the World Meteorological Organization. https://severeweather.wmo.int/json/wmo_all.json ({ itemCount, lastUpdated "YYYY-MM-DD HH:MM:SS" UTC,
// items[] }, 1,403 items and 720 KB on 2026-10-08) and https://severeweather.wmo.int/json/wmo_member.json (the 198 members with a name, a
// point and an alpha-3 code). No key. Each item has event, headline, sent, expires, areaDesc, mid (the member), s (severity 0 unknown, 1 minor,
// 2 moderate, 3 severe, 4 extreme: measured from the events behind each code: 4 = hurricane-force wind warning, 3 = storm/flood warning), u, c.
// The point of this source is coverage the other adapters lack: Meteoalarm covers Europe and NOAA the United States, so WMO members of
// region VI (Europe) and the United States (member 093) are left out. What remains is mostly Argentina, Kazakhstan, Algeria, China, Saudi Arabia
// and Colombia. An item has no coordinates, only its member: a row is placed at the member's point and says so (locationMethod `member-point`).
// Only severe and extreme warnings are kept, grouped by member and event so that 150 identical area warnings become one row (top 25).
import { safeFetch } from '../utils/fetch.mjs';
import { providerTime, freshResult, unavailableResult } from '../utils/freshness.mjs';

const SOURCE = 'WMO-SWIC';
const ALERTS = 'https://severeweather.wmo.int/json/wmo_all.json';
const MEMBERS = 'https://severeweather.wmo.int/json/wmo_member.json';
const HOME = 'https://severeweather.wmo.int/';
const REQUEST = Object.freeze({ timeout: 20000, retries: 0, maxBytes: 4 * 1024 * 1024 });
const MAX_ITEMS = 6000;
const MAX_ROWS = 25;
const FUTURE_SKEW_MS = 300000;
const MEMBERS_TTL = 7 * 24 * 3600000;
const US_MEMBER = '093';
const EUROPE = 6;
// WMO's own severity code is not uniform across national services (one marks a fog warning extreme), so even code 4 is rated high here, never critical.
const SEVERITY = Object.freeze({ 3: 'severe', 4: 'extreme' });
const NAME = /^[\p{L}\p{N} ,.'()/-]{1,60}$/u;
const EVENT = /^[\p{L}\p{N} ,.'()/-]{1,60}$/u;
const MID = /^\d{3}$/;
const cache = { members: null, at: 0 };
const EXTRAS = {
  attribution: 'World Meteorological Organization, Severe Weather Information Centre (https://severeweather.wmo.int), with the warnings of the member meteorological services',
  rights: 'The WMO Severe Weather Information Centre publishes the official CAP warnings of its members openly; the warnings remain the property of the issuing national services. Crucix reads the public JSON, shows a summary per member and event, and links to the Centre. No licence text is published, so the source is cited.',
  license: 'Provider terms; official warnings of the WMO member services (cite WMO SWIC and the issuing service)',
  licenseUrl: null,
  summary: 'Severe and extreme official weather warnings of WMO members outside Europe (covered by Meteoalarm) and the United States (covered by NOAA), grouped by member and event and placed at the member\'s point, not at the affected area. Rows end when the warning expires.',
};

function failure(error) {
  const reason = typeof error === 'string' ? error.slice(0, 300).replace(/https?:\/\/\S*/gi, '').trim().slice(0, 120) : '';
  return `WMO SWIC request failed${reason ? `: ${reason}` : ''}`;
}
const validPoint = (lat, lon) => typeof lat === 'number' && typeof lon === 'number' && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const round2 = value => Math.round(value * 100) / 100;

/** { mid -> { name, code, lat, lon, region } } from wmo_member.json (a list of regions with their members). */
export function parseMembers(payload) {
  if (!Array.isArray(payload) || payload.length > 20) return null;
  const members = new Map();
  for (const region of payload) {
    if (!region || !Array.isArray(region.members)) continue;
    for (const member of region.members.slice(0, 400)) {
      if (!member || !MID.test(member.mid ?? '') || typeof member.name !== 'string' || !NAME.test(member.name) || !validPoint(member.lat, member.lng)) continue;
      members.set(member.mid, { name: member.name, code: typeof member.code === 'string' && /^[A-Z]{3}$/.test(member.code) ? member.code : null, lat: round2(member.lat), lon: round2(member.lng), region: Number(region.ra) });
    }
  }
  return members.size ? members : null;
}

/** Time of a WMO "YYYY-MM-DD HH:MM:SS" stamp (UTC). */
const wmoTime = raw => (typeof raw === 'string' && raw.length === 19 ? providerTime(raw.replace(' ', 'T'), { assumeUTC: true }) : null);

export function parseWmo(payload, members, { now = Date.now() } = {}) {
  if (payload?.error) return unavailableResult(SOURCE, failure(payload.error), EXTRAS, now);
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items) || !(members instanceof Map)) return unavailableResult(SOURCE, 'WMO SWIC returned an unexpected response', EXTRAS, now);
  const observedAt = wmoTime(payload.lastUpdated);
  const groups = new Map();
  let examined = 0, bad = 0;
  for (const item of payload.items.slice(0, MAX_ITEMS)) {
    examined++;
    const sent = wmoTime(item?.sent), expires = wmoTime(item?.expires);
    const severe = Number.isInteger(item?.s) ? SEVERITY[item.s] : undefined;
    const member = MID.test(item?.mid ?? '') ? members.get(item.mid) : undefined;
    const event = typeof item?.event === 'string' ? item.event.trim() : '';
    if (!sent || !expires || !member || !EVENT.test(event)) { bad++; continue; }
    if (!severe || item.mid === US_MEMBER || member.region === EUROPE) continue;
    if (Date.parse(sent) - now > FUTURE_SKEW_MS || Date.parse(expires) <= now) continue;
    const key = `${item.mid}:${event.toLowerCase()}`;
    const group = groups.get(key) ?? { mid: item.mid, member, event, count: 0, sent: 0, expires: 0, level: 'severe' };
    group.count++;
    group.sent = Math.max(group.sent, Date.parse(sent));
    group.expires = Math.max(group.expires, Date.parse(expires));
    if (severe === 'extreme') group.level = 'extreme';
    groups.set(key, group);
  }
  if (!examined || bad * 2 > examined) return unavailableResult(SOURCE, 'WMO SWIC returned warnings in an unexpected shape', EXTRAS, now);
  const rows = [...groups.values()].sort((a, b) => (b.level === 'extreme') - (a.level === 'extreme') || b.count - a.count || (a.mid + a.event < b.mid + b.event ? -1 : 1)).slice(0, MAX_ROWS).map(group => {
    const at = new Date(group.sent).toISOString();
    return { kind: 'weather', providerId: `${group.mid}:${group.event.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event'}`, source: SOURCE,
      title: `${group.event}: ${group.member.name}${group.count > 1 ? ` (${group.count} areas)` : ''}`,
      summary: `The meteorological service of ${group.member.name} has ${group.count} active ${group.level} ${group.count > 1 ? 'warnings' : 'warning'} for ${group.event.toLowerCase()}, the newest sent ${at}. Shown at the member's point, not at the affected area.`,
      url: HOME, observedAt: at, publishedAt: at, validUntil: new Date(group.expires).toISOString(), lat: group.member.lat, lon: group.member.lon, locationMethod: 'member-point', locationPrecision: 'approximate',
      region: group.member.name, ...(group.member.code ? { country: group.member.name } : {}), severity: 'high' };
  });
  return freshResult(SOURCE, observedAt, rows, { ...EXTRAS, examinedRecords: examined, groupedWarnings: groups.size }, now);
}

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  const request = { ...REQUEST, timeout: Math.max(1, Math.min(REQUEST.timeout, Number(options.timeout) || REQUEST.timeout)) };
  let members = useCache && cache.members && now >= cache.at && now - cache.at < MEMBERS_TTL ? cache.members : null;
  if (!members) {
    let reply;
    try { reply = await fetcher(MEMBERS, request); } catch { reply = { error: 'network error' }; }
    members = reply?.error ? null : parseMembers(reply);
    if (!members) return unavailableResult(SOURCE, reply?.error ? failure(reply.error) : 'WMO SWIC members list was unreadable', EXTRAS, now);
    if (useCache) { cache.members = members; cache.at = now; }
  }
  let payload;
  try { payload = await fetcher(ALERTS, request); } catch { payload = { error: 'network error' }; }
  return parseWmo(payload, members, { now });
}

// Run standalone
if (process.argv[1]?.endsWith('wmo-swic.mjs')) {
  const result = await briefing();
  console.log(JSON.stringify({ ...result, observations: result.observations?.map(row => `${row.severity} ${row.title} ${row.validUntil}`) }, null, 2));
}
