#!/usr/bin/env node
// Crucix Intelligence CLI — query intelligence, markets, alerts, events, and news
// Works with or without the web server running (direct disk fallback).
// Supports 191+ countries world news feeds catalog (539 verified outlets)
// and all 71 OSINT adapters, markets, energy, metals, thermal, earthquakes, chokepoints, cyber.
// Usage: node scripts/cli.mjs [options] (or: npm run cli -- [options])

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import config from '../crucix.config.mjs';
import { WORLD_FEEDS, getFeedsByCountry, searchWorldFeeds } from '../apis/utils/news-feeds.mjs';
import { parseFeed } from '../apis/utils/rss.mjs';
import { loadWorldRssCache, getWorldNewsByCountry, getWorldNews } from '../lib/world-rss-runner.mjs';
import { fullBriefing } from '../apis/briefing.mjs';
import { synthesize } from '../dashboard/inject.mjs';
import { countryByIso3 } from '../lib/intelligence/countries.mjs';

const port = config.port || 3117;
const host = config.host === '0.0.0.0' ? '127.0.0.1' : (config.host || '127.0.0.1');
const runsDir = config.runsDir || join(process.cwd(), 'runs');
const historyFile = join(runsDir, 'intelligence', 'history.json');
const latestFile = join(runsDir, 'latest.json');
const alertsFile = join(runsDir, 'alerts', 'alerts.json');
const countriesFile = join(runsDir, 'intelligence', 'countries.json');
const predictionsFile = join(runsDir, 'intelligence', 'predictions.json');
const thermalFile = join(runsDir, 'intelligence', 'thermal.json');
const sweepsFile = join(runsDir, 'sweeps', 'index.json');
const hotMemoryFile = join(runsDir, 'memory', 'hot.json');

function parseArgs(argv = process.argv.slice(2)) {
  const args = argv;
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
    noServer: false,
    sweep: false,

    // Data switches
    brief: false,
    alerts: false,
    allAlerts: false,
    markets: false,
    energy: false,
    metals: false,
    commodities: false,
    risk: false,
    countryRisk: null,
    earthquakes: false,
    thermal: false,
    disasters: false,
    chokepoints: false,
    air: false,
    cyber: false,
    outages: false,
    predictions: false,
    health: false,
    sources: false,
    sourceData: null,
    sweeps: false,
    delta: false,
    all: false,
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
    } else if (arg === '--no-server' || arg === '--standalone' || arg === '--offline' || arg === '--direct' || arg === '-S') {
      opts.noServer = true;
    } else if (arg === '--sweep' || arg === '--run-sweep') {
      opts.sweep = true;
    } else if (arg === '-b' || arg === '--brief' || arg === '--briefing') {
      opts.brief = true;
    } else if (arg === '-A' || arg === '--alerts') {
      opts.alerts = true;
    } else if (arg === '--all-alerts') {
      opts.alerts = true;
      opts.allAlerts = true;
    } else if (arg === '-m' || arg === '--markets' || arg === '--finance') {
      opts.markets = true;
    } else if (arg === '--energy') {
      opts.energy = true;
    } else if (arg === '--metals') {
      opts.metals = true;
    } else if (arg === '--commodities') {
      opts.commodities = true;
    } else if (arg === '--risk' || arg === '--country-risk') {
      opts.risk = true;
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        opts.countryRisk = args[++i].toUpperCase();
      }
    } else if (arg === '--earthquakes' || arg === '--quakes' || arg === '--eq') {
      opts.earthquakes = true;
    } else if (arg === '--thermal' || arg === '--fires') {
      opts.thermal = true;
    } else if (arg === '--disasters') {
      opts.disasters = true;
    } else if (arg === '--chokepoints' || arg === '--maritime') {
      opts.chokepoints = true;
    } else if (arg === '--air' || arg === '--aviation') {
      opts.air = true;
    } else if (arg === '--cyber') {
      opts.cyber = true;
    } else if (arg === '--outages') {
      opts.outages = true;
    } else if (arg === '--predictions') {
      opts.predictions = true;
    } else if (arg === '--status' || arg === '--health') {
      opts.health = true;
    } else if (arg === '--sources') {
      opts.sources = true;
    } else if (arg === '--source-data') {
      opts.sourceData = args[++i];
    } else if (arg === '--sweeps') {
      opts.sweeps = true;
    } else if (arg === '--delta') {
      opts.delta = true;
    } else if (arg === '-a' || arg === '--all') {
      opts.all = true;
    } else if (!arg.startsWith('-') && !opts.category && !opts.country) {
      if (/^[a-zA-Z]{2,3}$/.test(arg)) {
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
Crucix Intelligence CLI — Parancssori Hír-, Esemény- és Hírszerzési Lekérdező
==========================================================================
Használat:
  node scripts/cli.mjs [opciók]
  npm run cli -- [opciók]

Intelligencia & Összefoglalók:
  -b, --brief                      Vezetői intelligencia összefoglaló (piaci irány, VIX, olaj, arany, OSINT)
  -a, --all                        Teljes átfogó jelentés minden kulcsterületről a terminálban
  -A, --alerts                     Aktív és legutóbbi riasztások listázása (--all-alerts: feloldottak is)
  --status, --health               Rendszer és a 71 OSINT adatforrás állapota (OK, Stale, Failed)
  --sources                        Minden elérhető OSINT adatforrás állapotának listázása
  --source-data <forrásnév>        Egy konkrét adatforrás (pl. USGS, YFinance, FIRMS) adatainak mutatása
  --delta                          A legutóbbi sweep változásai (új jelek, eszkalációk)
  --sweeps                         Rögzített sweep adatgyűjtések története és statisztikái

Piacok, Energia & Nyersanyagok:
  -m, --markets, --finance         Részvényindexek (S&P 500, Nasdaq, Dow), kötvényhozamok, VIX, Kripto (BTC)
  --energy                         WTI és Brent nyersolaj, Földgáz (NatGas), készletinformációk
  --metals                         Nemesfémek: Arany (Gold) és Ezüst (Silver) árai és napi mozgásai
  --commodities                    Együttes árupiaci táblázat (Energia és Nemesfémek)

Geopolitika & Kockázatok:
  --risk [ISO3]                    Geopolitikai országkockázati rangsor (Top kockázatos országok)
  --country-risk <ISO3>            Egy adott ország (pl. UA, PAN, USA, IL) részletes kockázati profilja
  --predictions                    Predikciós piacok (Manifold, Polymarket) és konfliktus előrejelzések

Fizikai Biztonság, Légtér & Hajózás:
  --earthquakes, --quakes          Földrengések (USGS/EMSC: magnitúdó, helyszín, szökőár veszély)
  --thermal, --fires               NASA FIRMS műholdas hőtérkép és tűz hotspotok (Közel-Kelet, Ukrajna)
  --chokepoints, --maritime        Globális tengeri fojtópontok és szorosok állapota (Hormuz, Szuez, Malakka)
  --air, --aviation                Légtér aktivitás, OpenSky repülések, katonai transzponderek
  --disasters                      Összevont természeti katasztrófa figyelő (rengések, viharok, tüzek)

Kiberbiztonság & Hálózat:
  --cyber                          CISA KEV aktívan kihasznált sebezhetőségek és ThreatFox indikátorok
  --outages                        Globális internetkimaradások és hálózati anomáliák (IODA)

Hírek és Eseményarchívum:
  -c, --category <kategória>       Szűrés kategória szerint (pl. news, cyber, outage, conflict, earthquake...)
  --country <ISO kód>              Ország szerinti hírek (pl. HU, DE, FR, JP, US, UA, IL, BR...)
  -q, --search <kifejezés>         Szöveges keresés az eseményekben
  --source <forrás>                Szűrés hírforrás szerint (pl. BBC, Telex, USGS, CISA)
  -l, --limit <szám>               Megjelenített elemek száma (alapértelmezett: 10)
  --live                           Aktuális sweep élő hírszalagjának (news ticker) mutatása
  --json                           Nyers JSON kimenet (más scriptekhez vagy AI csővezetékhez)

Szerver nélküli (Standalone / Offline) futtatás:
  --no-server, --standalone, -S    Közvetlen lemezes / offline futás (nem csatlakozik a web szerverhez).
                                   Kizárólag a helyi lemezen lévő archívumból és gyorsítótárból dolgozik.
  --offline, --direct              A --no-server szinonimái
  --sweep, --run-sweep             Egyszeri elemzési sweep futtatása a terminálban háttérszerver nélkül.

Világ Hírforrás Katalógus (191+ ország, 539 médium):
  --countries                      Összes támogatott ország és médiumaik számának listázása
  --feeds [ISO kód]                Egy adott országban elérhető médiumok listája (pl. --feeds DE)
  --search-feeds <név>             Médium keresése a világkatalógusban (pl. --search-feeds "Spiegel")

Példák:
  npm run cli -- -b                          # Vezetői intelligencia összefoglaló (Briefing)
  npm run cli -- -m                          # Piacok, VIX, arany, olaj, kripto áttekintése
  npm run cli -- --earthquakes               # Legfrissebb földrengések (USGS)
  npm run cli -- --thermal                   # NASA FIRMS műholdas hőtérkép
  npm run cli -- --risk                      # Geopolitikai országkockázatok rangsora
  npm run cli -- --risk UA                   # Ukrajna részletes kockázati profilja
  npm run cli -- --cyber                     # Kiberbiztonsági sebezhetőségek (CISA KEV)
  npm run cli -- --alerts                    # Riasztások és fenyegetettségi szint
  npm run cli -- --country JP --no-server    # Japán hírek a helyi RSS gyorsítótárból
  npm run cli -- --source-data USGS          # USGS forrás nyers adatainak megjelenítése
  npm run cli -- -a                          # Átfogó terminál jelentés minden kulcsterületről
`);
}

function fetchHttp(path, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${host}:${port}${path}`, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Időtúllépés (Timeout)'));
    });
  });
}

