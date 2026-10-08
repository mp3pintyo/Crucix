// U.S. Department of State Travel Advisories: one four-level advisory per country (1 Exercise Normal Precautions, 2 Exercise Increased
// Caution, 3 Reconsider Travel, 4 Do Not Travel), the expert risk reading of a national government. https://travel.state.gov/_res/rss/TAsTWs.xml
// (no key; checked live on 2026-10-08: HTTP 200, 614 KB, 223 items, 217 of them resolve to a gazetteer country; the channel's dc:date was the
// day before). It is a standing assessment, not an event feed: a plain source with no POLICIES entry and no live row (like INFORM-Risk); the
// country-risk step reads it as the `advisory` component and the country sheet shows it with its link.
//   - An item is "<Country> - Level <1-4>: <label>", its pubDate the date the advisory last changed (a date, no time). The channel date is the
//     time the feed was built and stands in for the observation time; a feed older than 14 days is stale and not used.
//   - Names are resolved with the gazetteer (countryByName); a handful of State Department spellings get an alias; the rest is counted as unmatched.
//   - Provider text is never shown as written: the label comes from a fixed table of the four levels, the link must be an https travel.state.gov URL.
import { safeFetch } from '../utils/fetch.mjs';
import { parseXml } from '../utils/xml.mjs';
import { providerTime } from '../utils/freshness.mjs';
import { countryByName } from '../../lib/intelligence/countries.mjs';

const SOURCE = 'Travel-Advisories';
const ENDPOINT = 'https://travel.state.gov/_res/rss/TAsTWs.xml';
const REQUEST = Object.freeze({ timeout: 15000, retries: 0, format: 'text', maxBytes: 2 * 1024 * 1024, headers: Object.freeze({ 'User-Agent': 'Mozilla/5.0 (compatible; Crucix/2.x)' }) });
const MAX_ITEMS = 400;
const DAY = 24 * 3600000;
const MAX_AGE = 14 * DAY;
const CACHE_MS = 6 * 3600000;
const STALE_MS = 14 * DAY;
export const LEVEL_LABELS = Object.freeze({ 1: 'Exercise Normal Precautions', 2: 'Exercise Increased Caution', 3: 'Reconsider Travel', 4: 'Do Not Travel' });
// State Department spellings the gazetteer does not know, by the name as written (after the title cut).
const ALIASES = Object.freeze({ 'The Kyrgyz Republic': 'KGZ', 'Kingdom of Denmark': 'DNK' });
const TITLE = /^(.{1,80}?) - Level ([1-4])(?::.{0,80})?$/;
const LINK = /^https:\/\/travel\.state\.gov\/[A-Za-z0-9/._-]{1,300}$/;
const ATTRIBUTION = 'U.S. Department of State, Bureau of Consular Affairs, Travel Advisories (travel.state.gov).';
const RIGHTS = 'Travel Advisories are works of the U.S. government and are in the public domain (17 U.S.C. 105); the source is cited as a courtesy. An advisory is a risk reading for U.S. travellers, written by one government; it is not a finding about the country and it is not Hungarian or European guidance.';
const LICENSE = 'Public domain (U.S. government work)';
const state = { payload: null, collectedAt: 0, good: null };

const iso = ms => new Date(ms).toISOString();
const unavailable = (message, now) => ({ source: SOURCE, status: 'error', timestamp: iso(now), error: String(message).slice(0, 300) });
// "Tue, 15 Sep 2026" (a date without a time) -> "2026-09-15", or null when it is not a real calendar date.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function dayOf(raw) {
  const match = /^(?:[A-Za-z]{3},\s+)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(typeof raw === 'string' ? raw.trim().slice(0, 40) : '');
  const month = match ? MONTHS.indexOf(match[2].toLowerCase()) + 1 : 0;
  if (!month) return null;
  const day = `${match[3]}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null;
}
const text = value => (typeof value === 'string' ? value : value && typeof value === 'object' && typeof value['#text'] === 'string' ? value['#text'] : '');

/** The advisories of the feed text: { countries: { ISO3: { level, label, updated, url } }, counts, unmatched, observedAt }, or an error result. */
export function parseAdvisories(xml, now = Date.now()) {
  let doc;
  try { doc = parseXml(xml); } catch { return unavailable('Travel advisories returned an unreadable document', now); }
  const channel = doc?.rss?.channel;
  const raw = channel?.item;
  const items = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  if (!channel || !items.length || items.length > MAX_ITEMS) return unavailable('Travel advisories returned an unexpected shape', now);
  const built = providerTime(text(channel.date)) || providerTime(text(channel.pubDate));
  // No provider date is an error (collection time never stands in for it); an old or future-dated feed is stale.
  if (!built) return unavailable('Travel advisories carry no feed date', now);
  if (now - Date.parse(built) > MAX_AGE || Date.parse(built) - now > 300000) return { source: SOURCE, status: 'stale', timestamp: iso(now), observedAt: built, stale: true };
  const countries = {};
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let unmatched = 0;
  for (const item of items) {
    const title = text(item?.title).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
    const match = TITLE.exec(title);
    if (!match) { unmatched += 1; continue; }
    const name = match[1].replace(/\s+Travel Advisory$/i, '').trim();
    const iso3 = ALIASES[name] ?? countryByName(name)?.iso3;
    if (!iso3 || Object.hasOwn(countries, iso3)) { unmatched += 1; continue; }
    const level = Number(match[2]);
    const updated = dayOf(text(item?.pubDate));
    const link = text(item?.link).trim();
    countries[iso3] = { level, label: LEVEL_LABELS[level], updated, url: LINK.test(link) ? link : null };
    counts[level] += 1;
  }
  if (Object.keys(countries).length < 100 || unmatched * 4 > items.length) return unavailable('Travel advisories returned an unexpected shape', now);
  return { source: SOURCE, status: 'ok', timestamp: iso(now), observedAt: built, countries, counts, unmatched, attribution: ATTRIBUTION, rights: RIGHTS, license: LICENSE };
}

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  if (useCache && state.payload && now >= state.collectedAt && now - state.collectedAt < CACHE_MS) return parseAdvisories(state.payload, now);
  let reply;
  try { reply = await fetcher(ENDPOINT, REQUEST); } catch { reply = { error: 'network error' }; }
  const failed = !reply || typeof reply.rawText !== 'string' ? 'Travel advisories request failed' : null;
  const result = failed ? unavailable(failed, now) : parseAdvisories(reply.rawText, now);
  if (result.status === 'ok') {
    if (useCache) { state.payload = reply.rawText; state.collectedAt = now; state.good = { payload: result, at: now }; }
    return result;
  }
  // A failing or stale feed returns the last good result for 14 days, marked stale, so one outage does not drop the component from every score.
  const good = useCache ? state.good : null;
  if (good && now >= good.at && now - good.at < STALE_MS) return { ...good.payload, timestamp: iso(now), stale: true, staleSince: iso(good.at), staleReason: result.error || 'feed older than 14 days' };
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('travel-advisories.mjs')) {
  const result = await briefing();
  console.log(JSON.stringify({ ...result, countries: result.countries ? `${Object.keys(result.countries).length} countries` : undefined }, null, 2));
}
