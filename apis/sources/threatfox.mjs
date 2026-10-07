// abuse.ch ThreatFox: the indicators of compromise (IOCs) reported in the last 24 hours, summed up per malware family. The public export
// https://threatfox.abuse.ch/export/json/recent/ needs no key (checked live on 2026-10-08: HTTP 200, 5.2 MB, 0.5 s; the query API at
// threatfox-api.abuse.ch needs an Auth-Key, the export does not). The answer is an object { "<id>": [ioc] } of about 8,400 indicators, newest id
// first; each indicator carries ioc_value, ioc_type, threat_type, malware (a Malpedia name like win.cobalt_strike), malware_printable and
// first_seen_utc ("YYYY-MM-DD HH:MM:SS", UTC). Measured on 2026-10-08: 765 indicators in the last 24 hours, 182 in the last 6, 293 of the 24 h
// ones botnet command-and-control (botnet_cc); the top family (generic "Unknown Stealer") had 150, the next 59.
// Single indicators are never shown: they are malicious domains, addresses and hashes, thousands a day, and a dashboard is no blocklist. One
// row per family (top 10 of the window) says how much of what is being reported; the family link opens ThreatFox's own browse page.
// The feed has no publication time of its own: the newest first_seen_utc of the answer stands in for it (indicators arrive every few minutes).
// The family rating is moderate from 100 indicators in 24 hours (the measured day had one such family out of 10 listed) and info below.
// Provider text is never shown as written: names pass a strict pattern, the input is walked with fixed caps, and a regex only ever runs on text
// that was cut to a fixed length first.
import { safeFetch } from '../utils/fetch.mjs';
import { providerTime, freshResult, unavailableResult } from '../utils/freshness.mjs';

const SOURCE = 'ThreatFox';
const ENDPOINT = 'https://threatfox.abuse.ch/export/json/recent/';
const BROWSE = 'https://threatfox.abuse.ch/browse/malware/';
const WINDOW_MS = 24 * 3600000;
const FUTURE_SKEW_MS = 300000;
const MAX_ENTRIES = 30000; // answer keys examined (the live answer has about 8,400)
const MAX_PER_ENTRY = 10;
const MAX_ROWS = 10;
const MODERATE_FROM = 100;
const CACHE_MS = 10 * 60000;
const REQUEST = Object.freeze({ timeout: 20000, retries: 0, maxBytes: 12 * 1024 * 1024 });
const cache = { payload: null, fetcher: null, collectedAt: 0 };
const TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const KEY = /^[a-z0-9][a-z0-9_.-]{0,79}$/; // Malpedia-style name: win.cobalt_strike
const NAME = /^[\p{L}\p{N} ._+/()-]{1,60}$/u;
const KNOWN_THREAT = new Set(['botnet_cc', 'payload_delivery', 'payload', 'cc_skimming']);
const EXTRAS = {
  attribution: 'Source: abuse.ch ThreatFox (https://threatfox.abuse.ch)',
  rights: 'abuse.ch data is released under CC0 1.0 (public domain dedication); attribution to abuse.ch is given as a courtesy. Crucix reads the public export and shows only per-family counts, never single indicators.',
  license: 'CC0 1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  summary: 'New indicators of compromise reported to abuse.ch ThreatFox in the last 24 hours, counted per malware family (top 10). A count is how much was reported, not how many victims there are; "Unknown" families are reports without a family name. A family is rated moderate from 100 indicators in 24 hours.',
};

// Transport errors become a short reason; a URL or an upstream message never reaches the result.
function failure(error) {
  const reason = typeof error === 'string' ? error.slice(0, 300).replace(/https?:\/\/\S*/gi, '').trim().slice(0, 120) : '';
  return `ThreatFox request failed${reason ? `: ${reason}` : ''}`;
}

function indicator(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const seen = typeof raw.first_seen_utc === 'string' && raw.first_seen_utc.length === 19 && TIME.test(raw.first_seen_utc)
    ? providerTime(raw.first_seen_utc.replace(' ', 'T'), { assumeUTC: true }) : null;
  const printable = typeof raw.malware_printable === 'string' ? raw.malware_printable.trim().slice(0, 80) : '';
  if (!seen || !NAME.test(printable)) return null;
  const key = typeof raw.malware === 'string' && raw.malware.length <= 80 && KEY.test(raw.malware) ? raw.malware : null;
  const threat = typeof raw.threat_type === 'string' && KNOWN_THREAT.has(raw.threat_type) ? raw.threat_type : 'other';
  return { seen, ms: Date.parse(seen), family: printable, key, c2: threat === 'botnet_cc' };
}

