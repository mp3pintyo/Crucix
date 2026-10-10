#!/usr/bin/env node
// Crucix Intelligence CLI — query history, events, and live news from terminal
// Works with or without the web server running (direct disk fallback).
// Supports 191+ countries world news feeds catalog (539 verified outlets).
// Usage: node scripts/cli.mjs [options] (or: npm run cli -- [options])

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import config from '../crucix.config.mjs';
import { WORLD_FEEDS, getFeedsByCountry, searchWorldFeeds } from '../apis/utils/news-feeds.mjs';
import { parseFeed } from '../apis/utils/rss.mjs';

const port = config.port || 3117;
const host = config.host === '0.0.0.0' ? '127.0.0.1' : (config.host || '127.0.0.1');
const runsDir = config.runsDir || join(process.cwd(), 'runs');
const historyFile = join(runsDir, 'intelligence', 'history.json');
const latestFile = join(runsDir, 'latest.json');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    category: null,
    search: null,
    source: null,
    country: null,
    limit: 10,
    listCategories: false,
    listCountries: false,
    listFeeds: false,
    searchFeeds: null,
    live: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '-c' || arg === '--category' || arg === '-k' || arg === '--kind') {
      opts.category = args[++i];
    } else if (arg === '--country' || arg === '--co') {
      opts.country = (args[++i] || '').toUpperCase();
    } else if (arg === '-q' || arg === '--search' || (arg === '-s' && args[i + 1] && !args[i + 1].startsWith('-'))) {
      opts.search = args[++i];
    } else if (arg === '--source') {
      opts.source = args[++i];
    } else if (arg === '-l' || arg === '--limit') {
      const num = parseInt(args[++i], 10);
      if (!isNaN(num) && num > 0) opts.limit = num;
    } else if (arg === '--categories' || arg === '--kinds') {
      opts.listCategories = true;
    } else if (arg === '--countries' || arg === '--world-countries') {
      opts.listCountries = true;
    } else if (arg === '--feeds') {
      opts.listFeeds = true;
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        opts.country = args[++i].toUpperCase();
      }
    } else if (arg === '--search-feeds') {
      opts.searchFeeds = args[++i];
    } else if (arg === '--live') {
      opts.live = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (!arg.startsWith('-') && !opts.category && !opts.country) {
      // Shortcut: if 2 chars and uppercase, treat as country code (e.g. `npm run cli HU`)
      if (/^[a-zA-Z]{2}$/.test(arg)) {
        opts.country = arg.toUpperCase();
      } else {
        opts.category = arg;
      }
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
Crucix Intelligence CLI — Parancssori Hír- és Eseménylekérdező
=============================================================
Használat:
  node scripts/cli.mjs [opciók]
  npm run cli -- [opciók]

Alapvető szűrők:
  -c, -k, --category <kategória>   Szűrés kategória szerint (pl. news, cyber, outage, conflict, earthquake...)
  --country <ISO kód>              Ország szerinti lekérdezés (pl. HU, DE, FR, JP, US, UA, IL...)
  -q, --search <kifejezés>         Szöveges keresés az eseményekben
  --source <forrás>                Szűrés hírforrás szerint (pl. BBC, Telex, USGS, CISA)
  -l, --limit <szám>               Megjelenített elemek száma (alapértelmezett: 10)
  --live                           Aktuális sweep élő hírszalagjának (news ticker) mutatása
  --json                           Nyers JSON kimenet (más scriptekhez vagy AI csővezetékhez)

Világ Hírforrás Katalógus (191+ ország, 539 médium):
  --countries                      Összes támogatott ország és médiumaik számának listázása
  --feeds [ISO kód]                Egy adott országban elérhető médiumok listája (pl. --feeds DE)
  --search-feeds <név>             Médium keresése a világkatalógusban (pl. --search-feeds "Spiegel")

Példák:
  npm run cli -- --countries                 # Összes ország áttekintése
  npm run cli -- --country JP                # Japán vezető lapjainak élő hírei
  npm run cli -- --country DE -l 5           # Német lapok legfrissebb 5 híre
  npm run cli -- --feeds FR                  # Franciaországban regisztrált médiumok
  npm run cli -- -c cyber -l 5               # Legutóbbi 5 kibervédelmi incidens
  npm run cli -- -q "Ukraine"                # Ukrajnával kapcsolatos események
  npm run cli -- --live -l 10                # Utolsó sweep élő hírei
`);
}

async function fetchHttp(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${host}:${port}${path}`, { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

function loadFromDisk() {
  if (!existsSync(historyFile)) return [];
  try {
    const raw = JSON.parse(readFileSync(historyFile, 'utf8'));
    return Array.isArray(raw.records) ? raw.records : [];
  } catch {
    return [];
  }
}

function loadLiveFromDisk() {
  if (!existsSync(latestFile)) return null;
  try {
    return JSON.parse(readFileSync(latestFile, 'utf8'));
  } catch {
    return null;
  }
}

function formatAge(isoString) {
  if (!isoString) return '';
  const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

async function fetchCountryLive(countryCode, limit = 10) {
  const feeds = getFeedsByCountry(countryCode);
  if (!feeds.length) return [];
  const results = await Promise.allSettled(
    feeds.map(async f => {
      try {
        const res = await fetch(f.url, {
          signal: AbortSignal.timeout(6000),
          headers: { 'User-Agent': 'Mozilla/5.0 (Crucix Intelligence Reader)' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const items = parseFeed(text);
        return items.map(item => ({
          source: f.source,
          title: item.title,
          url: item.link,
          date: item.date,
          country: f.country,
          lang: f.lang,
        }));
      } catch {
        return [];
      }
    })
  );
  const items = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
  items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return items.slice(0, limit);
}

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    printHelp();
    return;
  }

  // 1. List all countries in world feeds catalog
  if (opts.listCountries) {
    const byCountry = new Map();
    for (const f of WORLD_FEEDS) {
      if (!f.country) continue;
      if (!byCountry.has(f.country)) byCountry.set(f.country, []);
      byCountry.get(f.country).push(f.source);
    }
    const sorted = [...byCountry.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (opts.json) {
      console.log(JSON.stringify(Object.fromEntries(sorted), null, 2));
      return;
    }
    console.log(`\n=== Crucix Világméretű Médium Katalógus (${sorted.length} ország, ${WORLD_FEEDS.length} feed) ===\n`);
    for (let i = 0; i < sorted.length; i += 3) {
      const row = sorted.slice(i, i + 3).map(([code, list]) => `${code}: ${String(list.length).padStart(2)} médium`).join('   |   ');
      console.log(`  ${row}`);
    }
    console.log(`\nLekérdezéshez: npm run cli -- --country <ISO kód> (pl. npm run cli -- --country FR)\n`);
    return;
  }

  // 2. List feeds for a specific country or search feeds
  if (opts.listFeeds || opts.searchFeeds) {
    let feeds = [];
    let title = '';
    if (opts.searchFeeds) {
      feeds = searchWorldFeeds(opts.searchFeeds);
      title = `Keresés a médiumok között: "${opts.searchFeeds}" (${feeds.length} találat)`;
    } else if (opts.country) {
      feeds = getFeedsByCountry(opts.country);
      title = `Médiumok: [${opts.country}] (${feeds.length} forrás)`;
    } else {
      feeds = WORLD_FEEDS.slice(0, opts.limit);
      title = `Regisztrált médiumok (összesen ${WORLD_FEEDS.length} forrás, első ${opts.limit} db)`;
    }

    if (opts.json) {
      console.log(JSON.stringify(feeds, null, 2));
      return;
    }

    console.log(`\n=== ${title} ===\n`);
    feeds.forEach((f, idx) => {
      const c = f.country ? `[${f.country}]` : '';
      const l = f.lang ? `(${f.lang.toUpperCase()})` : '';
      console.log(`${idx + 1}. ${c} ${f.source} ${l}`);
      console.log(`   🔗 ${f.url}`);
    });
    console.log('');
    return;
  }

  // 3. Country-specific live feed query
  if (opts.country && (!opts.category || opts.category === 'news')) {
    console.log(`\n📡 Élő hírek lekérése a(z) [${opts.country}] ország vezető lapjaiból...`);
    const liveItems = await fetchCountryLive(opts.country, opts.limit);

    if (liveItems.length > 0) {
      if (opts.json) {
        console.log(JSON.stringify(liveItems, null, 2));
        return;
      }
      console.log(`\n=== Crucix Élő Hírek [${opts.country}] — ${liveItems.length} friss hír ===\n`);
      liveItems.forEach((item, idx) => {
        const time = item.date ? formatAge(item.date) : '';
        const lang = item.lang ? `[${item.lang.toUpperCase()}] ` : '';
        console.log(`${idx + 1}. [${item.source}] ${lang}${item.title}  ${time}`);
        if (item.url) console.log(`   🔗 ${item.url}`);
      });
      console.log('');
      return;
    } else {
      console.log(`⚠️ Nem sikerült élő feedet letölteni ehhez a kódhoz: ${opts.country}. Ellenőrzöm a helyi adatbázist...`);
    }
  }

  // 4. Live ticker mode
  if (opts.live) {
    let liveData = null;
    try {
      liveData = await fetchHttp('/api/data');
    } catch {
      liveData = loadLiveFromDisk();
    }

    if (!liveData || (!liveData.newsFeed && !liveData.news)) {
      console.error('❌ Nincs elérhető aktuális hír. (Futott már le sweep?)');
      process.exit(1);
    }

    const items = (liveData.newsFeed || liveData.news || []).slice(0, opts.limit);
    if (opts.json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }

    console.log(`\n=== Crucix Élő Hírek (${items.length} db) ===\n`);
    items.forEach((item, idx) => {
      const src = item.source || 'Ismeretlen';
      const time = item.timestamp ? formatAge(item.timestamp) : '';
      const headline = item.headline || item.title || '';
      const url = item.url ? ` (${item.url})` : '';
      console.log(`${idx + 1}. [${src}] ${headline}  ${time}${url}`);
    });
    console.log('');
    return;
  }

  // 5. Fetch history records (HTTP if running, disk if offline)
  let records = [];
  let isFromApi = false;

  try {
    const params = new URLSearchParams();
    if (opts.category) params.set('kind', opts.category);
    if (opts.search) params.set('q', opts.search);
    if (opts.source) params.set('source', opts.source);
    params.set('limit', String(opts.limit));

    const apiRes = await fetchHttp(`/api/history?${params.toString()}`);
    if (apiRes && Array.isArray(apiRes.items)) {
      records = apiRes.items;
      isFromApi = true;
      if (opts.listCategories && apiRes.stats?.byKind) {
        if (opts.json) {
          console.log(JSON.stringify(apiRes.stats.byKind, null, 2));
          return;
        }
        console.log(`\n=== Crucix Elérhető Eseménykategóriák ===\n`);
        const entries = Object.entries(apiRes.stats.byKind).sort((a, b) => b[1] - a[1]);
        entries.forEach(([kind, count]) => {
          console.log(`  • ${kind.padEnd(16)} : ${count} esemény`);
        });
        console.log(`\nÖsszesen: ${apiRes.stats.totalRecords} rögzített esemény.\n`);
        return;
      }
    }
  } catch {
    records = loadFromDisk();
  }

  if (opts.listCategories) {
    const byKind = {};
    for (const r of records) {
      byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    }
    if (opts.json) {
      console.log(JSON.stringify(byKind, null, 2));
      return;
    }
    console.log(`\n=== Crucix Elérhető Eseménykategóriák (Offline Archívum) ===\n`);
    const entries = Object.entries(byKind).sort((a, b) => b[1] - a[1]);
    entries.forEach(([kind, count]) => {
      console.log(`  • ${kind.padEnd(16)} : ${count} esemény`);
    });
    console.log(`\nÖsszesen: ${records.length} rögzített esemény.\n`);
    return;
  }

  // Filter if loaded from disk directly
  if (!isFromApi) {
    if (opts.category) {
      records = records.filter(r => r.kind.toLowerCase() === opts.category.toLowerCase());
    }
    if (opts.source) {
      const s = opts.source.toLowerCase();
      records = records.filter(r => (r.source?.name || '').toLowerCase().includes(s));
    }
    if (opts.country) {
      const c = opts.country.toLowerCase();
      records = records.filter(r => (r.location?.label || '').toLowerCase().includes(c));
    }
    if (opts.search) {
      const q = opts.search.toLowerCase();
      records = records.filter(r =>
        (r.title || '').toLowerCase().includes(q) ||
        (r.summary || '').toLowerCase().includes(q) ||
        (r.location?.label || '').toLowerCase().includes(q) ||
        (r.source?.name || '').toLowerCase().includes(q)
      );
    }
    records = records.slice(0, opts.limit);
  }

  if (opts.json) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  const titlePrefix = opts.category ? `Kategória: [${opts.category}]` : 'Minden kategória';
  const filterDesc = opts.search ? ` | Keresés: "${opts.search}"` : '';
  console.log(`\n=== Crucix Események (${titlePrefix}${filterDesc}) — Találatok: ${records.length} ===\n`);

  if (records.length === 0) {
    console.log(`Nincs találat a megadott feltételekre.`);
    console.log(`Tipp: Futtasd a kategóriák listázását: npm run cli -- --categories\n`);
    return;
  }

  records.forEach((rec, idx) => {
    const kindTag = `[${rec.kind}]`.padEnd(12);
    const src = rec.source?.name || 'Ismeretlen';
    const loc = rec.location?.label ? ` 📍 ${rec.location.label}` : '';
    const age = rec.publishedAt || rec.lastSeenAt ? ` (${formatAge(rec.publishedAt || rec.lastSeenAt)})` : '';
    console.log(`${idx + 1}. ${kindTag} [${src}] ${rec.title}${loc}${age}`);
    if (rec.source?.url) {
      console.log(`   🔗 ${rec.source.url}`);
    }
    console.log('');
  });
}

main();
