import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { WORLD_FEEDS } from '../apis/utils/news-feeds.mjs';
import { safeFetch } from '../apis/utils/fetch.mjs';
import { parseFeed } from '../apis/utils/rss.mjs';
import { writeJsonAtomic } from './atomic-json.mjs';

const ROOT = process.cwd();
const CACHE_FILE = join(ROOT, 'runs', 'world-rss-cache.json');
const TIMEOUT_MS = 6000;
const CONCURRENCY = 35;
const MAX_PER_FEED = 10;
const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

let cachedItems = [];
const cachedByCountry = new Map();
let isFetching = false;
let lastSweepTime = null;
let lastStats = { totalFeeds: WORLD_FEEDS.length, ok: 0, failed: 0, totalItems: 0, durationMs: 0 };

function rebuildCountryIndex() {
  cachedByCountry.clear();
  for (const item of cachedItems) {
    if (!item.country) continue;
    const code = item.country.toUpperCase();
    if (!cachedByCountry.has(code)) cachedByCountry.set(code, []);
    cachedByCountry.get(code).push(item);
  }
}

/** Load existing cache from disk on startup */
export function loadWorldRssCache() {
  if (!existsSync(CACHE_FILE)) return false;
  try {
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (Array.isArray(data.items)) {
      cachedItems = data.items;
      lastSweepTime = data.timestamp || null;
      lastStats = data.stats || lastStats;
      rebuildCountryIndex();
      return true;
    }
  } catch (err) {
    console.warn('[WorldRSS] Failed to read cache file:', err.message);
  }
  return false;
}

async function fetchFeed(f) {
  try {
    const res = await safeFetch(f.url, { timeout: TIMEOUT_MS, retries: 0, format: 'text', maxBytes: 1024 * 1024 });
    if (res.error) return [];
    const parsed = parseFeed(res.rawText);
    const now = Date.now();
    const items = [];
    for (const item of parsed) {
      if (!item.title || item.title === f.source) continue;
      const parsedTime = item.date ? Date.parse(item.date) : NaN;
      if (Number.isFinite(parsedTime) && (now - parsedTime) > MAX_AGE_MS) continue;
      items.push({
        title: item.title,
        source: f.source,
        url: item.link || undefined,
        date: item.date,
        country: f.country,
        lang: f.lang,
        tier: f.tier || 3,
      });
      if (items.length >= MAX_PER_FEED) break;
    }
    return items;
  } catch {
    return [];
  }
}

/** Run one full sweep across all 539 world feeds in the background */
export async function runWorldRssSweep() {
  if (isFetching) return { ok: false, reason: 'Already in progress' };
  isFetching = true;
  const start = Date.now();
  console.log(`[WorldRSS] Starting background sweep for ${WORLD_FEEDS.length} world feeds...`);

  const queue = [...WORLD_FEEDS];
  const allResults = [];
  let okCount = 0;
  let failCount = 0;

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const f = queue.shift();
      if (!f) break;
      const items = await fetchFeed(f);
      if (items.length > 0) {
        okCount++;
        allResults.push(...items);
      } else {
        failCount++;
      }
    }
  });

  await Promise.all(workers);

  // De-duplicate headlines
  const seen = new Set();
  const uniqueItems = [];
  for (const item of allResults) {
    const key = (item.title || '').substring(0, 50).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueItems.push(item);
  }

  // Sort newest first
  uniqueItems.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  cachedItems = uniqueItems;
  rebuildCountryIndex();

  const durationMs = Date.now() - start;
  lastSweepTime = new Date().toISOString();
  lastStats = {
    totalFeeds: WORLD_FEEDS.length,
    ok: okCount,
    failed: failCount,
    totalItems: uniqueItems.length,
    durationMs,
  };

  try {
    writeJsonAtomic(CACHE_FILE, {
      timestamp: lastSweepTime,
      stats: lastStats,
      items: uniqueItems,
    });
  } catch (err) {
    console.warn('[WorldRSS] Failed to save world-rss-cache.json:', err.message);
  }

  console.log(`[WorldRSS] Sweep complete in ${(durationMs / 1000).toFixed(1)}s — ${uniqueItems.length} fresh headlines from ${okCount}/${WORLD_FEEDS.length} feeds`);
  isFetching = false;
  return { ok: true, stats: lastStats };
}

/** Get cached news for a given ISO country code (e.g. 'HU', 'BR', 'IN') */
export function getWorldNewsByCountry(code) {
  if (!code) return [];
  return (cachedByCountry.get(code.toUpperCase()) || []).slice();
}

/** Get all cached world news */
export function getWorldNews(limit = 100) {
  return cachedItems.slice(0, limit);
}

/** Get a balanced sample across all indexed countries */
export function getBalancedWorldNews(maxPerCountry = 8) {
  const result = [];
  const counts = new Map();
  for (const item of cachedItems) {
    const code = item.country ? item.country.toUpperCase() : 'OTHER';
    const c = counts.get(code) || 0;
    if (c < maxPerCountry) {
      result.push(item);
      counts.set(code, c + 1);
    }
  }
  return result;
}

/** Get current cache status and stats */
export function getWorldRssStats() {
  return {
    ...lastStats,
    lastSweepTime,
    isFetching,
    cachedCount: cachedItems.length,
    countriesWithNews: cachedByCountry.size,
  };
}

/**
 * Start 30-minute scheduler.
 * @param {number} intervalMinutes default 30 minutes
 */
export function startWorldRssScheduler(intervalMinutes = 30) {
  loadWorldRssCache();

  // If cache is missing or older than interval, trigger initial background sweep
  const shouldRunNow = !lastSweepTime || (Date.now() - Date.parse(lastSweepTime)) > (intervalMinutes * 60 * 1000);
  if (shouldRunNow) {
    setTimeout(() => {
      runWorldRssSweep().catch(err => console.warn('[WorldRSS] Background sweep error:', err.message));
    }, 2000).unref();
  }

  const timer = setInterval(() => {
    runWorldRssSweep().catch(err => console.warn('[WorldRSS] Scheduled sweep error:', err.message));
  }, intervalMinutes * 60 * 1000);

  timer.unref();
  return timer;
}
