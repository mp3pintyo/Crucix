#!/usr/bin/env node
// Crucix Intelligence CLI — query intelligence, markets, alerts, events, and news
// Works with or without the web server running (direct disk fallback).
// Supports 191+ countries world news feeds catalog (539 verified outlets)
// and all 71 OSINT adapters, markets, energy, metals, thermal, earthquakes, chokepoints, cyber.
// Usage: crucix [options] (or: node scripts/cli.mjs [options] / npm run cli -- [options])

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import config from '../crucix.config.mjs';
import { WORLD_FEEDS, getFeedsByCountry, searchWorldFeeds } from '../apis/utils/news-feeds.mjs';
import { parseFeed } from '../apis/utils/rss.mjs';
import { loadWorldRssCache, getWorldNewsByCountry, getWorldNews } from '../lib/world-rss-runner.mjs';
import { fullBriefing } from '../apis/briefing.mjs';
import { synthesize } from '../dashboard/inject.mjs';
import { countryByIso3 } from '../lib/intelligence/countries.mjs';
import { saveSnapshot } from '../lib/snapshots.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const port = config.port || 3117;
const host = config.host === '0.0.0.0' ? '127.0.0.1' : (config.host || '127.0.0.1');
export function resolveRunsDir(configuredDir = config.runsDir) {
  if (configuredDir) return resolve(configuredDir);
  if (process.env.RUNS_DIR) return resolve(process.env.RUNS_DIR);
  if (process.env.CRUCIX_HOME) return join(process.env.CRUCIX_HOME, 'runs');
  const projectRuns = join(ROOT, 'runs');
  if (existsSync(projectRuns)) return projectRuns;
  const userRuns = join(homedir(), '.crucix', 'runs');
  if (existsSync(userRuns)) return userRuns;
  return existsSync(join(ROOT, 'package.json')) ? projectRuns : userRuns;
}
const runsDir = resolveRunsDir();
const historyFile = join(runsDir, 'intelligence', 'history.json');
const latestFile = join(runsDir, 'latest.json');
const alertsFile = join(runsDir, 'alerts', 'alerts.json');
const countriesFile = join(runsDir, 'intelligence', 'countries.json');
const predictionsFile = join(runsDir, 'intelligence', 'predictions.json');
const thermalFile = join(runsDir, 'intelligence', 'thermal.json');
const sweepsFile = join(runsDir, 'sweeps', 'index.json');
const hotMemoryFile = join(runsDir, 'memory', 'hot.json');