export function parseThreatFox(payload, { now = Date.now() } = {}) {
  if (payload?.error) return unavailableResult(SOURCE, failure(payload.error), EXTRAS, now);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return unavailableResult(SOURCE, 'ThreatFox returned an unexpected response', EXTRAS, now);
  const groups = new Map();
  let examined = 0, bad = 0, newest = 0, inWindow = 0, c2 = 0;
  for (const entry of Object.values(payload).slice(0, MAX_ENTRIES)) {
    if (!Array.isArray(entry)) { examined++; bad++; continue; }
    for (const raw of entry.slice(0, MAX_PER_ENTRY)) {
      examined++;
      const ioc = indicator(raw);
      if (!ioc) { bad++; continue; }
      if (ioc.ms - now > FUTURE_SKEW_MS) continue;
      newest = Math.max(newest, ioc.ms);
      if (now - ioc.ms > WINDOW_MS) continue;
      inWindow++; if (ioc.c2) c2++;
      const group = groups.get(ioc.family) || { family: ioc.family, key: ioc.key, count: 0, c2: 0, latest: 0 };
      group.count++; if (ioc.c2) group.c2++; group.latest = Math.max(group.latest, ioc.ms);
      groups.set(ioc.family, group);
    }
  }
  // Nothing readable at all means the export changed shape: never a quiet feed.
  if (!examined || bad === examined) return unavailableResult(SOURCE, 'ThreatFox returned indicators in an unexpected shape', EXTRAS, now);
  const observedAt = newest ? new Date(newest).toISOString() : null;
  const ranked = [...groups.values()].sort((a, b) => b.count - a.count || b.latest - a.latest || (a.family < b.family ? -1 : 1)).slice(0, MAX_ROWS);
  const rows = ranked.map(group => {
    const at = new Date(group.latest).toISOString();
    return { kind: 'cyber', providerId: `family:${group.key || group.family}`, source: SOURCE,
      title: `${group.family}: ${group.count} new ${group.count === 1 ? 'indicator' : 'indicators'} in 24 h`,
      summary: `abuse.ch ThreatFox received ${group.count} ${group.count === 1 ? 'indicator' : 'indicators'} of compromise for ${group.family} in the last 24 hours, ${group.c2} of them botnet command-and-control. This counts reports, not victims.${group.count >= MODERATE_FROM ? ` Rated moderate from ${MODERATE_FROM} indicators in 24 hours.` : ''}`,
      url: group.key ? `${BROWSE}${group.key}/` : 'https://threatfox.abuse.ch/browse/',
      observedAt: at, publishedAt: at, severity: group.count >= MODERATE_FROM ? 'moderate' : 'info',
      family: group.family, iocCount: group.count, c2Count: group.c2 };
  });
  const note = ` In the window: ${inWindow} indicators (${c2} botnet command-and-control) from ${groups.size} families.`;
  return freshResult(SOURCE, observedAt, rows, { ...EXTRAS, summary: EXTRAS.summary + note, examinedRecords: examined, truncatedRecords: Math.max(0, groups.size - MAX_ROWS) }, now);
}

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  if (useCache && cache.payload && cache.fetcher === fetcher && now >= cache.collectedAt && now - cache.collectedAt < CACHE_MS) return parseThreatFox(cache.payload, { now });
  const request = { ...REQUEST, timeout: Math.max(1, Math.min(REQUEST.timeout, Number(options.timeout) || REQUEST.timeout)) };
  let payload;
  try { payload = await fetcher(ENDPOINT, request); } catch { payload = { error: 'network error' }; }
  const result = parseThreatFox(payload, { now });
  // Only a readable answer is kept: a failed or reshaped one is asked again at the next sweep.
  if (useCache && result.status !== 'error') { cache.payload = payload; cache.fetcher = fetcher; cache.collectedAt = now; }
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('threatfox.mjs')) {
  console.log(JSON.stringify(await briefing(), null, 2));
}
