// Financial regulators: the newest press releases and notices of the U.S. Federal Reserve (all press releases, which carry the FOMC statements and minutes), the SEC
// and FINRA (notices). Public RSS feeds, no key; checked live on 2026-10-08 from Hungary: HTTP 200, 0.3 s each. Not used, though World Monitor lists them: the FDIC feed
// (890 KB per request) and the CFTC feeds (behind a Cloudflare check that answered Node requests with 403, even though curl got 200). The idea (a regulatory-actions feed) comes from World Monitor (koala73/worldmonitor, seed-regulatory-actions.mjs); the
// adapter is Crucix's own. Rows carry the headline and a link only (no body text), no coordinates; links must stay on the agency's own domain.
// A Federal Reserve headline about the FOMC or monetary policy is rated moderate; everything else is info: the list is a feed, not a judgement of importance.
import { safeFetch } from '../utils/fetch.mjs';
import { providerTime, freshness, freshResult, unavailableResult, POLICIES } from '../utils/freshness.mjs';
import { parseXml } from '../utils/xml.mjs';

const SOURCE = 'Regulators';
const FEEDS = Object.freeze([
  { agency: 'Fed', url: 'https://www.federalreserve.gov/feeds/press_all.xml', host: 'www.federalreserve.gov' },
  { agency: 'SEC', url: 'https://www.sec.gov/news/pressreleases.rss', host: 'www.sec.gov' },
  { agency: 'FINRA', url: 'http://feeds.finra.org/FINRANotices', host: 'www.finra.org' },
]);
const PER_FEED = 8;
const MAX_ROWS = 20;
const CACHE_MS = 30 * 60000;
const REQUEST = Object.freeze({ timeout: 15000, retries: 0, maxBytes: 2 * 1024 * 1024, format: 'text', headers: Object.freeze({ 'User-Agent': 'Crucix/2.x' }) });
const POLICY_WORDS = /FOMC|Federal Open Market Committee|monetary policy/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const EXTRAS = {
  attribution: 'Sources: Board of Governors of the Federal Reserve System, U.S. Securities and Exchange Commission, FINRA',
  rights: 'Headlines and links of public agency news feeds (U.S. government works; FINRA public notices); no body text is copied; no endorsement implied.',
  license: 'U.S. government public information; FINRA public notices (headline and link only)',
  licenseUrl: 'https://www.federalreserve.gov/appsxpr/forms/Terms.html',
  summary: 'The newest press releases and notices of the Federal Reserve, the SEC and FINRA, newest first: headline and link only. A Federal Reserve headline about the FOMC or monetary policy is rated moderate; the rest is info. The list is a feed, not a judgement of importance.'
};

const clean = (value, cap) => typeof value === 'string' ? value.slice(0, 600).replace(/<[^<>]*>/g, ' ').replace(/\p{Cf}/gu, '').replace(/[\p{Cc}\s]+/gu, ' ').replace(/[<>]/g, '').trim().slice(0, cap).trim() : '';
const tagText = value => typeof value === 'string' ? value : value && typeof value === 'object' && typeof value['#text'] === 'string' ? value['#text'] : '';

/** RFC 2822 dates as the providerTime accepts them, plus FINRA's "Oct 05, 2026" (a plain day, read as UTC midnight). */
export function dateOf(raw) {
  const value = typeof raw === 'string' ? raw.trim().slice(0, 64) : '';
  const day = /^([A-Za-z]{3}) (\d{1,2}), (\d{4})$/.exec(value);
  if (day) { const month = MONTHS.indexOf(day[1].toLowerCase()) + 1; return month ? providerTime(`${day[3]}-${String(month).padStart(2, '0')}-${day[2].padStart(2, '0')}`) : null; }
  return providerTime(value);
}

/** Items of one feed: [{ title, link, observedAt }]; null when the document is not an RSS feed. Links outside the agency's host are dropped. */
export function parseRegulatorFeed(xml, feed, now = Date.now()) {
  let doc;
  try { doc = parseXml(xml); } catch { return null; }
  const channel = doc?.rss?.channel;
  if (!channel || typeof channel !== 'object') return null;
  const entries = Array.isArray(channel.item) ? channel.item : channel.item === undefined ? [] : [channel.item];
  const items = [];
  for (const entry of entries.slice(0, 25)) {
    const title = clean(tagText(entry?.title), 220), link = tagText(entry?.link).trim();
    let url;
    try { url = new URL(link); } catch { continue; }
    const observedAt = dateOf(tagText(entry?.pubDate));
    if (!title || !['http:', 'https:'].includes(url.protocol) || url.hostname !== feed.host || link.length > 300 || !observedAt || Date.parse(observedAt) - now > 300000) continue;
    items.push({ title, link: `https://${url.hostname}${url.pathname}${url.search}`, observedAt });
    if (items.length >= PER_FEED) break;
  }
  return items;
}

/** `docs` is { [agency]: xml string | null }. A feed that failed is named in the summary; all failed is an error. */
export function parseRegulators(docs, now = Date.now()) {
  const all = [], failed = [];
  for (const feed of FEEDS) {
    const items = typeof docs?.[feed.agency] === 'string' ? parseRegulatorFeed(docs[feed.agency], feed, now) : null;
    if (!items) { failed.push(feed.agency); continue; }
    for (const item of items) all.push({ ...item, agency: feed.agency });
  }
  if (failed.length === FEEDS.length) return unavailableResult(SOURCE, 'The regulator feeds returned no readable answer', EXTRAS, now);
  all.sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0));
  const fresh = all.filter(item => freshness(item.observedAt, POLICIES[SOURCE].observationMaxAgeMs, now).fresh);
  const rows = fresh.slice(0, MAX_ROWS).map(item => ({ kind: 'economic', providerId: `${item.agency}:${item.link.slice(-80)}`, source: SOURCE, title: `${item.agency}: ${item.title}`,
    summary: `${item.agency} press release or notice: ${item.title}. Headline and link only; open the link for the text.`,
    url: item.link, observedAt: item.observedAt, publishedAt: item.observedAt, severity: item.agency === 'Fed' && POLICY_WORDS.test(item.title) ? 'moderate' : 'info', agency: item.agency }));
  const note = failed.length ? ` Warning: the ${failed.join(', ')} feed${failed.length > 1 ? 's' : ''} failed, so those agencies are missing.` : '';
  return freshResult(SOURCE, all[0]?.observedAt ?? null, rows, { ...EXTRAS, summary: EXTRAS.summary + note, examinedRecords: all.length, truncatedRecords: Math.max(0, fresh.length - MAX_ROWS) }, now);
}

const cache = { at: 0, result: null };

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  if (useCache && cache.result && now >= cache.at && now - cache.at < CACHE_MS) return cache.result;
  const request = { ...REQUEST, timeout: Math.max(1, Math.min(REQUEST.timeout, Number(options.timeout) || REQUEST.timeout)) };
  const docs = {};
  await Promise.all(FEEDS.map(async feed => {
    try { const reply = await fetcher(feed.url, request); docs[feed.agency] = typeof reply?.rawText === 'string' ? reply.rawText : null; } catch { docs[feed.agency] = null; }
  }));
  const result = parseRegulators(docs, now);
  if (useCache && result.status !== 'error') { cache.at = now; cache.result = result; }
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('regulators.mjs')) console.log(JSON.stringify(await briefing(), null, 2));