function parseDurationMs(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(m|min|h|hour|hours|d|day|days|w|week|weeks|y|year|years)?$/);
  if (match) {
    const val = parseFloat(match[1]);
    const unit = match[2] || 'd';
    if (unit === 'm' || unit === 'min') return val * 60 * 1000;
    if (unit === 'h' || unit === 'hour' || unit === 'hours') return val * 3600 * 1000;
    if (unit === 'd' || unit === 'day' || unit === 'days') return val * 86400 * 1000;
    if (unit === 'w' || unit === 'week' || unit === 'weeks') return val * 7 * 86400 * 1000;
    if (unit === 'y' || unit === 'year' || unit === 'years') return val * 365 * 86400 * 1000;
  }
  return null;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = argv;
  const opts = {
    category: null,
    search: null,
    source: null,
    country: null,
    limit: 10,
    since: null,
    sinceMs: null,
    from: null,
    to: null,
    listCategories: false,
    listCountries: false,
    listFeeds: false,
    searchFeeds: null,
    live: false,
    json: false,
    help: false,
    noServer: false,
    sweep: false,
    serve: false,
    collector: false,
    interval: 15,
    history: false,
    lang: null,

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
    } else if (arg === '-L' || arg === '--lang') {
      opts.lang = (args[++i] || 'en').toLowerCase().slice(0, 2);
    } else if (arg.startsWith('--lang=')) {
      opts.lang = arg.slice(7).toLowerCase().slice(0, 2);
    } else if (arg === '-H' || arg === '--history') {
      opts.history = true;
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
    } else if (arg === '--since' || arg === '--window') {
      const val = args[++i];
      opts.since = val;
      const ms = parseDurationMs(val);
      if (ms) {
        opts.sinceMs = ms;
        opts.from = new Date(Date.now() - ms).toISOString().slice(0, 10);
      }
    } else if (arg === '--days' || arg === '-d') {
      const num = parseInt(args[++i], 10);
      if (!isNaN(num) && num > 0) {
        opts.since = `${num}d`;
        opts.sinceMs = num * 86400 * 1000;
        opts.from = new Date(Date.now() - opts.sinceMs).toISOString().slice(0, 10);
      }
    } else if (arg === '--from') {
      opts.from = args[++i];
    } else if (arg === '--to') {
      opts.to = args[++i];
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
    } else if (arg === '--serve' || arg === '--server' || arg === '--start-server') {
      opts.serve = true;
    } else if (arg === '--collector' || arg === '--daemon' || arg === '--watch') {
      opts.collector = true;
    } else if (arg === '-i' || arg === '--interval') {
      const num = parseInt(args[++i], 10);
      if (!isNaN(num) && num > 0) opts.interval = num;
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

function getCliLanguage(opts = {}) {
  const candidate = opts.lang || process.env.CRUCIX_LANG || process.env.LANGUAGE || process.env.LANG || 'en';
  const code = String(candidate).trim().toLowerCase().slice(0, 2);
  return ['hu', 'fr'].includes(code) ? code : 'en';
}

function isExecutable() {
  if (process.env.CRUCIX_EXECUTABLE === '1' || process.env.CRUCIX_IS_EXE === '1') return true;
  if (process.execPath && /crucix(?:\.exe)?$/i.test(process.execPath)) return true;
  const argv1 = process.argv[1] || '';
  if (/crucix(?:\.exe)?$/i.test(argv1)) return true;
  return false;
}

function getCliCmd() {
  if (isExecutable()) return 'crucix';
  if (process.env.npm_lifecycle_event === 'cli') return 'npm run cli --';
  if (process.argv[1] && process.argv[1].endsWith('cli.mjs')) return 'node scripts/cli.mjs';
  return 'crucix';
}

function printHelpHungarian() {
  const isExe = isExecutable();
  const c = getCliCmd();
  const usage = isExe
    ? `  crucix [opciók]`
    : `  crucix [opciók]\n  node scripts/cli.mjs [opciók]\n  npm run cli -- [opciók]`;
  console.log(`
Crucix Intelligence CLI — Parancssori Hír-, Esemény- és Hírszerzési Lekérdező
==========================================================================
Használat:
${usage}

Nyelvválasztás:
  -L, --lang <kód>                 Kimenet nyelve: en, hu, fr (alapértelmezett: en vagy CRUCIX_LANG)

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

Hírek és Eseményarchívum (History):
  -H, --history                    Rögzített eseménytörténet listázása (Search/Filter kompatibilis)
  -c, --category <kategória>       Szűrés eseménykategória szerint (pl. news, cyber, outage, conflict, earthquake...)
  --country <ISO kód>              Ország szerinti hírek (pl. HU, DE, FR, JP, US, UA, IL, BR...)
  -q, --search <kifejezés>         Szöveges kulcsszavas keresés az események történetében
  --source <forrás>                Szűrés hírforrás szerint (pl. BBC, Telex, USGS, CISA)
  -l, --limit <szám>               Megjelenített elemek száma (alapértelmezett: 10)
  --categories, --kinds            Minden elérhető eseménykategória és darabszámuk listázása
  --live                           Aktuális sweep élő hírszalagjának (news ticker) mutatása
  --json                           Nyers JSON kimenet (más scriptekhez vagy AI csővezetékhez)

Időtartam és Dátumszűrés:
  --since <időtartam>, --window    Időablak szűrés (pl. 14d, 2w, 7d, 48h, 24h)
  -d, --days <napok>               Szűrés az elmúlt N nap eseményeire (pl. -d 14 vagy --days 7)
  --from <YYYY-MM-DD>              Kezdő dátum szerinti szűrés (pl. 2026-09-26)
  --to <YYYY-MM-DD>                Záró dátum szerinti szűrés (pl. 2026-10-10)

Szerver nélküli (Standalone / Offline) futtatás & Adatgyűjtő mód:
  --no-server, --standalone, -S    Közvetlen lemezes / offline futás (nem csatlakozik a web szerverhez).
                                   Kizárólag a helyi lemezen lévő archívumból és gyorsítótárból dolgozik.
  --offline, --direct              A --no-server szinonimái
  --sweep, --run-sweep             Egyszeri elemzési sweep futtatása a terminálban háttérszerver nélkül.
  --collector, --daemon, --watch   Folyamatos adatgyűjtő ciklus indítása a terminálban (háttérszerver nélkül)
  --serve, --start-server          Crucix háttérszerver indítása fejetlen (Headless / Adatgyűjtő) módban (web UI nélkül)
  -i, --interval <perc>            Adatgyűjtési ciklus gyakorisága percekben (--collector esetén, alapértelmezett: 15)

Világ Hírforrás Katalógus (191+ ország, 539 médium):
  --countries                      Összes támogatott ország és médiumaik számának listázása
  --feeds [ISO kód]                Egy adott országban elérhető médiumok listája (pl. --feeds DE)
  --search-feeds <név>             Médium keresése a világkatalógusban (pl. --search-feeds "Spiegel")

Példák:
  ${c} -b                          # Vezetői intelligencia összefoglaló (Briefing)
  ${c} -m                          # Piacok, VIX, arany, olaj, kripto áttekintése
  ${c} --earthquakes               # Legfrissebb földrengések (USGS)
  ${c} --thermal                   # NASA FIRMS műholdas hőtérkép
  ${c} --risk                      # Geopolitikai országkockázatok rangsora
  ${c} --risk UA                   # Ukrajna részletes kockázati profilja
  ${c} --cyber                     # Kiberbiztonsági sebezhetőségek (CISA KEV)
  ${c} --alerts                    # Riasztások és fenyegetettségi szint
  ${c} -c earthquake --since 14d   # Az elmúlt 2 hét földrengései
  ${c} -c market --since 7d        # Az elmúlt hét piaci mozgásai
  ${c} --alerts --since 14d        # Az elmúlt 2 hét riasztásai
  ${c} -q "Trump" --since 14d      # Szöveges keresés az elmúlt 2 hét híreiben
  ${c} --country JP --no-server    # Japán hírek a helyi RSS gyorsítótárból
  ${c} --collector                 # Folyamatos terminálos adatgyűjtő ciklus (15 percenként sweep)
  ${c} --serve                     # Crucix backend szerver indítása böngésző felnyitás NÉLKÜL
  ${c} --source-data USGS          # USGS forrás nyers adatainak megjelenítése
  ${c} -a                          # Átfogó terminál jelentés minden kulcsterületről
  ${c} -b -L hu                    # Összefoglaló magyar nyelven
`);
}

function printHelpEnglish() {
  const isExe = isExecutable();
  const c = getCliCmd();
  const usage = isExe
    ? `  crucix [options]`
    : `  crucix [options]\n  node scripts/cli.mjs [options]\n  npm run cli -- [options]`;

  console.log(`
Crucix Intelligence CLI — Command-Line Intelligence, Markets & News Query Terminal
==================================================================================
Usage:
${usage}

Language:
  -L, --lang <code>                Output language: en, hu, fr (default: en or CRUCIX_LANG)

Intelligence & Briefings:
  -b, --brief                      Executive intelligence briefing (market direction, VIX, oil, gold, OSINT)
  -a, --all                        Comprehensive report across all key intelligence areas in terminal
  -A, --alerts                     List active and recent alerts (--all-alerts for resolved as well)
  --status, --health               System health and status of all 71 OSINT data sources (OK, Stale, Failed)
  --sources                        List all available OSINT data sources and their health
  --source-data <source>           Show raw/parsed data for a specific source (e.g. USGS, YFinance, FIRMS)
  --delta                          Recent sweep changes (new signals, escalations)
  --sweeps                         Recorded sweep history and statistics

Markets, Energy & Commodities:
  -m, --markets, --finance         Stock indexes (S&P 500, Nasdaq, Dow), bond yields, VIX, Crypto (BTC)
  --energy                         WTI & Brent crude oil, Natural Gas, EIA inventory
  --metals                         Precious metals: Gold & Silver prices and daily moves
  --commodities                    Combined commodities table (Energy & Metals)

Geopolitics & Country Risk:
  --risk [ISO3]                    Geopolitical country risk ranking (top risk countries)
  --country-risk <ISO3>            Detailed risk profile for a specific country (e.g. UA, PAN, USA, IL)
  --predictions                    Prediction markets (Manifold, Polymarket) and conflict forecasts

Physical Security, Airspace & Maritime:
  --earthquakes, --quakes          Earthquakes (USGS/EMSC: magnitude, location, tsunami flag)
  --thermal, --fires               NASA FIRMS satellite thermal map and fire hotspots
  --chokepoints, --maritime        Global maritime chokepoints and straits status (Hormuz, Suez, Malacca)
  --air, --aviation                Air activity, OpenSky flights, military transponders
  --disasters                      Combined natural disaster monitoring (quakes, storms, fires)

Cybersecurity & Network:
  --cyber                          CISA KEV actively exploited vulnerabilities & ThreatFox indicators
  --outages                        Global internet outages and network anomalies (IODA)

News & Event Archive (History):
  -H, --history                    List recorded event history (search/filter compatible)
  -c, --category <category>        Filter by category (e.g. news, cyber, outage, conflict, earthquake...)
  --country <ISO code>             News by country (e.g. HU, DE, FR, JP, US, UA, IL, BR...)
  -q, --search <term>              Text search across event history
  --source <source>                Filter by news source (e.g. BBC, Reuters, USGS, CISA)
  -l, --limit <count>              Number of items to display (default: 10)
  --categories, --kinds            List all available event categories and their counts
  --live                           Show live news ticker from current sweep
  --json                           Raw JSON output (for scripts or AI pipelines)

Time Window & Date Filtering:
  --since <duration>, --window     Time window filtering (e.g. 14d, 2w, 7d, 48h, 24h)
  -d, --days <days>                Filter events to the last N days (e.g. -d 14 or --days 7)
  --from <YYYY-MM-DD>              Start date filter (e.g. 2026-09-26)
  --to <YYYY-MM-DD>                End date filter (e.g. 2026-10-10)

Serverless (Standalone / Offline) & Collector Modes:
  --no-server, --standalone, -S    Direct disk / offline execution without web server.
                                   Operates solely from local disk archives and cache.
  --offline, --direct              Synonyms for --no-server
  --sweep, --run-sweep             Run a single collection sweep in the terminal without backend server
  --collector, --daemon, --watch   Start continuous terminal collector loop (no server)
  --serve, --start-server          Start Crucix backend server in headless mode (no browser popup)
  -i, --interval <minutes>         Data collection interval in minutes (for --collector, default: 15)

World News Catalog (191+ Countries, 539 Outlets):
  --countries                      List all supported countries and outlet counts
  --feeds [ISO code]               List registered news feeds for a country (e.g. --feeds DE)
  --search-feeds <name>            Search outlets in the world catalog (e.g. --search-feeds "Spiegel")

Examples:
  ${c} -b                          # Executive intelligence briefing
  ${c} -m                          # Financial markets, VIX, gold, oil, crypto
  ${c} --earthquakes               # Latest earthquakes (USGS/EMSC)
  ${c} --thermal                   # NASA FIRMS satellite fire hotspots
  ${c} --risk                      # Geopolitical country risk rankings
  ${c} --risk UA                   # Ukraine detailed risk profile
  ${c} --cyber                     # Cyber vulnerabilities (CISA KEV)
  ${c} --alerts                    # Active alerts and threat level
  ${c} -c earthquake --since 14d   # Earthquakes from the last 2 weeks
  ${c} -c market --since 7d        # Market moves from the last 7 days
  ${c} --alerts --since 14d        # Alerts from the last 2 weeks
  ${c} -q "Trump" --since 14d      # Search news from the last 2 weeks
  ${c} --country JP --no-server    # Japan news from local cache
  ${c} --collector                 # Continuous terminal collector loop (15m sweep)
  ${c} --serve                     # Start backend server without browser popup
  ${c} --source-data USGS          # Raw data from USGS source
  ${c} -a                          # Comprehensive report across all areas
  ${c} -b -L hu                    # Briefing in Hungarian
`);
}

function printHelp(lang = 'en') {
  if (lang === 'hu') {
    printHelpHungarian();
  } else {
    printHelpEnglish();
  }
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

function formatAge(dateString, lang = 'en') {
  if (!dateString) return '';
  const now = Date.now();
  const then = new Date(dateString).getTime();
  if (isNaN(then)) return '';
  const diffSec = Math.floor((now - then) / 1000);
  if (lang === 'hu') {
    if (diffSec < 60) return `${diffSec} mp ezelőtt`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} perce`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours} órája`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} napja`;
  }
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

function checkDataAvailable(synData, opts = {}) {
  const lang = opts.lang || 'en';
  const c = getCliCmd();
  const serverCmd = isExecutable() ? 'crucix --serve' : 'npm run dev';
  if (!synData.data && !synData.raw) {
    if (lang === 'hu') {
      console.log(`\n❌ Nincs elérhető intelligencia adat a lemezen (${latestFile}) és a szerver sem fut.`);
      console.log(`\n👉 Megoldás:`);
      console.log(`   1. Egyszeri adatgyűjtés futtatása a terminálban: ${c} --sweep`);
      console.log(`   2. Vagy indítsd el a folyamatos háttérszervert:   ${serverCmd}\n`);
    } else {
      console.log(`\n❌ No intelligence data available on disk (${latestFile}) and server is not running.`);
      console.log(`\n👉 Solution:`);
      console.log(`   1. Run a one-time sweep in the terminal: ${c} --sweep`);
      console.log(`   2. Or start the background server:       ${serverCmd}\n`);
    }
    return false;
  }
  return true;
}

function showBriefing(synData, alertsData, riskData, opts = {}) {
  const lang = opts.lang || 'en';
  if (!checkDataAvailable(synData, opts)) return;
  const d = synData.data || {};
  const raw = synData.raw || loadLatestRaw() || {};
  const hot = readJsonSafe(hotMemoryFile);
  const delta = hot?.runs?.[hot.runs.length - 1]?.delta;

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  const header = lang === 'hu' ? 'CRUCIX VEZETŐI INTELLIGENCIA ÖSSZEFOGLALÓ' : 'CRUCIX INTELLIGENCE BRIEFING';
  console.log(`\n=============================================================`);
  console.log(`             ${header} ${modeLabel}`);
  console.log(`=============================================================`);

  const meta = d.meta || raw.crucix || {};
  const sweepTime = meta.timestamp ? new Date(meta.timestamp).toISOString().replace('T', ' ').substring(0, 19) + ' UTC' : (lang === 'hu' ? 'Ismeretlen' : 'Unknown');
  const timeLabel = lang === 'hu' ? 'Időpont' : 'Time';
  const sourcesLabel = lang === 'hu' ? 'Források' : 'Sources';
  console.log(`🕒 ${timeLabel}: ${sweepTime} | ${sourcesLabel}: ${meta.sourcesOk || '--'}/${meta.sourcesQueried || '--'} OK`);

  // Direction & Threat
  if (delta?.summary) {
    const dirEmoji = { 'risk-off': '📉', 'risk-on': '📈', 'mixed': '↔️' }[delta.summary.direction] || '↔️';
    if (lang === 'hu') {
      console.log(`🧭 Piaci Trend & Delta : ${dirEmoji} ${String(delta.summary.direction).toUpperCase()} (${delta.summary.totalChanges || 0} változás, ${delta.summary.criticalChanges || 0} kritikus)`);
    } else {
      console.log(`🧭 Market Trend & Delta : ${dirEmoji} ${String(delta.summary.direction).toUpperCase()} (${delta.summary.totalChanges || 0} changes, ${delta.summary.criticalChanges || 0} critical)`);
    }
  }

  const activeAlerts = (alertsData?.alerts || []).filter(a => a.state === 'active');
  const alertCount = activeAlerts.length;
  if (lang === 'hu') {
    console.log(`🛡️  Aktív Riasztások     : ${alertCount > 0 ? `🚨 ${alertCount} db aktív riasztás!` : '✅ 0 aktív (Nyugodt állapot)'}`);
  } else {
    console.log(`🛡️  Active Alerts        : ${alertCount > 0 ? `🚨 ${alertCount} active alert(s)!` : '✅ 0 active (Normal / Calm state)'}`);
  }

  // Markets summary
  const energy = d.energy || {};
  const metals = d.metals || {};
  const yfQuotes = raw.sources?.YFinance?.quotes || {};
  const vix = yfQuotes['^VIX']?.price || d.markets?.vix?.value;
  const sp500 = yfQuotes['^GSPC']?.price;
  const btc = yfQuotes['BTC-USD']?.price;

  if (lang === 'hu') {
    console.log(`\n📊 Kulcs Indikátorok:`);
    console.log(`   • VIX: ${vix ? formatNumber(vix) : '--'} | S&P 500: ${sp500 ? formatNumber(sp500) : '--'} | BTC: $${btc ? formatNumber(btc, 0) : '--'}`);
    console.log(`   • WTI Olaj: $${energy.wti ? formatNumber(energy.wti) : '--'} | Brent: $${energy.brent ? formatNumber(energy.brent) : '--'} | Földgáz: $${energy.natgas ? formatNumber(energy.natgas) : '--'}`);
    console.log(`   • Arany (Gold): $${metals.gold ? formatNumber(metals.gold) : '--'} | Ezüst (Silver): $${metals.silver ? formatNumber(metals.silver) : '--'}`);
  } else {
    console.log(`\n📊 Key Indicators:`);
    console.log(`   • VIX: ${vix ? formatNumber(vix) : '--'} | S&P 500: ${sp500 ? formatNumber(sp500) : '--'} | BTC: $${btc ? formatNumber(btc, 0) : '--'}`);
    console.log(`   • WTI Crude: $${energy.wti ? formatNumber(energy.wti) : '--'} | Brent: $${energy.brent ? formatNumber(energy.brent) : '--'} | NatGas: $${energy.natgas ? formatNumber(energy.natgas) : '--'}`);
    console.log(`   • Gold: $${metals.gold ? formatNumber(metals.gold) : '--'} | Silver: $${metals.silver ? formatNumber(metals.silver) : '--'}`);
  }

  // Earthquakes & Fires highlights
  const quakes = d.earthquakes || raw.sources?.USGS?.earthquakes || [];
  if (quakes.length > 0) {
    const topQ = quakes[0];
    const tsu = topQ.tsunamiFlag ? (lang === 'hu' ? ' 🌊 [TSUNAMI VESZÉLY!]' : ' 🌊 [TSUNAMI WARNING!]') : '';
    const qTitle = lang === 'hu' ? 'Kiemelt Szeizmikus Esemény' : 'Featured Seismic Event';
    console.log(`\n🌍 ${qTitle}:`);
    console.log(`   • [M ${topQ.magnitude}] ${topQ.place}${tsu} (${formatAge(topQ.time, lang)})`);
  }

  const firms = raw.sources?.FIRMS;
  if (firms?.hotspots?.length > 0) {
    const totalDetections = firms.hotspots.reduce((acc, h) => acc + (h.totalDetections || 0), 0);
    if (lang === 'hu') {
      console.log(`\n🔥 Műholdas Hőtérkép (NASA FIRMS):`);
      console.log(`   • ${totalDetections} termális detektálás regisztrálva (${firms.hotspots.map(h => `${h.region}: ${h.totalDetections}`).join(', ')})`);
    } else {
      console.log(`\n🔥 Satellite Thermal Map (NASA FIRMS):`);
      console.log(`   • ${totalDetections} thermal detections registered (${firms.hotspots.map(h => `${h.region}: ${h.totalDetections}`).join(', ')})`);
    }
  }

  // OSINT & Telegram
  const tg = d.tg || raw.sources?.Telegram || {};
  const urgent = tg.urgent || [];
  if (urgent.length > 0) {
    const tgTitle = lang === 'hu' ? 'Sürgős OSINT Jelek (Telegram)' : 'Urgent OSINT Signals (Telegram)';
    console.log(`\n📡 ${tgTitle}:`);
    for (const post of urgent.slice(0, 3)) {
      const text = (post.text || '').replace(/\s+/g, ' ').substring(0, 110);
      console.log(`   • ${text}...`);
    }
  }

  // Top ideas
  const ideas = (d.ideas || []).slice(0, 3);
  if (ideas.length > 0) {
    const ideasTitle = lang === 'hu' ? 'Elemzői Stratégiai Ötletek' : 'Analyst Strategic Ideas';
    console.log(`\n💡 ${ideasTitle}:`);
    for (const idea of ideas) {
      const typeIcon = idea.type === 'long' ? '📈' : idea.type === 'hedge' ? '🛡️' : '👁️';
      console.log(`   ${typeIcon} [${idea.type?.toUpperCase()}] ${idea.title}`);
    }
  }

  console.log(`=============================================================\n`);
}

function showMarkets(synData, opts = {}) {
  const lang = opts.lang || 'en';
  if (!checkDataAvailable(synData, opts)) return;
  const d = synData.data || {};
  const raw = synData.raw || loadLatestRaw() || {};
  const yf = raw.sources?.YFinance || {};
  const markets = d.markets || {};

  if (opts.json) {
    console.log(JSON.stringify({ markets, yfinance: yf }, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  const title = lang === 'hu' ? 'Crucix Piacok & Pénzügyi Indikátorok' : 'Crucix Markets & Financial Indicators';
  console.log(`\n=== ${title} ${modeLabel} ===\n`);

  const indexes = yf.indexes || markets.indexes || [];
  if (indexes.length > 0) {
    console.log(lang === 'hu' ? `📈 Részvényindexek:` : `📈 Stock Indexes:`);
    for (const idx of indexes) {
      console.log(`  • ${idx.name.padEnd(20)} : ${formatNumber(idx.price).padStart(10)}  (${formatPct(idx.changePct)})`);
    }
    console.log('');
  }

  const commodities = yf.commodities || markets.commodities || [];
  if (commodities.length > 0) {
    console.log(lang === 'hu' ? `⚡ Árupiac & Nyersanyagok:` : `⚡ Commodities & Raw Materials:`);
    for (const c of commodities) {
      console.log(`  • ${c.name.padEnd(20)} : $${formatNumber(c.price).padStart(10)} (${formatPct(c.changePct)})`);
    }
    console.log('');
  }

  const crypto = yf.crypto || markets.crypto || [];
  if (crypto.length > 0) {
    console.log(lang === 'hu' ? `🪙 Kriptovaluták:` : `🪙 Cryptocurrencies:`);
    for (const cr of crypto) {
      console.log(`  • ${cr.name.padEnd(20)} : $${formatNumber(cr.price).padStart(10)} (${formatPct(cr.changePct)})`);
    }
    console.log('');
  }

  const rates = yf.rates || markets.rates || [];
  if (rates.length > 0) {
    console.log(lang === 'hu' ? `📊 Kötvényhozamok & Kamatok:` : `📊 Bond Yields & Rates:`);
    for (const r of rates) {
      console.log(`  • ${r.name.padEnd(20)} : ${formatNumber(r.price)}%`);
    }
    console.log('');
  }
}

function showEnergy(synData, opts = {}) {
  const lang = opts.lang || 'en';
  if (!checkDataAvailable(synData, opts)) return;
  const d = synData.data || {};
  const raw = synData.raw || loadLatestRaw() || {};
  const energy = d.energy || {};
  const yf = raw.sources?.YFinance?.quotes || {};

  if (opts.json) {
    console.log(JSON.stringify(energy, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  const title = lang === 'hu' ? 'Crucix Energia & Árupiac' : 'Crucix Energy & Commodities';
  console.log(`\n=== ${title} ${modeLabel} ===\n`);

  console.log(lang === 'hu' ? `⚡ Kőolaj & Földgáz Árak:` : `⚡ Crude Oil & Natural Gas Prices:`);
  const wtiPct = yf['CL=F']?.changePct;
  const brentPct = yf['BZ=F']?.changePct;
  const natgasPct = yf['NG=F']?.changePct;

  if (lang === 'hu') {
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
  } else {
    console.log(`  • WTI Crude Oil   : $${formatNumber(energy.wti)} / barrel  ${wtiPct !== undefined ? `(${formatPct(wtiPct)})` : ''}`);
    console.log(`  • Brent Crude Oil : $${formatNumber(energy.brent)} / barrel ${brentPct !== undefined ? `(${formatPct(brentPct)})` : ''}`);
    console.log(`  • Natural Gas     : $${formatNumber(energy.natgas)} / MMBtu   ${natgasPct !== undefined ? `(${formatPct(natgasPct)})` : ''}`);
    if (energy.crudeStocks) {
      console.log(`\n📦 Crude Oil Stocks (EIA):`);
      console.log(`  • Inventory level : ${energy.crudeStocks} million barrels`);
    }
    if (Array.isArray(energy.signals) && energy.signals.length > 0) {
      console.log(`\n📡 Energy Signals:`);
      for (const s of energy.signals.slice(0, 5)) {
        console.log(`  • ${s.title || s.label || JSON.stringify(s)}`);
      }
    }
  }
  console.log('');
}

function showMetals(synData, opts = {}) {
  const lang = opts.lang || 'en';
  if (!checkDataAvailable(synData, opts)) return;
  const d = synData.data || {};
  const metals = d.metals || {};

  if (opts.json) {
    console.log(JSON.stringify(metals, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  const title = lang === 'hu' ? 'Crucix Nemesfémek' : 'Crucix Precious Metals';
  console.log(`\n=== ${title} ${modeLabel} ===\n`);

  if (lang === 'hu') {
    console.log(`🥇 Arany & Ezüst Árak:`);
    console.log(`  • Arany (Gold)  : $${formatNumber(metals.gold)} / oz   (${formatPct(metals.goldChangePct)})`);
    console.log(`  • Ezüst (Silver): $${formatNumber(metals.silver)} / oz   (${formatPct(metals.silverChangePct)})`);
  } else {
    console.log(`🥇 Gold & Silver Prices:`);
    console.log(`  • Gold   : $${formatNumber(metals.gold)} / oz   (${formatPct(metals.goldChangePct)})`);
    console.log(`  • Silver : $${formatNumber(metals.silver)} / oz   (${formatPct(metals.silverChangePct)})`);
  }
  console.log('');
}

function showAlerts(alertsData, opts = {}) {
  const lang = opts.lang || 'en';
  let allList = alertsData?.alerts || [];
  if (opts.sinceMs) {
    const cutoff = Date.now() - opts.sinceMs;
    allList = allList.filter(a => {
      const t = a.lastSeenAt || a.firstSeenAt || (a.resolvedAt ? a.resolvedAt : null);
      return t && t >= cutoff;
    });
  } else if (opts.from) {
    const fromMs = Date.parse(opts.from);
    allList = allList.filter(a => {
      const t = a.lastSeenAt || a.firstSeenAt || (a.resolvedAt ? a.resolvedAt : null);
      return t && t >= fromMs;
    });
  }
  if (opts.to) {
    const toMs = Date.parse(opts.to) + 86400 * 1000;
    allList = allList.filter(a => {
      const t = a.lastSeenAt || a.firstSeenAt || (a.resolvedAt ? a.resolvedAt : null);
      return t && t <= toMs;
    });
  }

  const activeList = allList.filter(a => a.state === 'active');
  const items = (opts.allAlerts ? allList : (activeList.length > 0 ? activeList : allList)).slice(0, opts.limit);

  if (opts.json) {
    console.log(JSON.stringify({ active: activeList, all: allList }, null, 2));
    return;
  }

  const modeLabel = alertsData?.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  const timeDesc = opts.since ? (lang === 'hu' ? ` [Elmúlt ${opts.since}]` : ` [Past ${opts.since}]`) : (opts.from ? ` [${opts.from}${opts.to ? ' - ' + opts.to : ''}]` : '');
  const title = lang === 'hu' ? 'Crucix Riasztások' : 'Crucix Alerts';
  const counts = lang === 'hu' ? `(Aktív: ${activeList.length} db, Összes: ${allList.length} db)` : `(Active: ${activeList.length}, Total: ${allList.length})`;
  console.log(`\n=== ${title} ${modeLabel}${timeDesc} ${counts} ===\n`);

  if (items.length === 0) {
    console.log(lang === 'hu' ? `✅ Nincs aktív riasztás.` : `✅ No active alerts.`);
    return;
  }

  if (activeList.length === 0 && !opts.allAlerts) {
    console.log(lang === 'hu' ? `ℹ️  Nincs aktív riasztás. (A legutóbbi ${items.length} feloldott riasztás megjelenítése):\n` : `ℹ️  No active alerts. (Showing latest ${items.length} resolved alerts):\n`);
  }

  items.forEach((a, idx) => {
    const sev = a.severity ? `[${a.severity.toUpperCase()}]` : '[INFO]';
    const st = a.state ? `(${a.state})` : '';
    const age = a.firstSeenAt ? formatAge(new Date(a.firstSeenAt).toISOString(), lang) : '';
    const defaultRule = lang === 'hu' ? 'Riasztás' : 'Alert';
    console.log(`${idx + 1}. ${sev} ${a.ruleName || a.ruleId || defaultRule}: ${a.title || a.summary || ''} ${st} ${age}`);
    if (a.summary && a.summary !== a.title) {
      console.log(`   📝 ${a.summary.substring(0, 150)}...`);
    }
  });
  console.log('');
}

function showRisk(riskData, opts = {}) {
  const lang = opts.lang || 'en';
  if (opts.json) {
    console.log(JSON.stringify(riskData, null, 2));
    return;
  }

  const modeLabel = riskData?.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';

  if (riskData?.detail) {
    const det = riskData.detail;
    const title = lang === 'hu' ? `Crucix Ország Kockázati Profil: [${det.iso3}] ${det.name || ''}` : `Crucix Country Risk Profile: [${det.iso3}] ${det.name || ''}`;
    console.log(`\n=== ${title} ${modeLabel} ===\n`);
    const scoreLabel = lang === 'hu' ? 'Kockázati Pontszám' : 'Risk Score        ';
    const scoreVal = det.score !== null ? `${det.score}/100` : 'N/A';
    console.log(`📊 ${scoreLabel}: ${scoreVal}`);
    if (det.change24h !== undefined) {
      const changeLabel = lang === 'hu' ? '24 órás változás   ' : '24h change         ';
      console.log(`📈 ${changeLabel}: ${det.change24h > 0 ? '+' : ''}${det.change24h}`);
    }
    if (det.coverage !== undefined) {
      const covLabel = lang === 'hu' ? 'Adatlefedettség    ' : 'Data coverage      ';
      console.log(`📡 ${covLabel}: ${(det.coverage * 100).toFixed(0)}%`);
    }
    if (det.eventsCount !== undefined) {
      const evLabel = lang === 'hu' ? `📌 Rögzített események: ${det.eventsCount} db` : `📌 Recorded events    : ${det.eventsCount}`;
      console.log(evLabel);
    }

    if (Array.isArray(det.components) && det.components.length > 0) {
      console.log(lang === 'hu' ? `\nKomponens Bontás:` : `\nComponent Breakdown:`);
      for (const c of det.components) {
        const weightLabel = lang === 'hu' ? 'Súly' : 'Weight';
        console.log(`  • ${c.key.padEnd(20)}: ${c.value !== null ? c.value : '--'} (${weightLabel}: ${c.weight})`);
      }
    }
    console.log('');
    return;
  }

  const list = (riskData?.list || []).slice(0, opts.limit);
  const rankingTitle = lang === 'hu' ? `Crucix Geopolitikai Országkockázati Rangsor` : `Crucix Geopolitical Country Risk Ranking`;
  console.log(`\n=== ${rankingTitle} ${modeLabel} (Top ${list.length}) ===\n`);

  list.forEach((c, idx) => {
    const change = c.change24h ? `(${c.change24h > 0 ? '+' : ''}${c.change24h})` : '';
    console.log(`${(idx + 1 + '.').padEnd(4)} [${c.iso3}] ${(c.name || '').padEnd(24)} : ${String(c.score).padStart(3)}/100  ${change}`);
  });
  console.log('');
}

function showEarthquakes(synData, opts = {}) {
  const lang = opts.lang || 'en';
  if (!checkDataAvailable(synData, opts)) return;
  const d = synData.data || {};
  const raw = synData.raw || loadLatestRaw() || {};
  const quakes = (d.earthquakes || raw.sources?.USGS?.earthquakes || []).slice(0, opts.limit);

  if (opts.json) {
    console.log(JSON.stringify(quakes, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  const title = lang === 'hu' ? 'Crucix Földrengések (USGS / EMSC)' : 'Crucix Earthquakes (USGS / EMSC)';
  const countLabel = lang === 'hu' ? `Találatok: ${quakes.length}` : `Results: ${quakes.length}`;
  console.log(`\n=== ${title} ${modeLabel} — ${countLabel} ===\n`);

  if (quakes.length === 0) {
    console.log(lang === 'hu' ? `✅ Nem rögzítettünk jelentős földrengést a legutóbbi sweepben.` : `✅ No significant earthquakes recorded in the latest sweep.`);
    return;
  }

  quakes.forEach((q, idx) => {
    const mag = q.magnitude ? `[M ${Number(q.magnitude).toFixed(1)}]` : '[M --]';
    const place = q.place || q.title || (lang === 'hu' ? 'Ismeretlen helyszín' : 'Unknown location');
    const age = q.time ? formatAge(q.time, lang) : '';
    const depth = q.depth ? (lang === 'hu' ? `(${q.depth} km mélység)` : `(${q.depth} km depth)`) : '';
    const tsunami = q.tsunamiFlag ? (lang === 'hu' ? ' 🌊 [TSUNAMI VESZÉLY JELZÉS!]' : ' 🌊 [TSUNAMI WARNING!]') : '';
    const felt = q.felt ? (lang === 'hu' ? ` | Érezte: ${q.felt} fő` : ` | Felt: ${q.felt}`) : '';
    console.log(`${idx + 1}. ${mag} ${place} ${depth} ${tsunami} ${age}${felt}`);
    if (q.url) console.log(`   🔗 ${q.url}`);
  });
  console.log('');
}

function showThermal(synData, opts = {}) {
  const lang = opts.lang || 'en';
  if (!checkDataAvailable(synData, opts)) return;
  const raw = synData.raw || loadLatestRaw() || {};
  const firms = raw.sources?.FIRMS || {};
  const hotspots = firms.hotspots || [];

  if (opts.json) {
    console.log(JSON.stringify(firms, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  const title = lang === 'hu' ? 'Crucix Termális Anomáliák & Tüzek (NASA FIRMS)' : 'Crucix Thermal Anomalies & Fires (NASA FIRMS)';
  console.log(`\n=== ${title} ${modeLabel} ===\n`);

  if (hotspots.length === 0) {
    console.log(lang === 'hu' ? `ℹ️  Nincs aktív termális hotspot adat.` : `ℹ️  No active thermal hotspot data.`);
    return;
  }

  console.log(lang === 'hu' ? `📍 Megfigyelt Régiók Összesítése:` : `📍 Observed Regions Summary:`);
  for (const h of hotspots) {
    if (lang === 'hu') {
      console.log(`  • ${h.region.padEnd(16)}: ${h.totalDetections || 0} detektálás (${h.highConfidence || 0} magas megbízhatóságú, ${h.nightDetections || 0} éjszakai)`);
    } else {
      console.log(`  • ${h.region.padEnd(16)}: ${h.totalDetections || 0} detections (${h.highConfidence || 0} high confidence, ${h.nightDetections || 0} night)`);
    }
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
    const topCount = Math.min(allIntense.length, opts.limit);
    const hotTitle = lang === 'hu' ? `🔥 Kiemelt Tűzpontok és FRP Intenzitás (Top ${topCount}):` : `🔥 Featured Fire Hotspots & FRP Intensity (Top ${topCount}):`;
    console.log(`\n${hotTitle}`);
    for (let i = 0; i < topCount; i++) {
      const it = allIntense[i];
      let conf = it.confidence;
      if (lang === 'hu') {
        conf = it.confidence === 'h' ? 'Magas' : it.confidence === 'n' ? 'Közepes' : it.confidence;
      } else {
        conf = it.confidence === 'h' ? 'High' : it.confidence === 'n' ? 'Medium' : it.confidence;
      }
      let dn = it.daynight;
      if (lang === 'hu') {
        dn = it.daynight === 'D' ? 'Nappal' : 'Éjjel';
      } else {
        dn = it.daynight === 'D' ? 'Day' : 'Night';
      }
      console.log(`  ${i + 1}. [${it.region}] Lat: ${Number(it.lat).toFixed(2)}, Lon: ${Number(it.lon).toFixed(2)} | FRP: ${formatNumber(it.frp, 1)} MW | ${conf} (${dn}) - ${it.date || ''}`);
    }
  }
  console.log('');
}

function showChokepoints(synData, opts = {}) {
  const lang = opts.lang || 'en';
  if (!checkDataAvailable(synData, opts)) return;
  const d = synData.data || {};
  const raw = synData.raw || loadLatestRaw() || {};
  const chokepoints = d.chokepoints || raw.sources?.Maritime?.chokepoints || {};

  if (opts.json) {
    console.log(JSON.stringify(chokepoints, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  const title = lang === 'hu' ? 'Crucix Tengeri Fojtópontok & Szorosok' : 'Crucix Maritime Chokepoints & Straits';
  console.log(`\n=== ${title} ${modeLabel} ===\n`);

  const entries = Array.isArray(chokepoints) ? chokepoints : Object.entries(chokepoints).map(([k, v]) => ({ key: k, ...v }));

  entries.slice(0, opts.limit).forEach((cp, idx) => {
    const label = cp.label || cp.name || cp.key || (lang === 'hu' ? 'Szoros' : 'Strait');
    const note = cp.note ? `| ${cp.note}` : '';
    const pos = (cp.lat !== undefined && cp.lon !== undefined) ? `(Lat: ${Number(cp.lat).toFixed(1)}, Lon: ${Number(cp.lon).toFixed(1)})` : '';
    console.log(`${(idx + 1 + '.').padEnd(4)} ${label.padEnd(24)} ${pos.padEnd(24)} ${note}`);
  });
  console.log('');
}

function showAir(synData, opts = {}) {
  const lang = opts.lang || 'en';
  if (!checkDataAvailable(synData, opts)) return;
  const d = synData.data || {};
  const raw = synData.raw || loadLatestRaw() || {};
  const opensky = raw.sources?.OpenSky || {};
  const military = raw.sources?.['ADSB-Military'] || {};

  if (opts.json) {
    console.log(JSON.stringify({ air: d.air, opensky, military }, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  const title = lang === 'hu' ? 'Crucix Légtér & Katonai Repülés' : 'Crucix Airspace & Military Aviation';
  console.log(`\n=== ${title} ${modeLabel} ===\n`);

  if (d.airMeta) {
    const obsWord = lang === 'hu' ? 'repülő megfigyelve' : 'flights observed';
    console.log(`📡 OpenSky: ${d.airMeta.source || 'OpenSky'} (${d.airMeta.liveTotal || 0} ${obsWord})`);
  }

  const milObs = military.observations || military.signals || [];
  if (milObs.length > 0) {
    const milTitle = lang === 'hu' ? `🎖️  Katonai Transzponderek Detektálva (${milObs.length} db):` : `🎖️  Military Transponders Detected (${milObs.length}):`;
    console.log(`\n${milTitle}`);
    for (const m of milObs.slice(0, opts.limit)) {
      console.log(`  • ${m.title || m.summary || m.callsign || JSON.stringify(m)}`);
    }
  } else {
    console.log(lang === 'hu' ? `ℹ️  Nincs különleges katonai transzponder riasztás.` : `ℹ️  No unusual military transponder alerts.`);
  }
  console.log('');
}

function showCyber(synData, opts = {}) {
  const lang = opts.lang || 'en';
  if (!checkDataAvailable(synData, opts)) return;
  const raw = synData.raw || loadLatestRaw() || {};
  const cisa = raw.sources?.['CISA-KEV'] || {};
  const threatfox = raw.sources?.ThreatFox || {};

  if (opts.json) {
    console.log(JSON.stringify({ cisa, threatfox }, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  const title = lang === 'hu' ? 'Crucix Kiberbiztonság & Sebezhetőségek' : 'Crucix Cybersecurity & Vulnerabilities';
  console.log(`\n=== ${title} ${modeLabel} ===\n`);

  const vulns = cisa.vulnerabilities || cisa.signals || [];
  if (vulns.length > 0) {
    const cisaTitle = lang === 'hu' ? `🛡️  CISA KEV Aktívan Kihasznált Sérülékenységek (${vulns.length} db):` : `🛡️  CISA KEV Actively Exploited Vulnerabilities (${vulns.length}):`;
    console.log(cisaTitle);
    vulns.slice(0, opts.limit).forEach((v, idx) => {
      const cve = v.cveID || v.id || 'CVE';
      const prod = v.product ? `[${v.vendorProject || ''} ${v.product}]` : '';
      const name = v.vulnerabilityName || v.title || '';
      console.log(`  ${idx + 1}. ${cve} ${prod} ${name}`);
      if (v.shortDescription) console.log(`     📝 ${v.shortDescription.substring(0, 120)}...`);
    });
  } else {
    console.log(lang === 'hu' ? `✅ Nem rögzítettünk új kritikus CISA KEV bejegyzést.` : `✅ No new critical CISA KEV entries recorded.`);
  }

  const tfObs = threatfox.observations || [];
  if (tfObs.length > 0) {
    const tfTitle = lang === 'hu' ? `🦊 ThreatFox Indikátorok (${tfObs.length} db):` : `🦊 ThreatFox Indicators (${tfObs.length}):`;
    console.log(`\n${tfTitle}`);
    for (const t of tfObs.slice(0, 5)) {
      console.log(`  • ${t.title || t.summary || JSON.stringify(t)}`);
    }
  }
  console.log('');
}

function showOutages(synData, opts = {}) {
  const lang = opts.lang || 'en';
  if (!checkDataAvailable(synData, opts)) return;
  const raw = synData.raw || loadLatestRaw() || {};
  const ioda = raw.sources?.IODA || {};
  const radar = raw.sources?.['Cloudflare-Radar'] || {};

  if (opts.json) {
    console.log(JSON.stringify({ ioda, radar }, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  const title = lang === 'hu' ? 'Crucix Hálózati & Internet Kimaradások (IODA)' : 'Crucix Network & Internet Outages (IODA)';
  console.log(`\n=== ${title} ${modeLabel} ===\n`);

  const outages = ioda.outages || ioda.signals || [];
  if (outages.length > 0) {
    outages.slice(0, opts.limit).forEach((o, idx) => {
      console.log(`${idx + 1}. ${o.title || o.entity || o.label || JSON.stringify(o)}`);
    });
  } else {
    console.log(lang === 'hu' ? `✅ Nem detektáltunk kiterjedt globális internetkimaradást.` : `✅ No widespread global internet outages detected.`);
  }
  console.log('');
}

function showPredictions(synData, opts = {}) {
  const lang = opts.lang || 'en';
  if (!checkDataAvailable(synData, opts)) return;
  const raw = synData.raw || loadLatestRaw() || {};
  const pm = raw.sources?.['Prediction-Markets'] || {};
  const predFile = readJsonSafe(predictionsFile);

  if (opts.json) {
    console.log(JSON.stringify({ markets: pm.observations || [], journal: predFile?.rows || [] }, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  const title = lang === 'hu' ? 'Crucix Predikciós Piacok (Manifold / Polymarket)' : 'Crucix Prediction Markets (Manifold / Polymarket)';
  console.log(`\n=== ${title} ${modeLabel} ===\n`);

  const obs = pm.observations || [];
  if (obs.length > 0) {
    obs.slice(0, opts.limit).forEach((m, idx) => {
      const prob = m.probabilityPct !== undefined ? `${m.probabilityPct}%` : '--%';
      const volWord = lang === 'hu' ? 'Volumen' : 'Volume';
      const vol = m.volume ? `(${volWord}: ${Number(m.volume).toLocaleString()})` : '';
      const probWord = lang === 'hu' ? 'Valószínűség' : 'Probability';
      const closesWord = lang === 'hu' ? 'Zárás' : 'Closes';
      console.log(`${idx + 1}. "${m.title || 'Market'}"`);
      console.log(`   📊 ${probWord}: ${prob} ${vol} | ${closesWord}: ${m.closesAt || '--'} [${m.platform || 'Market'}]`);
      if (m.url) console.log(`   🔗 ${m.url}`);
    });
  } else {
    console.log(lang === 'hu' ? `ℹ️  Nincs aktív predikciós piaci megfigyelés.` : `ℹ️  No active prediction market observations.`);
  }
  console.log('');
}

function showHealth(synData, opts = {}) {
  const lang = opts.lang || 'en';
  if (!checkDataAvailable(synData, opts)) return;
  const raw = synData.raw || loadLatestRaw() || {};
  const meta = raw.crucix || {};
  const sources = raw.sources || {};

  if (opts.json) {
    console.log(JSON.stringify({ meta, sourcesCount: Object.keys(sources).length }, null, 2));
    return;
  }

  const modeLabel = synData.isFromApi ? '[API]' : '[STANDALONE / NO-SERVER]';
  const title = lang === 'hu' ? 'Crucix Rendszerállapot & Forrásdiagnosztika' : 'Crucix System Health & Source Diagnostics';
  console.log(`\n=== ${title} ${modeLabel} ===\n`);

  if (lang === 'hu') {
    console.log(`⏱️  Futási idő:         ${meta.totalDurationMs ? (meta.totalDurationMs / 1000).toFixed(1) + ' mp' : '--'}`);
    console.log(`📡 Források állapota:   ${meta.sourcesOk || 0} rendben / ${meta.sourcesQueried || 0} lekérdezve`);
    if (meta.sourcesFailed > 0) console.log(`❌ Sikertelen források: ${meta.sourcesFailed}`);
    if (meta.sourcesDisabled > 0) console.log(`⏸️  Letiltott források:  ${meta.sourcesDisabled}`);
    console.log(`🕒 Utolsó sweep:        ${meta.timestamp || '--'}\n`);
  } else {
    console.log(`⏱️  Runtime:           ${meta.totalDurationMs ? (meta.totalDurationMs / 1000).toFixed(1) + ' s' : '--'}`);
    console.log(`📡 Sources status:     ${meta.sourcesOk || 0} OK / ${meta.sourcesQueried || 0} queried`);
    if (meta.sourcesFailed > 0) console.log(`❌ Failed sources:     ${meta.sourcesFailed}`);
    if (meta.sourcesDisabled > 0) console.log(`⏸️  Disabled sources:   ${meta.sourcesDisabled}`);
    console.log(`🕒 Last sweep:         ${meta.timestamp || '--'}\n`);
  }

  if (opts.sources) {
    console.log(lang === 'hu' ? `Elérhető OSINT Források listája:` : `Available OSINT Sources List:`);
    const entries = Object.entries(sources).sort((a, b) => a[0].localeCompare(b[0]));
    entries.forEach(([name, s]) => {
      const st = s.error ? '❌ FAIL' : s.stale ? '⏳ STALE' : s.disabled ? '⏸️ DIS' : '✅ OK';
      console.log(`  ${st.padEnd(8)} ${name.padEnd(24)} ${s.error || s.message || ''}`);
    });
    console.log('');
  }
}

function showSourceData(sourceName, synData, opts = {}) {
  const lang = opts.lang || 'en';
  const raw = synData.raw || loadLatestRaw() || {};
  const sources = raw.sources || {};

  const matchKey = Object.keys(sources).find(k => k.toLowerCase() === sourceName.toLowerCase());
  if (!matchKey || !sources[matchKey]) {
    const c = getCliCmd();
    if (lang === 'hu') {
      console.error(`❌ Nem található ilyen forrás: "${sourceName}".`);
      console.log(`Tipp: Futtasd a '${c} --sources' parancsot az elérhető források listájához.`);
    } else {
      console.error(`❌ Source not found: "${sourceName}".`);
      console.log(`Tip: Run '${c} --sources' to list available sources.`);
    }
    return;
  }

  const data = sources[matchKey];
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const title = lang === 'hu' ? `Crucix Forrásadatok: [${matchKey}]` : `Crucix Source Data: [${matchKey}]`;
  console.log(`\n=== ${title} ===\n`);
  console.log(JSON.stringify(data, null, 2));
  console.log('');
}

function showSweeps(opts = {}) {
  const lang = opts.lang || 'en';
  const data = readJsonSafe(sweepsFile);
  const sweeps = data?.sweeps || [];

  if (opts.json) {
    console.log(JSON.stringify(sweeps, null, 2));
    return;
  }

  const title = lang === 'hu' ? `Crucix Sweep Archívum (Összesen: ${sweeps.length} db)` : `Crucix Sweeps Archive (Total: ${sweeps.length})`;
  console.log(`\n=== ${title} ===\n`);
  sweeps.slice(0, opts.limit).forEach((sw, idx) => {
    const time = sw.timestamp ? formatAge(sw.timestamp, lang) : '';
    const kb = sw.bytes ? `${(sw.bytes / 1024).toFixed(0)} KB` : '';
    const okWord = lang === 'hu' ? 'forrás OK' : 'sources OK';
    console.log(`${idx + 1}. [${sw.id || 'sweep'}] ${sw.ok}/${sw.total} ${okWord} (${kb})  ${time}`);
  });
  console.log('');
}

function showDelta(opts = {}) {
  const lang = opts.lang || 'en';
  const hot = readJsonSafe(hotMemoryFile);
  const lastRun = hot?.runs?.[hot.runs.length - 1];
  const delta = lastRun?.delta;

  if (opts.json) {
    console.log(JSON.stringify(delta || {}, null, 2));
    return;
  }

  const title = lang === 'hu' ? 'Crucix Intelligencia Delta & Változások' : 'Crucix Intelligence Delta & Changes';
  console.log(`\n=== ${title} ===\n`);
  if (!delta || !delta.summary) {
    console.log(lang === 'hu' ? `ℹ️  Nincs elérhető delta információ (még nem futott több egymást követő sweep).` : `ℹ️  No delta information available yet (requires consecutive sweeps).`);
    return;
  }

  const s = delta.summary;
  if (lang === 'hu') {
    console.log(`🧭 Piaci Irány:      ${String(s.direction).toUpperCase()}`);
    console.log(`🔄 Összes változás:  ${s.totalChanges}`);
    console.log(`🚨 Kritikus változás: ${s.criticalChanges}`);
    if (s.signalBreakdown) {
      console.log(`📊 Szignál Bontás:   ${s.signalBreakdown.new || 0} új, ${s.signalBreakdown.escalated || 0} eszkalálódott, ${s.signalBreakdown.deescalated || 0} de-eszkalálódott`);
    }
  } else {
    console.log(`🧭 Market Direction:  ${String(s.direction).toUpperCase()}`);
    console.log(`🔄 Total Changes:     ${s.totalChanges}`);
    console.log(`🚨 Critical Changes:  ${s.criticalChanges}`);
    if (s.signalBreakdown) {
      console.log(`📊 Signal Breakdown:  ${s.signalBreakdown.new || 0} new, ${s.signalBreakdown.escalated || 0} escalated, ${s.signalBreakdown.deescalated || 0} de-escalated`);
    }
  }
  console.log('');
}

// === Main CLI Execution ===

async function main() {
  const opts = parseArgs();
  const lang = getCliLanguage(opts);
  opts.lang = lang;

  if (opts.help) {
    printHelp(lang);
    return;
  }

  // 0a. Start server in headless / data collector mode (no browser popup)
  if (opts.serve) {
    if (lang === 'hu') {
      console.log('\n🚀 Crucix háttérszerver indítása Fejetlen (Headless / Adatgyűjtő) módban...');
      console.log('🌐 Express REST API elindul (3117-es porton), kiszolgálja a CLI-t és a helyi hálózatot.');
      console.log('🛑 A böngésző automatikus megnyitása letiltva (nincs felugró web UI).');
      console.log('🛑 Leállításhoz: Nyomj Ctrl+C billentyűt\n');
    } else {
      console.log('\n🚀 Starting Crucix backend server in Headless (Collector) mode...');
      console.log('🌐 Express REST API starting on port 3117, serving CLI and local network.');
      console.log('🛑 Automatic browser launch disabled (no web UI popup).');
      console.log('🛑 To stop: Press Ctrl+C\n');
    }
    process.env.NO_AUTO_OPEN = '1';
    process.env.HEADLESS = '1';
    await import(pathToFileURL(join(ROOT, 'server.mjs')).href);
    return;
  }

  // 0b. Continuous data collector loop without any web server
  if (opts.collector) {
    const intervalMinutes = opts.interval || 15;
    if (lang === 'hu') {
      console.log('\n🔄 Crucix Folyamatos Adatgyűjtő Ciklus (Headless Collector)');
      console.log(`⏱️  Gyakoriság:    Minden ${intervalMinutes} percben`);
      console.log(`💾 Célkönyvtár:   ${runsDir}`);
      console.log('🛑 Leállításhoz:  Nyomj Ctrl+C billentyűt\n');
    } else {
      console.log('\n🔄 Crucix Continuous Collector Loop (Headless Collector)');
      console.log(`⏱️  Interval:       Every ${intervalMinutes} minutes`);
      console.log(`💾 Destination:    ${runsDir}`);
      console.log('🛑 To stop:        Press Ctrl+C\n');
    }

    const runCollection = async () => {
      const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
      console.log(lang === 'hu' ? `[${nowStr}] 🚀 Ütemezett sweep futtatása...` : `[${nowStr}] 🚀 Running scheduled sweep...`);
      try {
        const rawData = await fullBriefing();
        if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
        saveSnapshot(runsDir, rawData);
        if (lang === 'hu') {
          console.log(`[${nowStr}] ✅ Adatgyűjtés kész: ${(rawData.crucix.totalDurationMs / 1000).toFixed(1)} mp | Források: ${rawData.crucix.sourcesOk}/${rawData.crucix.sourcesQueried} OK | Mentve: ${latestFile}\n`);
        } else {
          console.log(`[${nowStr}] ✅ Data collection complete: ${(rawData.crucix.totalDurationMs / 1000).toFixed(1)} s | Sources: ${rawData.crucix.sourcesOk}/${rawData.crucix.sourcesQueried} OK | Saved: ${latestFile}\n`);
        }
      } catch (err) {
        console.error(lang === 'hu' ? `[${nowStr}] ❌ Hiba a sweep során: ${err.message}\n` : `[${nowStr}] ❌ Error during sweep: ${err.message}\n`);
      }
    };

    await runCollection();
    setInterval(runCollection, intervalMinutes * 60 * 1000);
    return;
  }

  // 0c. Standalone sweep execution without server
  if (opts.sweep) {
    console.log(lang === 'hu' ? '\n🚀 Egyszeri intelligencia sweep futtatása háttérszerver nélkül...' : '\n🚀 Running one-time intelligence sweep without server...');
    const rawData = await fullBriefing();
    try {
      if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
      saveSnapshot(runsDir, rawData);
    } catch (e) {
      console.error(lang === 'hu' ? `⚠️ Nem sikerült elmenteni a pillanatképet (${latestFile}): ${e.message}` : `⚠️ Failed to save snapshot (${latestFile}): ${e.message}`);
    }

    if (opts.json) {
      console.log(JSON.stringify(rawData, null, 2));
      return;
    }
    const c = getCliCmd();
    if (lang === 'hu') {
      console.log(`\n=== Crucix Sweep Sikeresen Befejeződött ===`);
      console.log(`⏱️  Futási idő:          ${(rawData.crucix.totalDurationMs / 1000).toFixed(1)} mp`);
      console.log(`📡 Források állapota:    ${rawData.crucix.sourcesOk}/${rawData.crucix.sourcesQueried} aktív`);
      if (rawData.crucix.sourcesFailed > 0) console.log(`❌ Sikertelen források:  ${rawData.crucix.sourcesFailed}`);
      if (rawData.crucix.sourcesStale > 0)  console.log(`⏳ Elavult források:    ${rawData.crucix.sourcesStale}`);
      console.log(`💾 Mentve:               ${latestFile}`);
      console.log(`💡 Most már lekérdezheted: ${c} -b  (vagy -m, --risk, -a)\n`);
    } else {
      console.log(`\n=== Crucix Sweep Completed Successfully ===`);
      console.log(`⏱️  Runtime:             ${(rawData.crucix.totalDurationMs / 1000).toFixed(1)} s`);
      console.log(`📡 Sources status:       ${rawData.crucix.sourcesOk}/${rawData.crucix.sourcesQueried} active`);
      if (rawData.crucix.sourcesFailed > 0) console.log(`❌ Failed sources:       ${rawData.crucix.sourcesFailed}`);
      if (rawData.crucix.sourcesStale > 0)  console.log(`⏳ Stale sources:        ${rawData.crucix.sourcesStale}`);
      console.log(`💾 Saved to:             ${latestFile}`);
      console.log(`💡 You can now query:    ${c} -b  (or -m, --risk, -a)\n`);
    }
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
    if (opts.since || opts.from) {
      opts.category = 'earthquake';
    } else {
      const synData = await getSynthesizedData(opts);
      showEarthquakes(synData, opts);
      return;
    }
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
    const catTitle = lang === 'hu' ? 'Crucix Világ Hírforrás Katalógus (191+ Ország, 539 Forrás)' : 'Crucix World News Catalog (191+ Countries, 539 Outlets)';
    console.log(`\n=== ${catTitle} ===\n`);
    for (let i = 0; i < sorted.length; i += 6) {
      const chunk = sorted.slice(i, i + 6).map(([c, cnt]) => `${c}: ${cnt} ${lang === 'hu' ? 'forrás' : 'outlets'}`.padEnd(16));
      console.log('  ' + chunk.join(' '));
    }
    const c = getCliCmd();
    if (lang === 'hu') {
      console.log(`\nÖsszesen: ${sorted.length} ország, ${WORLD_FEEDS.length} ellenőrzött médium.`);
      console.log(`Használat: ${c} --feeds <ISO kód> (pl. ${c} --feeds DE)\n`);
    } else {
      console.log(`\nTotal: ${sorted.length} countries, ${WORLD_FEEDS.length} verified media outlets.`);
      console.log(`Usage: ${c} --feeds <ISO code> (e.g. ${c} --feeds DE)\n`);
    }
    return;
  }

  // 14. List feeds for a country
  if (opts.listFeeds && opts.country) {
    const feeds = getFeedsByCountry(opts.country);
    if (opts.json) {
      console.log(JSON.stringify(feeds, null, 2));
      return;
    }
    const fTitle = lang === 'hu' ? `Hírforrások [${opts.country}] — Találatok: ${feeds.length} médium` : `News Feeds [${opts.country}] — Results: ${feeds.length} outlets`;
    console.log(`\n=== ${fTitle} ===\n`);
    if (!feeds.length) {
      console.log(lang === 'hu' ? `Nincs regisztrált médium ehhez az országhoz.` : `No registered news feeds for this country.`);
    } else {
      feeds.forEach((f, idx) => {
        const fLang = f.lang ? `[${f.lang.toUpperCase()}] ` : '';
        console.log(`${idx + 1}. ${fLang}${f.source} (${f.url})`);
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
    const sTitle = lang === 'hu' ? `Forrás keresés: "${opts.searchFeeds}" — Találatok: ${matches.length}` : `Feed Search: "${opts.searchFeeds}" — Results: ${matches.length}`;
    console.log(`\n=== ${sTitle} ===\n`);
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
      if (lang === 'hu') {
        console.log(`\n📡 Élő hírek lekérése a(z) [${opts.country}] ország forrásaiból (közvetlen hálózati letöltés)...`);
      } else {
        console.log(`\n📡 Fetching live news for [${opts.country}] sources (direct network fetch)...`);
      }
      items = await fetchCountryLive(opts.country, opts.limit);
      fromCache = false;
    }

    if (items.length > 0) {
      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      const modeLabel = fromCache ? (lang === 'hu' ? '30 perces gyorsítótár' : '30-minute cache') : (lang === 'hu' ? 'élő letöltés' : 'live fetch');
      const serverLabel = opts.noServer ? ' [STANDALONE / NO-SERVER]' : '';
      const nTitle = lang === 'hu' ? `Crucix Hírek [${opts.country}] (${items.length} db, ${modeLabel})` : `Crucix News [${opts.country}] (${items.length} items, ${modeLabel})`;
      console.log(`\n=== ${nTitle}${serverLabel} ===\n`);
      items.forEach((item, idx) => {
        const time = item.date ? formatAge(item.date, lang) : '';
        const iLang = item.lang ? `[${item.lang.toUpperCase()}] ` : '';
        console.log(`${idx + 1}. [${item.source}] ${iLang}${item.title}  ${time}`);
        if (item.url) console.log(`   🔗 ${item.url}`);
      });
      console.log('');
      return;
    } else {
      if (lang === 'hu') {
        console.log(`⚠️ Nem sikerült hírforrást találni ehhez a kódhoz: ${opts.country}. Ellenőrzöm az archívumot...`);
      } else {
        console.log(`⚠️ Could not find news for code: ${opts.country}. Checking archive...`);
      }
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
      console.error(lang === 'hu' ? '❌ Nincs elérhető aktuális hír. (Futott már le sweep vagy RSS gyűjtés?)' : '❌ No current news available (has a sweep or RSS collection run?)');
      process.exit(1);
    }

    items = items.slice(0, opts.limit);
    if (opts.json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }

    const serverLabel = opts.noServer ? ' [STANDALONE / NO-SERVER]' : '';
    const lTitle = lang === 'hu' ? `Crucix Élő Hírek (${items.length} db)` : `Crucix Live News (${items.length} items)`;
    console.log(`\n=== ${lTitle}${serverLabel} ===\n`);
    items.forEach((item, idx) => {
      const src = item.source || (lang === 'hu' ? 'Ismeretlen' : 'Unknown');
      const time = item.timestamp ? formatAge(item.timestamp, lang) : '';
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
      if (opts.from) params.set('from', opts.from);
      if (opts.to) params.set('to', opts.to);
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
          const cTitle = lang === 'hu' ? 'Crucix Elérhető Eseménykategóriák' : 'Crucix Available Event Categories';
          console.log(`\n=== ${cTitle} ===\n`);
          const entries = Object.entries(apiRes.stats.byKind).sort((a, b) => b[1] - a[1]);
          entries.forEach(([kind, count]) => {
            console.log(`  • ${kind.padEnd(16)} : ${count} ${lang === 'hu' ? 'esemény' : 'events'}`);
          });
          if (lang === 'hu') {
            console.log(`\nÖsszesen: ${apiRes.stats.totalRecords} rögzített esemény.\n`);
          } else {
            console.log(`\nTotal: ${apiRes.stats.totalRecords} recorded events.\n`);
          }
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
    const modeDesc = opts.noServer ? (lang === 'hu' ? 'Standalone lemez archívum' : 'Standalone disk archive') : (lang === 'hu' ? 'Offline Archívum' : 'Offline archive');
    const cTitle = lang === 'hu' ? `Crucix Elérhető Eseménykategóriák (${modeDesc})` : `Crucix Available Event Categories (${modeDesc})`;
    console.log(`\n=== ${cTitle} ===\n`);
    const entries = Object.entries(byKind).sort((a, b) => b[1] - a[1]);
    entries.forEach(([kind, count]) => {
      console.log(`  • ${kind.padEnd(16)} : ${count} ${lang === 'hu' ? 'esemény' : 'events'}`);
    });
    if (lang === 'hu') {
      console.log(`\nÖsszesen: ${records.length} rögzített esemény.\n`);
    } else {
      console.log(`\nTotal: ${records.length} recorded events.\n`);
    }
    return;
  }

  // Filter records from disk
  if (!isFromApi) {
    if (opts.category) {
      records = records.filter(r => r.kind === opts.category);
    }
    if (opts.source) {
      const srcLow = opts.source.toLowerCase();
      records = records.filter(r => {
        const s = typeof r.source === 'string' ? r.source : (r.source?.name || r.source?.hostname || '');
        return s.toLowerCase().includes(srcLow);
      });
    }
    if (opts.search) {
      const qLow = opts.search.toLowerCase();
      records = records.filter(r =>
        (r.title || '').toLowerCase().includes(qLow) ||
        (r.summary || '').toLowerCase().includes(qLow)
      );
    }
    if (opts.sinceMs) {
      const cutoff = Date.now() - opts.sinceMs;
      records = records.filter(r => {
        const timeVal = r.lastSeenAt || r.publishedAt || r.firstSeenAt || r.collectedAt;
        const t = Date.parse(timeVal);
        return !isNaN(t) && t >= cutoff;
      });
    } else if (opts.from) {
      const fromMs = Date.parse(opts.from);
      records = records.filter(r => {
        const timeVal = r.lastSeenAt || r.publishedAt || r.firstSeenAt || r.collectedAt;
        const t = Date.parse(timeVal);
        return !isNaN(t) && t >= fromMs;
      });
    }
    if (opts.to) {
      const toMs = Date.parse(opts.to) + 86400 * 1000;
      records = records.filter(r => {
        const timeVal = r.lastSeenAt || r.publishedAt || r.firstSeenAt || r.collectedAt;
        const t = Date.parse(timeVal);
        return !isNaN(t) && t <= toMs;
      });
    }
    records = records.slice(0, opts.limit);
  }

  if (opts.json) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  const titlePrefix = opts.category ? (lang === 'hu' ? `Kategória: [${opts.category}]` : `Category: [${opts.category}]`) : (lang === 'hu' ? 'Minden kategória' : 'All categories');
  const filterDesc = opts.search ? (lang === 'hu' ? ` | Keresés: "${opts.search}"` : ` | Search: "${opts.search}"`) : '';
  const timeDesc = opts.since ? (lang === 'hu' ? ` | Időtartam: elmúlt ${opts.since}` : ` | Time window: past ${opts.since}`) : (opts.from ? (lang === 'hu' ? ` | Időtartam: ${opts.from}${opts.to ? ' - ' + opts.to : ''}` : ` | Time window: ${opts.from}${opts.to ? ' - ' + opts.to : ''}`) : '');
  const serverLabel = opts.noServer ? ' [STANDALONE / NO-SERVER]' : (isFromApi ? ' [API]' : ' [OFFLINE]');
  const evTitle = lang === 'hu' ? `Crucix Események (${titlePrefix}${filterDesc}${timeDesc})${serverLabel} — Találatok: ${records.length}` : `Crucix Events (${titlePrefix}${filterDesc}${timeDesc})${serverLabel} — Results: ${records.length}`;
  console.log(`\n=== ${evTitle} ===\n`);

  if (records.length === 0) {
    const c = getCliCmd();
    if (lang === 'hu') {
      console.log(`Nincs találat a megadott feltételekre.`);
      console.log(`Tipp: Próbáld a kategóriák listázását: ${c} --categories\n`);
    } else {
      console.log(`No events found matching the specified criteria.`);
      console.log(`Tip: Try listing categories: ${c} --categories\n`);
    }
    return;
  }

  records.forEach((rec, idx) => {
    const kind = `[${rec.kind || 'event'}]`.padEnd(12);
    const countryCode = rec.country || rec.location?.label || '';
    const country = countryCode ? ` 📍 ${countryCode}` : '';
    const timeVal = rec.publishedAt || rec.observedAt || rec.collectedAt || rec.firstSeenAt || rec.firstSeen;
    const age = timeVal ? ` (${formatAge(timeVal, lang)})` : '';
    const srcName = typeof rec.source === 'string' ? rec.source : (rec.source?.name || rec.source?.hostname || '');
    const src = srcName ? `[${srcName}] ` : '';
    const url = rec.url || rec.source?.url;
    console.log(`${idx + 1}. ${kind} ${src}${rec.title}${country}${age}`);
    if (url) {
      console.log(`   🔗 ${url}`);
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
  getCliLanguage,
  isExecutable,
  getCliCmd,
  printHelp,
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
