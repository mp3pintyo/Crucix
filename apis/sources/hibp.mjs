// Have I Been Pwned: the data breaches added to the public breach list in the last 30 days. https://haveibeenpwned.com/api/v3/breaches is the
// full catalogue of breached sites and needs no key (checked live on 2026-10-08: HTTP 200, 1.1 MB, 1.5 s, 1,041 breaches; the list is not
// ordered by date, so the rows are sorted here). HIBP asks for a User-Agent, which safeFetch sends.
// A breach has Name, Title, Domain, BreachDate (a day), AddedDate (an ISO time: when HIBP loaded it), PwnCount, DataClasses and flags. Rows:
//   - AddedDate is the observation time: the breach became public knowledge then, which can be long after BreachDate (AngelOne: breached 2023,
//     added 2026-10-07), so both days are said in the text.
//   - Fabricated, spam-list and retired breaches are left out (not a leak of real accounts), and so are sensitive ones (adult and similar sites):
//     HIBP itself does not make them publicly searchable, and a dashboard has no reason to list them.
//   - The row text is written here from the structured fields; HIBP's HTML description is never shown.
// Measured over the 12 months to 2026-10-08 (118 listed breaches): median 0.79 million accounts, 52 breaches with 1 million or more, 15 with 10
// million or more, largest 1.96 billion. The ratings follow that: moderate from 1 million accounts, high from 10 million (about 13% of the breaches).
// HIBP adds breaches in bursts: in the last 60 additions the longest gap was 8 days, so the feed limit is 14 days; the row window is 30 days.
// Every regex below runs on text that was cut to a fixed length first.
import { safeFetch } from '../utils/fetch.mjs';
import { providerTime, freshness, freshResult, unavailableResult, POLICIES } from '../utils/freshness.mjs';

const SOURCE = 'HIBP';
const ENDPOINT = 'https://haveibeenpwned.com/api/v3/breaches';
const PAGE = 'https://haveibeenpwned.com/PwnedWebsites#';
const MAX_EXAMINED = 3000; // the live catalogue holds about 1,050
const MAX_ROWS = 20;
const MODERATE_FROM = 1_000_000;
const HIGH_FROM = 10_000_000;
const FUTURE_SKEW_MS = 300000;
const CACHE_MS = 3600000;
const REQUEST = Object.freeze({ timeout: 20000, retries: 0, maxBytes: 6 * 1024 * 1024 });
const cache = { payload: null, fetcher: null, collectedAt: 0 };
const NAME = /^[A-Za-z0-9]{1,60}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;
const EXTRAS = {
  attribution: 'Source: Have I Been Pwned (https://haveibeenpwned.com), Troy Hunt',
  rights: 'Have I Been Pwned breach data is licensed CC BY 4.0 with attribution to haveibeenpwned.com. Crucix lists breach names, domains, counts and dates only; fabricated, spam-list, retired and sensitive breaches are left out, and no account data is ever read.',
  license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  summary: 'Data breaches added to Have I Been Pwned in the last 30 days, newest first. The time shown is when HIBP added the breach, which can be long after the breach itself. Rated moderate from 1 million exposed accounts and high from 10 million.',
};

// Provider text becomes inert plain text: markup, control, bidi and zero-width characters go, whitespace collapses.
const clean = (value, cap) => typeof value === 'string'
  ? value.slice(0, 300).replace(/<[^<>]*>/g, '').replace(/\p{Cf}/gu, '').replace(/[\p{Cc}\s]+/gu, ' ').replace(/[<>]/g, '').trim().slice(0, cap).trim() : '';
// Transport errors become a short reason; a URL or an upstream message never reaches the result.
function failure(error) {
  const reason = typeof error === 'string' ? error.slice(0, 300).replace(/https?:\/\/\S*/gi, '').trim().slice(0, 120) : '';
  return `HIBP request failed${reason ? `: ${reason}` : ''}`;
}

