// MISP Galaxy "threat-actor": the community catalogue of known adversary groups (APT28, Turla, Lazarus ...), with their aliases and, for about
// 45% of them, the country they are attributed to. https://github.com/MISP/misp-galaxy/blob/main/clusters/threat-actor.json (raw.githubusercontent.com,
// no key; checked live on 2026-10-08: HTTP 200, 1.4 MB, version 352, 1,060 actors, 482 with a `meta.country`: CN 218, RU 80, IR 60, KP 26, then
// PS 9, TR 7, UA 7, VN 6). A reference list, not a live feed: a plain source with no POLICIES entry and no live row (like INFORM-Risk); the
// country sheet shows it as context. The galaxy is dual-licensed CC0 1.0 and BSD; the data is community-curated, so an attribution is a
// suspicion, never a finding: the sheet says so.
//   - `meta.country` is an ISO 3166-1 alpha-2 code; the adapter keeps it as written and the risk step maps it to the alpha-3 code of the gazetteer.
//   - Per country the 12 groups with the most aliases are kept (a widely tracked group has many names: APT28 has 30), the rest are only counted.
//   - Names and aliases pass a strict pattern after a length cut; provider text is never shown as written.
// The list changes a few times a month: the answer is cached for 7 days, and a later failure returns the last good result for 45 days, marked stale.
import { safeFetch } from '../utils/fetch.mjs';

const SOURCE = 'MISP-Galaxy';
const ENDPOINT = 'https://raw.githubusercontent.com/MISP/misp-galaxy/main/clusters/threat-actor.json';
const REQUEST = Object.freeze({ timeout: 20000, retries: 0, maxBytes: 6 * 1024 * 1024 });
const MAX_ACTORS = 5000;
const MAX_ALIASES_READ = 80;
const KEEP_PER_COUNTRY = 12;
const KEEP_ALIASES = 4;
const TTL = 7 * 24 * 3600000;
const STALE_MS = 45 * 24 * 3600000;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._+/()[\]-]{0,59}$/u;
const state = { good: null };
const ATTRIBUTION = 'MISP Project threat-actor galaxy (CIRCL and the MISP community), https://www.misp-galaxy.org/threat-actor/';
const RIGHTS = 'The MISP galaxy JSON files are dual-licensed under CC0 1.0 Universal and the BSD 2-clause licence. The catalogue is community-curated: the country of a group is a suspected attribution, not proven, and many groups have none.';

const iso = ms => new Date(ms).toISOString();
const unavailable = (message, now) => ({ source: SOURCE, status: 'error', timestamp: iso(now), error: String(message).slice(0, 300) });
// Provider text becomes inert plain text; the input is cut first so no regex ever runs on unbounded text.
const clean = (value, cap) => typeof value === 'string'
  ? value.slice(0, 200).replace(/\p{Cf}/gu, '').replace(/[\p{Cc}\s]+/gu, ' ').replace(/[<>]/g, '').trim().slice(0, cap).trim() : '';
const name = (value, cap) => { const text = clean(value, cap); return NAME.test(text) ? text : ''; };

export function parseMispGalaxy(payload, now = Date.now()) {
  if (payload?.error) return unavailable(`MISP Galaxy request failed${Number.isInteger(payload.status) && payload.status >= 400 ? ` (HTTP ${payload.status})` : ''}`, now);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.values)) return unavailable('MISP Galaxy returned an unexpected payload shape', now);
  const list = payload.values.slice(0, MAX_ACTORS);
  const byCountry = new Map();
  let bad = 0, withCountry = 0;
  for (const raw of list) {
    const actor = name(raw?.value, 60);
    if (!actor) { bad++; continue; }
    const meta = raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? raw.meta : {};
    const code = typeof meta.country === 'string' && /^[A-Za-z]{2}$/.test(meta.country) ? meta.country.toUpperCase() : null;
    if (!code) continue;
    withCountry++;
    const synonyms = Array.isArray(meta.synonyms) ? meta.synonyms.slice(0, MAX_ALIASES_READ) : [];
    const aliases = [...new Set(synonyms.map(item => name(item, 40)).filter(item => item && item !== actor))];
    const entry = byCountry.get(code) || { count: 0, groups: [] };
    entry.count++;
    entry.groups.push({ name: actor, aliasCount: aliases.length, aliases: aliases.slice(0, KEEP_ALIASES) });
    byCountry.set(code, entry);
  }
  // A catalogue in which most actors are unreadable means the format changed: never a quiet source.
  if (!list.length || bad * 2 > list.length || !withCountry) return unavailable('MISP Galaxy returned an unexpected payload shape', now);
  const countries = Object.fromEntries([...byCountry].sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, entry]) => [code, {
    count: entry.count,
    groups: entry.groups.sort((a, b) => b.aliasCount - a.aliasCount || (a.name < b.name ? -1 : 1)).slice(0, KEEP_PER_COUNTRY).map(({ name: actor, aliases }) => ({ name: actor, aliases })),
  }]));
  return { source: SOURCE, status: 'ok', timestamp: iso(now), release: clean(String(payload.version ?? ''), 20), total: list.length, attributed: withCountry,
    countries, attribution: ATTRIBUTION, rights: RIGHTS, license: 'CC0 1.0 / BSD', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' };
}

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  const good = useCache ? state.good : null;
  if (good && now >= good.at && now - good.at < TTL) return { ...good.payload, timestamp: iso(now) };
  let payload;
  try { payload = await fetcher(ENDPOINT, REQUEST); } catch { payload = { error: 'network error' }; }
  const result = parseMispGalaxy(payload, now);
  if (result.status === 'ok') { if (useCache) state.good = { payload: result, at: now }; return result; }
  if (good && now >= good.at && now - good.at < STALE_MS) return { ...good.payload, timestamp: iso(now), stale: true, staleSince: iso(good.at), staleReason: result.error };
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('misp-galaxy.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify({ ...data, countries: Object.fromEntries(Object.entries(data.countries || {}).slice(0, 3)) }, null, 2));
}
