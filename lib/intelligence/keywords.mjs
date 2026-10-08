// Trending terms: words that suddenly appear in many more headlines than usual. The method is World Monitor's keyword spike
// (koala73/worldmonitor, AGPL-3.0, docs/algorithms.mdx "Trending Keyword Spike Detection"): a short window against a longer baseline of the same
// word, a minimum absolute count, a multiple of the baseline and at least two different sources. Crucix reads far fewer headlines than World
// Monitor (about 60 a sweep from the RSS feeds, plus GDELT and Telegram), so the thresholds are lower and the window is the last two hours:
//   - a term needs at least 4 headlines in the window, from at least 2 sources, and more than 3 times its usual 2-hour count
//     (the mean over the observed hours of the last 7 days, never below 0.5 so that a brand-new word needs a real burst);
//   - nothing is reported until the store has seen 24 hours of headlines (the baseline would be a guess).
// Every headline counts once: a headline that stays in a feed for days is recognised by a hash of its source and title and is not counted again.
// The store is runs/intelligence/keywords.json (atomic, with a .bak copy); a missing or corrupt file starts empty and never stops a sweep.
import { join } from 'node:path';
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.mjs';

const VERSION = 1;
const HOUR = 3600000;
const DAY = 24 * HOUR;
export const KEYWORDS = Object.freeze({ retentionMs: 8 * DAY, baselineMs: 7 * DAY, windowHours: 2, minCount: 4, minSources: 2, multiple: 3, floor: 0.5, minObservedHours: 24,
  maxTermsPerBucket: 200, maxSeen: 8000, maxItems: 400, top: 8, highRatio: 8, highCount: 8, highSources: 3 });
const MIN_LEN = 4, MAX_LEN = 30;
const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}-]*/gu;
const CVE = /^cve-\d{4}-\d{4,7}$/;
// Words that carry no news: function words and newsroom boilerplate, English first, then the most common Hungarian ones.
const STOP = new Set(('about above after again against also among another around because been before being below between both could did does doing down during each '
  + 'even every first from further have having here hers himself into itself just know last like made make many more most much must never next only other over said says '
  + 'same should since some still such take than that their theirs them themselves then there these they this those through today under until very want were what when '
  + 'where which while whom will with within without would year years your news live update updates video watch breaking latest report reports according new '
  + 'amid says say told tells week weeks monday tuesday wednesday thursday friday saturday sunday '
  + 'january february march april june july august september october november december '
  + 'hogy vagy volt lesz nincs mint egy ezt azt meg még már csak után előtt között szerint miatt ellen első második lehet kell most majd nem igen ahogy'
).split(/\s+/));

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);

/** The distinct terms of one headline (lower case, 4 to 30 characters, no stop words, no pure numbers), at most 24. */
export function termsOf(title) {
  if (typeof title !== 'string') return [];
  const found = new Set();
  for (const match of title.slice(0, 400).toLowerCase().matchAll(TOKEN)) {
    const word = match[0].replace(/^-+|-+$/g, '');
    if (word.length < MIN_LEN || word.length > MAX_LEN || /^[\d-]+$/.test(word) || STOP.has(word)) continue;
    found.add(word);
    if (found.size >= 24) break;
  }
  return [...found];
}

// A short stable hash (FNV-1a, 32 bits) of source and title: the identity of a headline, not a security feature.
function hash(source, title) {
  let h = 0x811c9dc5;
  for (const char of `${source}|${title}`.slice(0, 500)) { h ^= char.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
const sourceName = value => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f|]/g, ' ').trim().slice(0, 40) : '');

export class KeywordStore {
  #now;

  constructor(runsDir, { now = Date.now } = {}) {
    this.path = join(String(runsDir), 'intelligence', 'keywords.json');
    this.#now = typeof now === 'function' ? now : Date.now;
    this.buckets = new Map(); // hour start -> { items, terms: Map<term, { n, s: Set<source> }> }
    this.seen = new Map();    // headline hash -> hour start
    this.since = null;
    this.status = 'empty';
  }

  /** Read the file (or its .bak). Missing, corrupt or oversized gives an empty store; never throws. */
  load() {
    const result = readJsonWithBackup(this.path, { validate: value => object(value) && value.version === VERSION && object(value.buckets) });
    this.buckets = new Map();
    this.seen = new Map();
    this.since = null;
    const value = result.value;
    if (value) {
      for (const [hour, raw] of Object.entries(value.buckets)) {
        const start = Number(hour);
        if (!finite(start) || !object(raw) || !object(raw.terms)) continue;
        const terms = new Map();
        for (const [term, entry] of Object.entries(raw.terms)) {
          if (!Array.isArray(entry) || !Number.isInteger(entry[0]) || entry[0] < 1) continue;
          terms.set(term, { n: entry[0], s: new Set(typeof entry[1] === 'string' ? entry[1].split('|').filter(Boolean).slice(0, 6) : []) });
        }
        this.buckets.set(start, { items: Number.isInteger(raw.items) ? raw.items : 0, terms });
      }
      for (const [key, hour] of Object.entries(object(value.seen) ? value.seen : {})) if (finite(hour)) this.seen.set(key, hour);
      this.since = finite(value.since) ? value.since : null;
    }
    this.status = result.source === 'primary' ? 'ok' : result.source === 'backup' ? 'recovered' : result.error ? 'corrupt' : 'empty';
    this.#prune(this.#now());
    return this.status;
  }