function breach(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = typeof raw.Name === 'string' && raw.Name.length <= 60 && NAME.test(raw.Name) ? raw.Name : null;
  const added = typeof raw.AddedDate === 'string' && raw.AddedDate.length <= 40 ? providerTime(raw.AddedDate) : null;
  const title = clean(raw.Title, 120);
  const count = Number.isSafeInteger(raw.PwnCount) && raw.PwnCount >= 0 ? raw.PwnCount : null;
  if (!name || !added || !title || count === null) return null;
  const domain = typeof raw.Domain === 'string' && raw.Domain.length <= 253 && DOMAIN.test(raw.Domain) ? raw.Domain.toLowerCase() : '';
  const day = typeof raw.BreachDate === 'string' && raw.BreachDate.length === 10 && DAY.test(raw.BreachDate) && providerTime(raw.BreachDate) ? raw.BreachDate : '';
  const classes = Array.isArray(raw.DataClasses) ? raw.DataClasses.slice(0, 40).map(item => clean(item, 40)).filter(Boolean).slice(0, 6) : [];
  const excluded = raw.IsFabricated === true || raw.IsSpamList === true || raw.IsRetired === true || raw.IsSensitive === true;
  return { name, added, title, count, domain, day, classes, excluded };
}

export function parseHibp(payload, { now = Date.now() } = {}) {
  if (payload?.error) return unavailableResult(SOURCE, failure(payload.error), EXTRAS, now);
  if (!Array.isArray(payload)) return unavailableResult(SOURCE, 'HIBP returned an unexpected response', EXTRAS, now);
  const list = payload.slice(0, MAX_EXAMINED);
  const breaches = [];
  let bad = 0;
  for (const raw of list) { const item = breach(raw); if (item) breaches.push(item); else bad++; }
  // A catalogue in which nothing is readable means the API changed shape: never a quiet feed.
  if (list.length && !breaches.length) return unavailableResult(SOURCE, 'HIBP returned breaches in an unexpected shape', EXTRAS, now);
  const usable = breaches.filter(item => Date.parse(item.added) - now <= FUTURE_SKEW_MS);
  // The newest addition of the whole catalogue, old or not: an old list is expired rather than undated.
  const newest = usable.map(item => item.added).sort().at(-1) ?? null;
  const ranked = usable.filter(item => !item.excluded && freshness(item.added, POLICIES[SOURCE].observationMaxAgeMs, now).fresh)
    .sort((a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : 0) || (a.name < b.name ? -1 : 1));
  const rows = ranked.slice(0, MAX_ROWS).map(item => {
    const severity = item.count >= HIGH_FROM ? 'high' : item.count >= MODERATE_FROM ? 'moderate' : 'info';
    const accounts = item.count.toLocaleString('en-US');
    return { kind: 'cyber', providerId: item.name, source: SOURCE,
      title: `${item.title}: ${accounts} accounts exposed`,
      summary: `Have I Been Pwned added the ${item.title} breach${item.domain ? ` (${item.domain})` : ''} on ${item.added.slice(0, 10)}; ${accounts} accounts are in it${item.day ? `, breached on ${item.day}` : ''}.${item.classes.length ? ` Data exposed: ${item.classes.join(', ')}.` : ''} The time shown is when HIBP added it, not when the breach happened.`,
      url: `${PAGE}${item.name}`, observedAt: item.added, publishedAt: item.added, severity,
      ...(item.domain ? { domain: item.domain } : {}), pwnCount: item.count, ...(item.day ? { breachDate: item.day } : {}) };
  });
  const note = bad ? ` Warning: ${bad} of the ${list.length} catalogue entries could not be read and were skipped.` : '';
  return freshResult(SOURCE, newest, rows, { ...EXTRAS, summary: EXTRAS.summary + note, examinedRecords: list.length, truncatedRecords: Math.max(0, ranked.length - MAX_ROWS) + Math.max(0, payload.length - list.length) }, now);
}

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  if (useCache && cache.payload && cache.fetcher === fetcher && now >= cache.collectedAt && now - cache.collectedAt < CACHE_MS) return parseHibp(cache.payload, { now });
  const request = { ...REQUEST, timeout: Math.max(1, Math.min(REQUEST.timeout, Number(options.timeout) || REQUEST.timeout)) };
  let payload;
  try { payload = await fetcher(ENDPOINT, request); } catch { payload = { error: 'network error' }; }
  const result = parseHibp(payload, { now });
  if (useCache && result.status !== 'error') { cache.payload = payload; cache.fetcher = fetcher; cache.collectedAt = now; }
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('hibp.mjs')) {
  console.log(JSON.stringify(await briefing(), null, 2));
}