function readJsonSafe(filepath) {
  try {
    if (existsSync(filepath)) {
      return JSON.parse(readFileSync(filepath, 'utf8'));
    }
  } catch {
    // ignore
  }
  return null;
}

function formatAge(dateString) {
  if (!dateString) return '';
  const now = Date.now();
  const then = new Date(dateString).getTime();
  if (isNaN(then)) return '';
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function formatNumber(num, decimals = 2) {
  if (num === null || num === undefined || isNaN(num)) return '--';
  return Number(num).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatPct(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return '--';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${Number(pct).toFixed(2)}%`;
}

// === Data Loaders ===

let cachedSynthesized = null;

function loadLatestRaw() {
  return readJsonSafe(latestFile);
}

async function getSynthesizedData(opts) {
  if (cachedSynthesized) return cachedSynthesized;

  if (!opts.noServer) {
    try {
      const data = await fetchHttp('/api/data');
      if (data && typeof data === 'object') {
        cachedSynthesized = { data, isFromApi: true };
        return cachedSynthesized;
      }
    } catch {
      // Fall through to disk
    }
  }

  const raw = loadLatestRaw();
  if (!raw) return { data: null, isFromApi: false };

  try {
    const syn = await synthesize(raw, { news: [] });
    cachedSynthesized = { data: syn, raw, isFromApi: false };
    return cachedSynthesized;
  } catch {
    cachedSynthesized = { data: raw, raw, isFromApi: false };
    return cachedSynthesized;
  }
}

async function getAlertsData(opts) {
  if (!opts.noServer) {
    try {
      const res = await fetchHttp('/api/alerts');
      if (res && res.alerts) return { alerts: res.alerts, isFromApi: true };
    } catch {
      // fallback
    }
  }
  const fileData = readJsonSafe(alertsFile);
  return { alerts: fileData?.alerts || [], engine: fileData?.engine || null, isFromApi: false };
}

async function getCountryRiskData(opts) {
  if (!opts.noServer) {
    try {
      if (opts.countryRisk) {
        const res = await fetchHttp(`/api/countries/${opts.countryRisk}`);
        if (res && res.iso3) return { detail: res, isFromApi: true };
      } else {
        const res = await fetchHttp('/api/countries');
        if (res && Array.isArray(res.countries)) return { list: res.countries, isFromApi: true };
      }
    } catch {
      // fallback
    }
  }

  const fileData = readJsonSafe(countriesFile);
  if (!fileData) return { list: [], detail: null, isFromApi: false };

  if (opts.countryRisk) {
    const code = opts.countryRisk.toUpperCase();
    const series = fileData.series?.[code] || [];
    const lastPoint = series[series.length - 1];
    const score = Array.isArray(lastPoint) ? lastPoint[1] : (lastPoint?.score ?? null);
    const countryInfo = countryByIso3(code);
    return {
      detail: {
        iso3: code,
        name: countryInfo?.name || code,
        score,
        eventsCount: fileData.events?.[code]?.length || 0,
        series: series.slice(-5),
      },
      isFromApi: false,
    };
  }

  const scored = Object.entries(fileData.series || {}).map(([iso3, points]) => {
    const last = points[points.length - 1];
    const prev = points.length > 1 ? points[points.length - 2] : null;
    const score = Array.isArray(last) ? last[1] : (last?.score || 0);
    const prevScore = Array.isArray(prev) ? prev[1] : (prev?.score || score);
    const country = countryByIso3(iso3);
    return {
      iso3,
      name: country?.name || iso3,
      score,
      change24h: score - prevScore,
    };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score);

  return { list: scored, isFromApi: false };
}

function loadFromDisk() {
  const data = readJsonSafe(historyFile);
  if (!data || !Array.isArray(data.records)) return [];
  return data.records;
}

function loadLiveFromDisk() {
  return readJsonSafe(latestFile);
}

async function fetchCountryLive(countryCode, limit = 10) {
  const feeds = getFeedsByCountry(countryCode);
  if (!feeds.length) return [];

  const promises = feeds.map(feed =>
    parseFeed(feed.url, { timeoutMs: 7000 })
      .then(items => items.map(item => ({ ...item, source: feed.source, country: countryCode, lang: feed.lang })))
      .catch(() => [])
  );

  const results = await Promise.allSettled(promises);
  const allItems = [];
  for (const res of results) {
    if (res.status === 'fulfilled' && Array.isArray(res.value)) {
      allItems.push(...res.value);
    }
  }

  allItems.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return allItems.slice(0, limit);
}

// === Display Formatters ===

function showBriefing(synData, alertsData, riskData, opts) {
  const d = synData.data || {};
  const raw = synData.raw || loadLatestRaw() || {};
  const hot = readJsonSafe(hotMemoryFile);
  const delta = hot?.runs?.[hot.runs.length - 1]?.delta;

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  console.log(`\n=============================================================`);
  console.log(`             CRUCIX INTELLIGENCE BRIEFING ${modeLabel}`);
  console.log(`=============================================================`);

  const meta = d.meta || raw.crucix || {};
  const sweepTime = meta.timestamp ? new Date(meta.timestamp).toISOString().replace('T', ' ').substring(0, 19) + ' UTC' : 'Ismeretlen';
  console.log(`🕒 Időpont: ${sweepTime} | Források: ${meta.sourcesOk || '--'}/${meta.sourcesQueried || '--'} OK`);

  // Direction & Threat
  if (delta?.summary) {
    const dirEmoji = { 'risk-off': '📉', 'risk-on': '📈', 'mixed': '↔️' }[delta.summary.direction] || '↔️';
    console.log(`🧭 Piaci Trend & Delta : ${dirEmoji} ${String(delta.summary.direction).toUpperCase()} (${delta.summary.totalChanges || 0} változás, ${delta.summary.criticalChanges || 0} kritikus)`);
  }

  const activeAlerts = (alertsData.alerts || []).filter(a => a.state === 'active');
  const alertCount = activeAlerts.length;
  console.log(`🛡️  Aktív Riasztások     : ${alertCount > 0 ? `🚨 ${alertCount} db aktív riasztás!` : '✅ 0 aktív (Nyugodt állapot)'}`);

  // Markets summary
  const energy = d.energy || {};
  const metals = d.metals || {};
  const yfQuotes = raw.sources?.YFinance?.quotes || {};
  const vix = yfQuotes['^VIX']?.price || d.markets?.vix?.value;
  const sp500 = yfQuotes['^GSPC']?.price;
  const btc = yfQuotes['BTC-USD']?.price;

  console.log(`\n📊 Kulcs Indikátorok:`);
  console.log(`   • VIX: ${vix ? formatNumber(vix) : '--'} | S&P 500: ${sp500 ? formatNumber(sp500) : '--'} | BTC: $${btc ? formatNumber(btc, 0) : '--'}`);
  console.log(`   • WTI Olaj: $${energy.wti ? formatNumber(energy.wti) : '--'} | Brent: $${energy.brent ? formatNumber(energy.brent) : '--'} | Földgáz: $${energy.natgas ? formatNumber(energy.natgas) : '--'}`);
  console.log(`   • Arany (Gold): $${metals.gold ? formatNumber(metals.gold) : '--'} | Ezüst (Silver): $${metals.silver ? formatNumber(metals.silver) : '--'}`);

  // Earthquakes & Fires highlights
  const quakes = d.earthquakes || raw.sources?.USGS?.earthquakes || [];
  if (quakes.length > 0) {
    const topQ = quakes[0];
    const tsu = topQ.tsunamiFlag ? ' 🌊 [TSUNAMI VESZÉLY!]' : '';
    console.log(`\n🌍 Kiemelt Szeizmikus Esemény:`);
    console.log(`   • [M ${topQ.magnitude}] ${topQ.place}${tsu} (${formatAge(topQ.time)})`);
  }

  const firms = raw.sources?.FIRMS;
  if (firms?.hotspots?.length > 0) {
    const totalDetections = firms.hotspots.reduce((acc, h) => acc + (h.totalDetections || 0), 0);
    console.log(`\n🔥 Műholdas Hőtérkép (NASA FIRMS):`);
    console.log(`   • ${totalDetections} termális detektálás regisztrálva (${firms.hotspots.map(h => `${h.region}: ${h.totalDetections}`).join(', ')})`);
  }

  // OSINT & Telegram
  const tg = d.tg || raw.sources?.Telegram || {};
  const urgent = tg.urgent || [];
  if (urgent.length > 0) {
    console.log(`\n📡 Sürgős OSINT Jelek (Telegram):`);
    for (const post of urgent.slice(0, 3)) {
      const text = (post.text || '').replace(/\s+/g, ' ').substring(0, 110);
      console.log(`   • ${text}...`);
    }
  }

  // Top ideas
  const ideas = (d.ideas || []).slice(0, 3);
  if (ideas.length > 0) {
    console.log(`\n💡 Elemzői Stratégiai Ötletek:`);
    for (const idea of ideas) {
      const typeIcon = idea.type === 'long' ? '📈' : idea.type === 'hedge' ? '🛡️' : '👁️';
      console.log(`   ${typeIcon} [${idea.type?.toUpperCase()}] ${idea.title}`);
    }
  }

  console.log(`=============================================================\n`);
}

function showMarkets(synData, opts) {
  const d = synData.data || {};
  const raw = synData.raw || loadLatestRaw() || {};
  const yf = raw.sources?.YFinance || {};
  const markets = d.markets || {};

  if (opts.json) {
    console.log(JSON.stringify({ markets, yfinance: yf }, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  console.log(`\n=== Crucix Piacok & Pénzügyi Indikátorok ${modeLabel} ===\n`);

  const indexes = yf.indexes || markets.indexes || [];
  if (indexes.length > 0) {
    console.log(`📈 Részvényindexek:`);
    for (const idx of indexes) {
      console.log(`  • ${idx.name.padEnd(20)} : ${formatNumber(idx.price).padStart(10)}  (${formatPct(idx.changePct)})`);
    }
    console.log('');
  }

  const commodities = yf.commodities || markets.commodities || [];
  if (commodities.length > 0) {
    console.log(`⚡ Árupiac & Nyersanyagok:`);
    for (const c of commodities) {
      console.log(`  • ${c.name.padEnd(20)} : $${formatNumber(c.price).padStart(10)} (${formatPct(c.changePct)})`);
    }
    console.log('');
  }

  const crypto = yf.crypto || markets.crypto || [];
  if (crypto.length > 0) {
    console.log(`🪙 Kriptovaluták:`);
    for (const cr of crypto) {
      console.log(`  • ${cr.name.padEnd(20)} : $${formatNumber(cr.price).padStart(10)} (${formatPct(cr.changePct)})`);
    }
    console.log('');
  }

  const rates = yf.rates || markets.rates || [];
  if (rates.length > 0) {
    console.log(`📊 Kötvényhozamok & Kamatok:`);
    for (const r of rates) {
      console.log(`  • ${r.name.padEnd(20)} : ${formatNumber(r.price)}%`);
    }
    console.log('');
  }
}

function showEnergy(synData, opts) {
  const d = synData.data || {};
  const raw = synData.raw || loadLatestRaw() || {};
  const energy = d.energy || {};
  const yf = raw.sources?.YFinance?.quotes || {};

  if (opts.json) {
    console.log(JSON.stringify(energy, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  console.log(`\n=== Crucix Energia & Árupiac ${modeLabel} ===\n`);

  console.log(`⚡ Kőolaj & Földgáz Árak:`);
  const wtiPct = yf['CL=F']?.changePct;
  const brentPct = yf['BZ=F']?.changePct;
  const natgasPct = yf['NG=F']?.changePct;

  console.log(`  • WTI Nyersolaj   : $${formatNumber(energy.wti)} / hordó  ${wtiPct !== undefined ? `(${formatPct(wtiPct)})` : ''}`);
  console.log(`  • Brent Nyersolaj : $${formatNumber(energy.brent)} / hordó ${brentPct !== undefined ? `(${formatPct(brentPct)})` : ''}`);
  console.log(`  • Földgáz (NatGas): $${formatNumber(energy.natgas)} / MMBtu  ${natgasPct !== undefined ? `(${formatPct(natgasPct)})` : ''}`);

  if (energy.crudeStocks) {
    console.log(`\n📦 Nyersolaj Készletek (EIA):`);
    console.log(`  • Készlet szint   : ${energy.crudeStocks} millió hordó`);
  }

  if (Array.isArray(energy.signals) && energy.signals.length > 0) {
    console.log(`\n📡 Energiaipari Szignálok:`);
    for (const s of energy.signals.slice(0, 5)) {
      console.log(`  • ${s.title || s.label || JSON.stringify(s)}`);
    }
  }
  console.log('');
}

function showMetals(synData, opts) {
  const d = synData.data || {};
  const metals = d.metals || {};

  if (opts.json) {
    console.log(JSON.stringify(metals, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  console.log(`\n=== Crucix Nemesfémek ${modeLabel} ===\n`);

  console.log(`🥇 Arany & Ezüst Árak:`);
  console.log(`  • Arany (Gold)  : $${formatNumber(metals.gold)} / oz   (${formatPct(metals.goldChangePct)})`);
  console.log(`  • Ezüst (Silver): $${formatNumber(metals.silver)} / oz   (${formatPct(metals.silverChangePct)})`);
  console.log('');
}

function showAlerts(alertsData, opts) {
  const allList = alertsData.alerts || [];
  const activeList = allList.filter(a => a.state === 'active');
  const items = (opts.allAlerts ? allList : (activeList.length > 0 ? activeList : allList)).slice(0, opts.limit);

  if (opts.json) {
    console.log(JSON.stringify({ active: activeList, all: allList }, null, 2));
    return;
  }

  const modeLabel = alertsData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  console.log(`\n=== Crucix Riasztások ${modeLabel} (Aktív: ${activeList.length} db, Összes: ${allList.length} db) ===\n`);

  if (items.length === 0) {
    console.log(`✅ Nincs aktív riasztás.`);
    return;
  }

  if (activeList.length === 0 && !opts.allAlerts) {
    console.log(`ℹ️  Nincs aktív riasztás. (A legutóbbi ${items.length} feloldott riasztás megjelenítése):\n`);
  }

  items.forEach((a, idx) => {
    const sev = a.severity ? `[${a.severity.toUpperCase()}]` : '[INFO]';
    const st = a.state ? `(${a.state})` : '';
    const age = a.firstSeenAt ? formatAge(new Date(a.firstSeenAt).toISOString()) : '';
    console.log(`${idx + 1}. ${sev} ${a.ruleName || a.ruleId || 'Riasztás'}: ${a.title || a.summary || ''} ${st} ${age}`);
    if (a.summary && a.summary !== a.title) {
      console.log(`   📝 ${a.summary.substring(0, 150)}...`);
    }
  });
  console.log('');
}

function showRisk(riskData, opts) {
  if (opts.json) {
    console.log(JSON.stringify(riskData, null, 2));
    return;
  }

  const modeLabel = riskData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';

  if (riskData.detail) {
    const det = riskData.detail;
    console.log(`\n=== Crucix Ország Kockázati Profil: [${det.iso3}] ${det.name || ''} ${modeLabel} ===\n`);
    console.log(`📊 Kockázati Pontszám: ${det.score !== null ? `${det.score}/100` : 'N/A'}`);
    if (det.change24h !== undefined) console.log(`📈 24 órás változás   : ${det.change24h > 0 ? '+' : ''}${det.change24h}`);
    if (det.coverage !== undefined) console.log(`📡 Adatlefedettség    : ${(det.coverage * 100).toFixed(0)}%`);
    if (det.eventsCount !== undefined) console.log(`📌 Rögzített események: ${det.eventsCount} db`);

    if (Array.isArray(det.components) && det.components.length > 0) {
      console.log(`\nKomponens Bontás:`);
      for (const c of det.components) {
        console.log(`  • ${c.key.padEnd(20)}: ${c.value !== null ? c.value : '--'} (Súly: ${c.weight})`);
      }
    }
    console.log('');
    return;
  }

  const list = (riskData.list || []).slice(0, opts.limit);
  console.log(`\n=== Crucix Geopolitikai Országkockázati Rangsor ${modeLabel} (Top ${list.length}) ===\n`);

  list.forEach((c, idx) => {
    const change = c.change24h ? `(${c.change24h > 0 ? '+' : ''}${c.change24h})` : '';
    console.log(`${(idx + 1 + '.').padEnd(4)} [${c.iso3}] ${(c.name || '').padEnd(24)} : ${String(c.score).padStart(3)}/100  ${change}`);
  });
  console.log('');
}

function showEarthquakes(synData, opts) {
  const d = synData.data || {};
  const raw = synData.raw || loadLatestRaw() || {};
  const quakes = (d.earthquakes || raw.sources?.USGS?.earthquakes || []).slice(0, opts.limit);

  if (opts.json) {
    console.log(JSON.stringify(quakes, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  console.log(`\n=== Crucix Földrengések (USGS / EMSC) ${modeLabel} — Találatok: ${quakes.length} ===\n`);

  if (quakes.length === 0) {
    console.log(`✅ Nem rögzítettünk jelentős földrengést a legutóbbi sweepben.`);
    return;
  }

  quakes.forEach((q, idx) => {
    const mag = q.magnitude ? `[M ${Number(q.magnitude).toFixed(1)}]` : '[M --]';
    const place = q.place || q.title || 'Ismeretlen helyszín';
    const age = q.time ? formatAge(q.time) : '';
    const depth = q.depth ? `(${q.depth} km mélység)` : '';
    const tsunami = q.tsunamiFlag ? ' 🌊 [TSUNAMI VESZÉLY JELZÉS!]' : '';
    const felt = q.felt ? ` | Érezte: ${q.felt} fő` : '';
    console.log(`${idx + 1}. ${mag} ${place} ${depth} ${tsunami} ${age}${felt}`);
    if (q.url) console.log(`   🔗 ${q.url}`);
  });
  console.log('');
}

function showThermal(synData, opts) {
  const raw = synData.raw || loadLatestRaw() || {};
  const firms = raw.sources?.FIRMS || {};
  const hotspots = firms.hotspots || [];

  if (opts.json) {
    console.log(JSON.stringify(firms, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  console.log(`\n=== Crucix Termális Anomáliák & Tüzek (NASA FIRMS) ${modeLabel} ===\n`);

  if (hotspots.length === 0) {
    console.log(`ℹ️  Nincs aktív termális hotspot adat.`);
    return;
  }

  console.log(`📍 Megfigyelt Régiók Összesítése:`);
  for (const h of hotspots) {
    console.log(`  • ${h.region.padEnd(16)}: ${h.totalDetections || 0} detektálás (${h.highConfidence || 0} magas megbízhatóságú, ${h.nightDetections || 0} éjszakai)`);
  }

  // Flatten high intensity hotspots
  const allIntense = [];
  for (const h of hotspots) {
    for (const d of (h.highIntensity || [])) {
      allIntense.push({ ...d, region: h.region });
    }
  }
  allIntense.sort((a, b) => (b.frp || 0) - (a.frp || 0));

  if (allIntense.length > 0) {
    console.log(`\n🔥 Kiemelt Tűzpontok és FRP Intenzitás (Top ${Math.min(allIntense.length, opts.limit)}):`);
    for (let i = 0; i < Math.min(allIntense.length, opts.limit); i++) {
      const it = allIntense[i];
      const conf = it.confidence === 'h' ? 'Magas' : it.confidence === 'n' ? 'Közepes' : it.confidence;
      const dn = it.daynight === 'D' ? 'Nappal' : 'Éjjel';
      console.log(`  ${i + 1}. [${it.region}] Lat: ${Number(it.lat).toFixed(2)}, Lon: ${Number(it.lon).toFixed(2)} | FRP: ${formatNumber(it.frp, 1)} MW | ${conf} (${dn}) - ${it.date || ''}`);
    }
  }
  console.log('');
}

function showChokepoints(synData, opts) {
  const d = synData.data || {};
  const raw = synData.raw || loadLatestRaw() || {};
  const chokepoints = d.chokepoints || raw.sources?.Maritime?.chokepoints || {};

  if (opts.json) {
    console.log(JSON.stringify(chokepoints, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  console.log(`\n=== Crucix Tengeri Fojtópontok & Szorosok ${modeLabel} ===\n`);

  const entries = Array.isArray(chokepoints) ? chokepoints : Object.entries(chokepoints).map(([k, v]) => ({ key: k, ...v }));

  entries.slice(0, opts.limit).forEach((cp, idx) => {
    const label = cp.label || cp.name || cp.key || 'Szoros';
    const note = cp.note ? `| ${cp.note}` : '';
    const pos = (cp.lat !== undefined && cp.lon !== undefined) ? `(Lat: ${Number(cp.lat).toFixed(1)}, Lon: ${Number(cp.lon).toFixed(1)})` : '';
    console.log(`${(idx + 1 + '.').padEnd(4)} ${label.padEnd(24)} ${pos.padEnd(24)} ${note}`);
  });
  console.log('');
}

function showAir(synData, opts) {
  const d = synData.data || {};
  const raw = synData.raw || loadLatestRaw() || {};
  const opensky = raw.sources?.OpenSky || {};
  const military = raw.sources?.['ADSB-Military'] || {};

  if (opts.json) {
    console.log(JSON.stringify({ air: d.air, opensky, military }, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  console.log(`\n=== Crucix Légtér & Katonai Repülés ${modeLabel} ===\n`);

  if (d.airMeta) {
    console.log(`📡 OpenSky Forrás: ${d.airMeta.source || 'OpenSky'} (${d.airMeta.liveTotal || 0} repülő megfigyelve)`);
  }

  const milObs = military.observations || military.signals || [];
  if (milObs.length > 0) {
    console.log(`\n🎖️  Katonai Transzponderek Detektálva (${milObs.length} db):`);
    for (const m of milObs.slice(0, opts.limit)) {
      console.log(`  • ${m.title || m.summary || m.callsign || JSON.stringify(m)}`);
    }
  } else {
    console.log(`ℹ️  Nincs különleges katonai transzponder riasztás.`);
  }
  console.log('');
}

function showCyber(synData, opts) {
  const raw = synData.raw || loadLatestRaw() || {};
  const cisa = raw.sources?.['CISA-KEV'] || {};
  const threatfox = raw.sources?.ThreatFox || {};

  if (opts.json) {
    console.log(JSON.stringify({ cisa, threatfox }, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  console.log(`\n=== Crucix Kiberbiztonság & Sebezhetőségek ${modeLabel} ===\n`);

  const vulns = cisa.vulnerabilities || cisa.signals || [];
  if (vulns.length > 0) {
    console.log(`🛡️  CISA KEV Aktívan Kihasznált Sérülékenységek (${vulns.length} db):`);
    vulns.slice(0, opts.limit).forEach((v, idx) => {
      const cve = v.cveID || v.id || 'CVE';
      const prod = v.product ? `[${v.vendorProject || ''} ${v.product}]` : '';
      const name = v.vulnerabilityName || v.title || '';
      console.log(`  ${idx + 1}. ${cve} ${prod} ${name}`);
      if (v.shortDescription) console.log(`     📝 ${v.shortDescription.substring(0, 120)}...`);
    });
  } else {
    console.log(`✅ Nem rögzítettünk új kritikus CISA KEV bejegyzést.`);
  }

  const tfObs = threatfox.observations || [];
  if (tfObs.length > 0) {
    console.log(`\n🦊 ThreatFox Indikátorok (${tfObs.length} db):`);
    for (const t of tfObs.slice(0, 5)) {
      console.log(`  • ${t.title || t.summary || JSON.stringify(t)}`);
    }
  }
  console.log('');
}

function showOutages(synData, opts) {
  const raw = synData.raw || loadLatestRaw() || {};
  const ioda = raw.sources?.IODA || {};
  const radar = raw.sources?.['Cloudflare-Radar'] || {};

  if (opts.json) {
    console.log(JSON.stringify({ ioda, radar }, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  console.log(`\n=== Crucix Hálózati & Internet Kimaradások (IODA) ${modeLabel} ===\n`);

  const outages = ioda.outages || ioda.signals || [];
  if (outages.length > 0) {
    outages.slice(0, opts.limit).forEach((o, idx) => {
      console.log(`${idx + 1}. ${o.title || o.entity || o.label || JSON.stringify(o)}`);
    });
  } else {
    console.log(`✅ Nem detektáltunk kiterjedt globális internetkimaradást.`);
  }
  console.log('');
}

function showPredictions(synData, opts) {
  const raw = synData.raw || loadLatestRaw() || {};
  const pm = raw.sources?.['Prediction-Markets'] || {};
  const predFile = readJsonSafe(predictionsFile);

  if (opts.json) {
    console.log(JSON.stringify({ markets: pm.observations || [], journal: predFile?.rows || [] }, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  console.log(`\n=== Crucix Predikciós Piacok (Manifold / Polymarket) ${modeLabel} ===\n`);

  const obs = pm.observations || [];
  if (obs.length > 0) {
    obs.slice(0, opts.limit).forEach((m, idx) => {
      const prob = m.probabilityPct !== undefined ? `${m.probabilityPct}%` : '--%';
      const vol = m.volume ? `(Volumen: ${Number(m.volume).toLocaleString()})` : '';
      console.log(`${idx + 1}. "${m.title || 'Piac'}"`);
      console.log(`   📊 Valószínűség: ${prob} ${vol} | Zárás: ${m.closesAt || '--'} [${m.platform || 'Market'}]`);
      if (m.url) console.log(`   🔗 ${m.url}`);
    });
  } else {
    console.log(`ℹ️  Nincs aktív predikciós piaci megfigyelés.`);
  }
  console.log('');
}

function showHealth(synData, opts) {
  const raw = synData.raw || loadLatestRaw() || {};
  const meta = raw.crucix || {};
  const sources = raw.sources || {};

  if (opts.json) {
    console.log(JSON.stringify({ meta, sourcesCount: Object.keys(sources).length }, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  console.log(`\n=== Crucix Rendszerállapot & Forrásdiagnosztika ${modeLabel} ===\n`);

  console.log(`⏱️  Futási idő:         ${meta.totalDurationMs ? (meta.totalDurationMs / 1000).toFixed(1) + ' mp' : '--'}`);
  console.log(`📡 Források állapota:   ${meta.sourcesOk || 0} rendben / ${meta.sourcesQueried || 0} lekérdezve`);
  if (meta.sourcesFailed > 0) console.log(`❌ Sikertelen források: ${meta.sourcesFailed}`);
  if (meta.sourcesDisabled > 0) console.log(`⏸️  Letiltott források:  ${meta.sourcesDisabled}`);
  console.log(`🕒 Utolsó sweep:        ${meta.timestamp || '--'}\n`);

  if (opts.sources) {
    console.log(`Elérhető OSINT Források listája:`);
    const entries = Object.entries(sources).sort((a, b) => a[0].localeCompare(b[0]));
    entries.forEach(([name, s]) => {
      const st = s.error ? '❌ FAIL' : s.stale ? '⏳ STALE' : s.disabled ? '⏸️ DIS' : '✅ OK';
      console.log(`  ${st.padEnd(8)} ${name.padEnd(24)} ${s.error || s.message || ''}`);
    });
    console.log('');
  }
}

function showSourceData(sourceName, synData, opts) {
  const raw = synData.raw || loadLatestRaw() || {};
  const sources = raw.sources || {};

  const matchKey = Object.keys(sources).find(k => k.toLowerCase() === sourceName.toLowerCase());
  if (!matchKey || !sources[matchKey]) {
    console.error(`❌ Nem található ilyen forrás: "${sourceName}".`);
    console.log(`Tipp: Futtasd az 'npm run cli -- --sources' parancsot az elérhető források listájához.`);
    return;
  }

  const data = sources[matchKey];
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`\n=== Crucix Forrásadatok: [${matchKey}] ===\n`);
  console.log(JSON.stringify(data, null, 2));
  console.log('');
}

function showSweeps(opts) {
  const data = readJsonSafe(sweepsFile);
  const sweeps = data?.sweeps || [];

  if (opts.json) {
    console.log(JSON.stringify(sweeps, null, 2));
    return;
  }

  console.log(`\n=== Crucix Sweep Archívum (Összesen: ${sweeps.length} db) ===\n`);
  sweeps.slice(0, opts.limit).forEach((sw, idx) => {
    const time = sw.timestamp ? formatAge(sw.timestamp) : '';
    const kb = sw.bytes ? `${(sw.bytes / 1024).toFixed(0)} KB` : '';
    console.log(`${idx + 1}. [${sw.id || 'sweep'}] ${sw.ok}/${sw.total} forrás OK (${kb})  ${time}`);
  });
  console.log('');
}

function showDelta(opts) {
  const hot = readJsonSafe(hotMemoryFile);
  const lastRun = hot?.runs?.[hot.runs.length - 1];
  const delta = lastRun?.delta;

  if (opts.json) {
    console.log(JSON.stringify(delta || {}, null, 2));
    return;
  }

  console.log(`\n=== Crucix Intelligencia Delta & Változások ===\n`);
  if (!delta || !delta.summary) {
    console.log(`ℹ️  Nincs elérhető delta információ (még nem futott több egymást követő sweep).`);
    return;
  }

  const s = delta.summary;
  console.log(`🧭 Piaci Irány:      ${String(s.direction).toUpperCase()}`);
  console.log(`🔄 Összes változás:  ${s.totalChanges}`);
  console.log(`🚨 Kritikus változás: ${s.criticalChanges}`);
  if (s.signalBreakdown) {
    console.log(`📊 Szignál Bontás:   ${s.signalBreakdown.new || 0} új, ${s.signalBreakdown.escalated || 0} eszkalálódott, ${s.signalBreakdown.deescalated || 0} de-eszkalálódott`);
  }
  console.log('');
}

// === Main CLI Execution ===

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    printHelp();
    return;
  }

  // 0. Standalone sweep execution without server
  if (opts.sweep) {
    console.log('\n🚀 Egyszeri intelligencia sweep futtatása háttérszerver nélkül...');
    const rawData = await fullBriefing();
    if (opts.json) {
      console.log(JSON.stringify(rawData, null, 2));
      return;
    }
    console.log(`\n=== Crucix Sweep Sikeresen Befejeződött ===`);
    console.log(`⏱️  Futási idő:          ${(rawData.crucix.totalDurationMs / 1000).toFixed(1)} mp`);
    console.log(`📡 Források állapota:    ${rawData.crucix.sourcesOk}/${rawData.crucix.sourcesQueried} aktív`);
    if (rawData.crucix.sourcesFailed > 0) console.log(`❌ Sikertelen források:  ${rawData.crucix.sourcesFailed}`);
    if (rawData.crucix.sourcesStale > 0)  console.log(`⏳ Elavult források:    ${rawData.crucix.sourcesStale}`);
    console.log('');
    return;
  }

  // 1. Briefing mode
  if (opts.brief) {
    const synData = await getSynthesizedData(opts);
    const alertsData = await getAlertsData(opts);
    const riskData = await getCountryRiskData(opts);
    if (opts.json) {
      console.log(JSON.stringify({ synData: synData.data, alerts: alertsData, risk: riskData }, null, 2));
      return;
    }
    showBriefing(synData, alertsData, riskData, opts);
    return;
  }

  // 2. All-in-one comprehensive overview
  if (opts.all) {
    const synData = await getSynthesizedData(opts);
    const alertsData = await getAlertsData(opts);
    const riskData = await getCountryRiskData(opts);

    showBriefing(synData, alertsData, riskData, opts);
    showAlerts(alertsData, { ...opts, limit: 3 });
    showMarkets(synData, opts);
    showEnergy(synData, opts);
    showEarthquakes(synData, { ...opts, limit: 3 });
    showThermal(synData, { ...opts, limit: 3 });
    showChokepoints(synData, { ...opts, limit: 5 });
    showCyber(synData, { ...opts, limit: 3 });
    showRisk(riskData, { ...opts, limit: 5 });
    return;
  }

  // 3. Markets, Finance, Commodities, Energy, Metals
  if (opts.markets) {
    const synData = await getSynthesizedData(opts);
    showMarkets(synData, opts);
    return;
  }
  if (opts.energy) {
    const synData = await getSynthesizedData(opts);
    showEnergy(synData, opts);
    return;
  }
  if (opts.metals) {
    const synData = await getSynthesizedData(opts);
    showMetals(synData, opts);
    return;
  }
  if (opts.commodities) {
    const synData = await getSynthesizedData(opts);
    showEnergy(synData, opts);
    showMetals(synData, opts);
    return;
  }

  // 4. Alerts
  if (opts.alerts) {
    const alertsData = await getAlertsData(opts);
    showAlerts(alertsData, opts);
    return;
  }

  // 5. Geopolitical risk
  if (opts.risk) {
    const riskData = await getCountryRiskData(opts);
    showRisk(riskData, opts);
    return;
  }

  // 6. Earthquakes & Disasters
  if (opts.earthquakes) {
    const synData = await getSynthesizedData(opts);
    showEarthquakes(synData, opts);
    return;
  }
  if (opts.thermal) {
    const synData = await getSynthesizedData(opts);
    showThermal(synData, opts);
    return;
  }
  if (opts.disasters) {
    const synData = await getSynthesizedData(opts);
    showEarthquakes(synData, opts);
    showThermal(synData, opts);
    return;
  }

  // 7. Chokepoints & Air
  if (opts.chokepoints) {
    const synData = await getSynthesizedData(opts);
    showChokepoints(synData, opts);
    return;
  }
  if (opts.air) {
    const synData = await getSynthesizedData(opts);
    showAir(synData, opts);
    return;
  }

  // 8. Cyber & Outages
  if (opts.cyber) {
    const synData = await getSynthesizedData(opts);
    showCyber(synData, opts);
    return;
  }
  if (opts.outages) {
    const synData = await getSynthesizedData(opts);
    showOutages(synData, opts);
    return;
  }

  // 9. Predictions
  if (opts.predictions) {
    const synData = await getSynthesizedData(opts);
    showPredictions(synData, opts);
    return;
  }

  // 10. Health, Status, Sources
  if (opts.health || opts.sources) {
    const synData = await getSynthesizedData(opts);
    showHealth(synData, { ...opts, sources: opts.sources || opts.health });
    return;
  }

  // 11. Specific Source Data
  if (opts.sourceData) {
    const synData = await getSynthesizedData(opts);
    showSourceData(opts.sourceData, synData, opts);
    return;
  }

  // 12. Sweeps & Delta
  if (opts.sweeps) {
    showSweeps(opts);
    return;
  }
  if (opts.delta) {
    showDelta(opts);
    return;
  }

  // 13. List all countries in world feeds catalog
  if (opts.listCountries) {
    const byCountry = new Map();
    for (const f of WORLD_FEEDS) {
      if (!f.country) continue;
      byCountry.set(f.country, (byCountry.get(f.country) || 0) + 1);
    }
    const sorted = Array.from(byCountry.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    if (opts.json) {
      console.log(JSON.stringify(Object.fromEntries(sorted), null, 2));
      return;
    }
    console.log(`\n=== Crucix Világ Hírforrás Katalógus (191+ Ország, 539 Forrás) ===\n`);
    for (let i = 0; i < sorted.length; i += 6) {
      const chunk = sorted.slice(i, i + 6).map(([c, cnt]) => `${c}: ${cnt} forrás`.padEnd(16));
      console.log('  ' + chunk.join(' '));
    }
    console.log(`\nÖsszesen: ${sorted.length} ország, ${WORLD_FEEDS.length} ellenőrzött médium.`);
    console.log(`Használat: npm run cli -- --feeds <ISO kód> (pl. npm run cli -- --feeds DE)\n`);
    return;
  }

  // 14. List feeds for a country
  if (opts.listFeeds && opts.country) {
    const feeds = getFeedsByCountry(opts.country);
    if (opts.json) {
      console.log(JSON.stringify(feeds, null, 2));
      return;
    }
    console.log(`\n=== Hírforrások [${opts.country}] — Találatok: ${feeds.length} médium ===\n`);
    if (!feeds.length) {
      console.log(`Nincs regisztrált médium ehhez az országhoz.`);
    } else {
      feeds.forEach((f, idx) => {
        const lang = f.lang ? `[${f.lang.toUpperCase()}] ` : '';
        console.log(`${idx + 1}. ${lang}${f.source} (${f.url})`);
      });
    }
    console.log('');
    return;
  }

  // 15. Search feeds in world catalog
  if (opts.searchFeeds) {
    const matches = searchWorldFeeds(opts.searchFeeds);
    if (opts.json) {
      console.log(JSON.stringify(matches, null, 2));
      return;
    }
    console.log(`\n=== Forrás keresés: "${opts.searchFeeds}" — Találatok: ${matches.length} ===\n`);
    matches.slice(0, opts.limit).forEach((f, idx) => {
      console.log(`${idx + 1}. [${f.country}] ${f.source} (${f.url})`);
    });
    console.log('');
    return;
  }

  // 16. Country-specific live feed query
  if (opts.country && (!opts.category || opts.category === 'news')) {
    let items = [];
    let fromCache = false;

    if (!opts.noServer && !opts.live) {
      try {
        const apiRes = await fetchHttp(`/api/news/country/${opts.country}`);
        if (apiRes && Array.isArray(apiRes.items)) {
          items = apiRes.items;
          fromCache = Boolean(apiRes.cached);
        }
      } catch {
        // Fallback
      }
    }

    if (items.length === 0 && !opts.live) {
      loadWorldRssCache();
      const cached = getWorldNewsByCountry(opts.country);
      if (cached && cached.length) {
        items = cached.slice(0, opts.limit);
        fromCache = true;
      }
    }

    if (items.length === 0 || opts.live) {
      console.log(`\n📡 Élő hírek lekérése a(z) [${opts.country}] ország forrásaiból (közvetlen hálózati letöltés)...`);
      items = await fetchCountryLive(opts.country, opts.limit);
      fromCache = false;
    }

    if (items.length > 0) {
      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      const modeLabel = fromCache ? '30 perces gyorsítótár' : 'élő letöltés';
      const serverLabel = opts.noServer ? ' [STANDALONE / NO-SERVER]' : '';
      console.log(`\n=== Crucix Hírek [${opts.country}] (${items.length} db, ${modeLabel})${serverLabel} ===\n`);
      items.forEach((item, idx) => {
        const time = item.date ? formatAge(item.date) : '';
        const lang = item.lang ? `[${item.lang.toUpperCase()}] ` : '';
        console.log(`${idx + 1}. [${item.source}] ${lang}${item.title}  ${time}`);
        if (item.url) console.log(`   🔗 ${item.url}`);
      });
      console.log('');
      return;
    } else {
      console.log(`⚠️ Nem sikerült hírforrást találni ehhez a kódhoz: ${opts.country}. Ellenőrzöm az archívumot...`);
    }
  }

  // 17. Live ticker mode
  if (opts.live) {
    let liveData = null;
    if (!opts.noServer) {
      try {
        liveData = await fetchHttp('/api/data');
      } catch {
        liveData = loadLiveFromDisk();
      }
    } else {
      liveData = loadLiveFromDisk();
    }

    let items = (liveData?.newsFeed || liveData?.news || []);
    if (!items.length) {
      loadWorldRssCache();
      const cached = getWorldNews(opts.limit);
      if (cached && cached.length) {
        items = cached.map(c => ({
          source: c.source,
          headline: c.title,
          timestamp: c.date,
          url: c.url,
          country: c.country,
        }));
      }
    }

    if (!items.length) {
      console.error('❌ Nincs elérhető aktuális hír. (Futott már le sweep vagy RSS gyűjtés?)');
      process.exit(1);
    }

    items = items.slice(0, opts.limit);
    if (opts.json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }

    const serverLabel = opts.noServer ? ' [STANDALONE / NO-SERVER]' : '';
    console.log(`\n=== Crucix Élő Hírek (${items.length} db)${serverLabel} ===\n`);
    items.forEach((item, idx) => {
      const src = item.source || 'Ismeretlen';
      const time = item.timestamp ? formatAge(item.timestamp) : '';
      const headline = item.headline || item.title || '';
      const c = item.country ? `[${item.country}] ` : '';
      const url = item.url ? ` (${item.url})` : '';
      console.log(`${idx + 1}. ${c}[${src}] ${headline}  ${time}${url}`);
    });
    console.log('');
    return;
  }

  // 18. Fetch history records (HTTP if running and permitted, disk if offline/no-server)
  let records = [];
  let isFromApi = false;

  if (!opts.noServer) {
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
  } else {
    records = loadFromDisk();
  }

  // Categories from disk
  if (opts.listCategories && !isFromApi) {
    const byKind = {};
    for (const r of records) {
      byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    }
    if (opts.json) {
      console.log(JSON.stringify(byKind, null, 2));
      return;
    }
    const modeDesc = opts.noServer ? 'Standalone lemez archívum' : 'Offline Archívum';
    console.log(`\n=== Crucix Elérhető Eseménykategóriák (${modeDesc}) ===\n`);
    const entries = Object.entries(byKind).sort((a, b) => b[1] - a[1]);
    entries.forEach(([kind, count]) => {
      console.log(`  • ${kind.padEnd(16)} : ${count} esemény`);
    });
    console.log(`\nÖsszesen: ${records.length} rögzített esemény.\n`);
    return;
  }

  // Filter records from disk
  if (!isFromApi) {
    if (opts.category) {
      records = records.filter(r => r.kind === opts.category);
    }
    if (opts.source) {
      const srcLow = opts.source.toLowerCase();
      records = records.filter(r => (r.source || '').toLowerCase().includes(srcLow));
    }
    if (opts.search) {
      const qLow = opts.search.toLowerCase();
      records = records.filter(r =>
        (r.title || '').toLowerCase().includes(qLow) ||
        (r.summary || '').toLowerCase().includes(qLow)
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
  const serverLabel = opts.noServer ? ' [STANDALONE / NO-SERVER]' : (isFromApi ? ' [API]' : ' [OFFLINE]');
  console.log(`\n=== Crucix Események (${titlePrefix}${filterDesc})${serverLabel} — Találatok: ${records.length} ===\n`);

  if (records.length === 0) {
    console.log(`Nincs találat a megadott feltételekre.`);
    console.log(`Tipp: Próbáld a kategóriák listázását: npm run cli -- --categories\n`);
    return;
  }

  records.forEach((rec, idx) => {
    const kind = `[${rec.kind}]`.padEnd(12);
    const country = rec.country ? ` 📍 ${rec.country}` : '';
    const age = rec.observedAt || rec.firstSeen ? ` (${formatAge(rec.observedAt || rec.firstSeen)})` : '';
    const src = rec.source ? `[${rec.source}] ` : '';
    console.log(`${idx + 1}. ${kind} ${src}${rec.title}${country}${age}`);
    if (rec.url) {
      console.log(`   🔗 ${rec.url}`);
    }
    console.log('');
  });
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref && import.meta.url === entryHref) {
  main();
}

export {
  parseArgs,
  formatAge,
  formatNumber,
  formatPct,
  loadFromDisk,
  loadLiveFromDisk,
  loadLatestRaw,
  getSynthesizedData,
  getAlertsData,
  getCountryRiskData,
  fetchCountryLive,
  main,
};