  /** Count the headlines `[{ title, source }]` not seen before. Returns how many were new. */
  ingest(items, { now = this.#now() } = {}) {
    const hour = Math.floor(now / HOUR) * HOUR;
    if (this.since === null) this.since = now;
    let bucket = this.buckets.get(hour);
    if (!bucket) { bucket = { items: 0, terms: new Map() }; this.buckets.set(hour, bucket); }
    let added = 0;
    for (const item of (Array.isArray(items) ? items : []).slice(0, KEYWORDS.maxItems)) {
      const title = typeof item?.title === 'string' ? item.title.trim() : '';
      const source = sourceName(item?.source);
      if (!title || !source) continue;
      const key = hash(source, title);
      if (this.seen.has(key)) continue;
      this.seen.set(key, hour);
      added++;
      bucket.items++;
      for (const term of termsOf(title)) {
        const entry = bucket.terms.get(term) ?? { n: 0, s: new Set() };
        entry.n++;
        if (entry.s.size < 6) entry.s.add(source);
        bucket.terms.set(term, entry);
      }
    }
    this.#prune(now);
    return added;
  }

  /**
   * The trending terms of the last two hours: `{ ready, observedHours, items }`. `ready` is false until 24 observed hours; each item is
   * `{ term, count, baseline, ratio, sources, level }` with the baseline the usual 2-hour count and the level moderate or high.
   */
  detect({ now = this.#now() } = {}) {
    const hour = Math.floor(now / HOUR) * HOUR;
    const windowStart = hour - (KEYWORDS.windowHours - 1) * HOUR;
    const baselineFrom = hour - KEYWORDS.baselineMs;
    let observed = 0;
    for (const [start, bucket] of this.buckets) if (start >= baselineFrom && start < windowStart && bucket.items > 0) observed++;
    if (observed < KEYWORDS.minObservedHours) return { ready: false, observedHours: observed, items: [] };
    const current = new Map();
    const usual = new Map();
    for (const [start, bucket] of this.buckets) {
      if (start >= windowStart && start <= hour) {
        for (const [term, entry] of bucket.terms) {
          const sum = current.get(term) ?? { n: 0, s: new Set() };
          sum.n += entry.n;
          for (const source of entry.s) sum.s.add(source);
          current.set(term, sum);
        }
      } else if (start >= baselineFrom && start < windowStart) {
        for (const [term, entry] of bucket.terms) usual.set(term, (usual.get(term) ?? 0) + entry.n);
      }
    }
    const items = [];
    for (const [term, sum] of current) {
      if (sum.n < KEYWORDS.minCount || sum.s.size < KEYWORDS.minSources) continue;
      const baseline = (usual.get(term) ?? 0) / observed * KEYWORDS.windowHours;
      const ratio = sum.n / Math.max(baseline, KEYWORDS.floor);
      if (ratio <= KEYWORDS.multiple && !CVE.test(term)) continue;
      const high = ratio >= KEYWORDS.highRatio && sum.n >= KEYWORDS.highCount && sum.s.size >= KEYWORDS.highSources;
      items.push({ term, count: sum.n, baseline: Math.round(baseline * 10) / 10, ratio: Math.round(ratio * 10) / 10, sources: [...sum.s].sort().slice(0, 4), level: high ? 'high' : 'moderate' });
    }
    items.sort((a, b) => b.ratio - a.ratio || b.count - a.count || (a.term < b.term ? -1 : 1));
    return { ready: true, observedHours: observed, items: items.slice(0, KEYWORDS.top) };
  }

  #prune(now) {
    const floor = now - KEYWORDS.retentionMs;
    for (const start of [...this.buckets.keys()]) if (start < floor) this.buckets.delete(start);
    for (const [key, hour] of this.seen) if (hour < floor) this.seen.delete(key);
    if (this.seen.size > KEYWORDS.maxSeen) {
      const ordered = [...this.seen].sort((a, b) => a[1] - b[1]);
      for (const [key] of ordered.slice(0, this.seen.size - KEYWORDS.maxSeen)) this.seen.delete(key);
    }
    for (const bucket of this.buckets.values()) {
      if (bucket.terms.size <= KEYWORDS.maxTermsPerBucket) continue;
      const kept = [...bucket.terms].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1)).slice(0, KEYWORDS.maxTermsPerBucket);
      bucket.terms = new Map(kept);
    }
  }

  save(logger = console) {
    this.#prune(this.#now());
    try {
      const buckets = {};
      for (const [start, bucket] of this.buckets) {
        buckets[start] = { items: bucket.items, terms: Object.fromEntries([...bucket.terms].map(([term, entry]) => [term, [entry.n, [...entry.s].join('|')]])) };
      }
      writeJsonAtomic(this.path, { version: VERSION, since: this.since, buckets, seen: Object.fromEntries(this.seen) });
      return true;
    } catch (error) {
      try { logger?.warn?.(`[Keywords] keywords.json not saved (${error instanceof Error ? error.message : String(error)})`); } catch { /* logging never breaks the store */ }
      return false;
    }
  }
}

/** The headlines of a snapshot for the store: the merged news feed (RSS, GDELT, Telegram) as `{ title, source }`. */
export function headlinesOf(snapshot) {
  const feed = Array.isArray(snapshot?.newsFeed) ? snapshot.newsFeed : [];
  return feed.filter(item => object(item) && typeof item.headline === 'string').slice(0, KEYWORDS.maxItems).map(item => ({ title: item.headline, source: item.source }));
}
