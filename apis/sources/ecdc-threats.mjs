// ECDC (European Centre for Disease Prevention and Control): the News and Epidemiological update feeds, the agency's own outbreak reports.
// https://www.ecdc.europa.eu/en/taxonomy/term/1307/feed (news) and .../term/1310/feed (epidemiological updates): RSS 2.0, no key; checked live on
// 2026-10-08 from Hungary: HTTP 200, 0.9 s. The CDC newsroom feed (last built 2023) and the CIDRAP feeds (items from 2021-22) World Monitor lists next to
// them were measured the same day and are not used: stale. The idea (tag outbreak news ALERT / WARNING / WATCH from the headline) comes from World
// Monitor (koala73/worldmonitor, scripts/seed-disease-outbreaks.mjs); the adapter is Crucix's own.
// The level is read from the HEADLINE words only: it is a prompt to look, not an ECDC risk assessment. Rows carry no coordinates (the lib side finds the country).
import { safeFetch } from '../utils/fetch.mjs';
import { providerTime, freshness, freshResult, unavailableResult, POLICIES } from '../utils/freshness.mjs';
import { parseXml } from '../utils/xml.mjs';

const SOURCE = 'ECDC-Threats';
const FEEDS = Object.freeze([
  { name: 'News', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/1307/feed' },
  { name: 'Epidemiological update', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/1310/feed' },
]);
const MAX_ROWS = 15;
const MAX_ITEMS = 40;
const CACHE_MS = 3600000;
const REQUEST = Object.freeze({ timeout: 15000, retries: 0, maxBytes: 2 * 1024 * 1024, headers: Object.freeze({ 'User-Agent': 'Crucix/2.x' }) });
const LINK = /^https:\/\/www\.ecdc\.europa\.eu\/[A-Za-z0-9/_.%-]{1,200}$/;
const ALERT = /ebola|marburg|plague|pandemic|public health emergency|pneumonia of unknown|unknown origin|h5n1|outbreak of (?:cholera|polio)/i;
const WARNING = /outbreak|epidemic|cluster|emergence|imported case|local transmission|deaths?\b|fatal/i;
const EXTRAS = {
  attribution: 'Source: European Centre for Disease Prevention and Control (ecdc.europa.eu)',
  rights: 'ECDC web content is reusable with acknowledgement of the source (ECDC copyright notice); headlines and short extracts only, with a link to the original; no endorsement implied.',
  license: 'ECDC copyright notice (reuse with attribution)',
  licenseUrl: 'https://www.ecdc.europa.eu/en/copyright',
  summary: 'The newest ECDC outbreak news and epidemiological updates, newest first. The ALERT / WARNING / WATCH level is read from the headline words only; it is a prompt to look, not an ECDC risk assessment.'
};

// Provider text becomes inert plain text: entities of escaped markup first, then markup, control and zero-width characters; cut BEFORE any regex runs.
const clean = (value, cap) => typeof value === 'string'
  ? value.slice(0, 1200).replace(/&nbsp;/g, ' ').replace(/<[^<>]*>/g, ' ').replace(/\p{Cf}/gu, '').replace(/[\p{Cc}\s]+/gu, ' ').replace(/[<>]/g, '').trim().slice(0, cap).trim() : '';

/** ALERT / WARNING / WATCH from the headline words. */
export function levelOf(title) {
  const t = typeof title === 'string' ? title.slice(0, 400) : '';
  return ALERT.test(t) ? 'ALERT' : WARNING.test(t) ? 'WARNING' : 'WATCH';
}
const SEVERITY = { ALERT: 'high', WARNING: 'moderate', WATCH: 'info' };

/** Items of one feed document: [{ title, link, summary, observedAt }]. Returns null for a document that is not an RSS feed. */
export function parseEcdcFeed(xml, now = Date.now()) {
  let doc;
  try { doc = parseXml(xml); } catch { return null; }
  const raw = doc?.rss?.channel;
  if (!raw || typeof raw !== 'object') return null;
  const entries = Array.isArray(raw.item) ? raw.item : raw.item === undefined ? [] : [raw.item];
  const items = [];
  for (const entry of entries.slice(0, MAX_ITEMS)) {
    const title = clean(entry?.title, 200), link = typeof entry?.link === 'string' ? entry.link.trim() : '';
    const observedAt = providerTime(typeof entry?.pubDate === 'string' ? entry.pubDate.trim() : '');
    if (!title || !LINK.test(link) || !observedAt || Date.parse(observedAt) - now > 300000) continue;
    items.push({ title, link, observedAt, summary: clean(entry?.description, 400) });
  }
  return items;
}

/** `docs` is { [feedName]: xml string }. A feed that fails is named in the summary; all failed is an error. */
export function parseEcdc(docs, now = Date.now()) {
  const byLink = new Map(), failed = [];
  for (const feed of FEEDS) {
    const items = typeof docs?.[feed.name] === 'string' ? parseEcdcFeed(docs[feed.name], now) : null;
    if (!items) { failed.push(feed.name); continue; }
    for (const item of items) if (!byLink.has(item.link) || byLink.get(item.link).observedAt < item.observedAt) byLink.set(item.link, { ...item, feed: feed.name });
  }
  if (failed.length === FEEDS.length) return unavailableResult(SOURCE, 'ECDC returned an unexpected response', EXTRAS, now);
  const all = [...byLink.values()].sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0));
  const newest = all[0]?.observedAt ?? null;
  const fresh = all.filter(item => freshness(item.observedAt, POLICIES[SOURCE].observationMaxAgeMs, now).fresh);
  const rows = fresh.slice(0, MAX_ROWS).map(item => {
    const level = levelOf(item.title);
    return { kind: 'health', providerId: item.link.slice('https://www.ecdc.europa.eu/'.length, 160), source: SOURCE, title: item.title,
      summary: `${item.feed} from the ECDC: ${item.title}.${item.summary ? ` ${item.summary}` : ''} Level ${level} is read from the headline words only.`.slice(0, 700),
      url: item.link, observedAt: item.observedAt, publishedAt: item.observedAt, severity: SEVERITY[level], alertLevel: level };
  });
  const note = failed.length ? ` Warning: the ${failed.join(' and ')} feed failed, so only the other feed is listed.` : '';
  return freshResult(SOURCE, newest, rows, { ...EXTRAS, summary: EXTRAS.summary + note, examinedRecords: all.length, truncatedRecords: Math.max(0, fresh.length - MAX_ROWS) }, now);
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
    try { const reply = await fetcher(feed.url, { ...request, format: 'text' }); docs[feed.name] = typeof reply?.rawText === 'string' ? reply.rawText : null; } catch { docs[feed.name] = null; }
  }));
  const result = parseEcdc(docs, now);
  if (useCache && result.status !== 'error') { cache.at = now; cache.result = result; }
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('ecdc-threats.mjs')) console.log(JSON.stringify(await briefing(), null, 2));
