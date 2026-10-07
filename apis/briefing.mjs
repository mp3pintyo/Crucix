#!/usr/bin/env node

// Crucix Master Orchestrator — runs all intelligence sources in parallel
// Outputs structured JSON for Claude to synthesize into actionable briefing

import './utils/env.mjs'; // Load API keys from .env
import { pathToFileURL } from 'node:url';
import packageInfo from '../package.json' with { type: 'json' };

// === Tier 1: Core OSINT & Geopolitical ===
import { briefing as gdelt } from './sources/gdelt.mjs';
import { briefing as opensky } from './sources/opensky.mjs';
import { briefing as firms } from './sources/firms.mjs';
import { briefing as ships } from './sources/ships.mjs';
import { briefing as safecast } from './sources/safecast.mjs';
import { briefing as acled } from './sources/acled.mjs';
import { briefing as reliefweb } from './sources/reliefweb.mjs';
import { briefing as who } from './sources/who.mjs';
import { briefing as ofac } from './sources/ofac.mjs';
import { briefing as opensanctions } from './sources/opensanctions.mjs';
import { briefing as adsb } from './sources/adsb.mjs';

// === Tier 2: Economic & Financial ===
import { briefing as fred } from './sources/fred.mjs';
import { briefing as treasury } from './sources/treasury.mjs';
import { briefing as bls } from './sources/bls.mjs';
import { briefing as eia } from './sources/eia.mjs';
import { briefing as gscpi } from './sources/gscpi.mjs';
import { briefing as usaspending } from './sources/usaspending.mjs';
import { briefing as comtrade } from './sources/comtrade.mjs';

// === Tier 3: Weather, Environment, Technology, Social ===
import { briefing as noaa } from './sources/noaa.mjs';
import { briefing as epa } from './sources/epa.mjs';
import { briefing as patents } from './sources/patents.mjs';
import { briefing as bluesky } from './sources/bluesky.mjs';
import { briefing as reddit } from './sources/reddit.mjs';
import { briefing as telegram } from './sources/telegram.mjs';
import { briefing as kiwisdr } from './sources/kiwisdr.mjs';

// === Tier 4: Space & Satellites ===
import { briefing as space } from './sources/space.mjs';

// === Tier 5: Live Market Data ===
import { briefing as yfinance } from './sources/yfinance.mjs';

// === Tier 6: Cyber & Infrastructure ===
import { briefing as cisaKev } from './sources/cisa-kev.mjs';
import { briefing as cloudflareRadar } from './sources/cloudflare-radar.mjs';
import { briefing as ioda } from './sources/ioda.mjs';
import { briefing as usgs } from './sources/usgs.mjs';
import { briefing as meteoalarm } from './sources/meteoalarm.mjs';
import { briefing as gdacs } from './sources/gdacs.mjs';
import { briefing as swpc } from './sources/swpc.mjs';
import { briefing as ecb } from './sources/ecb.mjs';
import { briefing as eonet } from './sources/eonet.mjs';
import { briefing as ripestat } from './sources/ripestat.mjs';
import { briefing as epss } from './sources/epss.mjs';
import { briefing as metNorway } from './sources/met-norway.mjs';
import { briefing as ooni } from './sources/ooni.mjs';
import { briefing as portwatch } from './sources/portwatch.mjs';
import { briefing as emsc } from './sources/emsc.mjs';
import { briefing as copernicusEms } from './sources/copernicus-ems.mjs';
import { briefing as sigmet } from './sources/sigmet.mjs';
import { briefing as adsbMilitary } from './sources/adsb-military.mjs';
import { briefing as opensanctionsIndex } from './sources/opensanctions-index.mjs';
import { briefing as federalRegister } from './sources/federal-register.mjs';
import { briefing as energyCharts } from './sources/energy-charts.mjs';
import { briefing as entsog } from './sources/entsog.mjs';
import { briefing as predictionMarkets } from './sources/prediction-markets.mjs';
import { briefing as viewsForecast } from './sources/views.mjs';
import { briefing as threatfox } from './sources/threatfox.mjs';
import { briefing as mispGalaxy } from './sources/misp-galaxy.mjs';
import { briefing as hibp } from './sources/hibp.mjs';
import { briefing as informRisk } from './sources/inform.mjs';
import config from '../crucix.config.mjs';

const SOURCE_TIMEOUT_MS = 30_000; // 30s max per individual source

export function sourceErrors(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return [];
  const errorKey = key => ['error', 'outbreakError', 'defenseError'].includes(key);
  const own = Object.entries(value).filter(([key, child]) => errorKey(key) && typeof child === 'string' && child)
    .map(([, child]) => child);
  return own.concat(Object.entries(value).filter(([key]) => !errorKey(key))
    .flatMap(([, child]) => sourceErrors(child, depth + 1))).slice(0, 10);
}

export async function runSource(name, fn, ...args) {
  const start = Date.now();
  let timer;
  try {
    const dataPromise = fn(...args);
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Source ${name} timed out after ${SOURCE_TIMEOUT_MS / 1000}s`)), SOURCE_TIMEOUT_MS);
    });
    const data = await Promise.race([dataPromise, timeoutPromise]);
    const errors = sourceErrors(data);
    if (['error', 'failed', 'unavailable'].includes(data?.status) && !errors.length) errors.push(data.message || 'Source unavailable');
    const disabled = data?.disabled || ['no_key', 'disabled', 'no_credentials'].includes(data?.status);
    const status = !data || typeof data !== 'object' ? 'error'
      : disabled ? 'disabled' : errors.length ? 'error' : data.stale ? 'stale' : 'ok';
    if (disabled) data.disabled = true;
    if (errors.length && !data.error) data.error = `Partial source failure: ${errors[0]}`;
    return { name, status, durationMs: Date.now() - start, data,
      ...(status === 'error' ? { error: data?.error || 'Invalid source payload' } : {}) };
  } catch (e) {
    return { name, status: 'error', durationMs: Date.now() - start, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function fullBriefing() {
  const start = Date.now();

  const allPromises = [
    // Tier 1: Core OSINT & Geopolitical
    runSource('GDELT', gdelt),
    runSource('OpenSky', opensky),
    runSource('FIRMS', firms),
    runSource('Maritime', ships),
    runSource('Safecast', safecast),
    runSource('ACLED', acled),
    runSource('ReliefWeb', reliefweb),
    runSource('WHO', who),
    runSource('OFAC', ofac),
    runSource('OpenSanctions', opensanctions),
    runSource('ADS-B', adsb),

    // Tier 2: Economic & Financial
    runSource('FRED', fred, process.env.FRED_API_KEY),
    runSource('Treasury', treasury),
    runSource('BLS', bls, process.env.BLS_API_KEY),
    runSource('EIA', eia, process.env.EIA_API_KEY),
    runSource('GSCPI', gscpi),
    runSource('USAspending', usaspending),
    runSource('Comtrade', comtrade),

    // Tier 3: Weather, Environment, Technology, Social
    runSource('NOAA', noaa),
    runSource('EPA', epa),
    runSource('Patents', patents),
    runSource('Bluesky', bluesky),
    runSource('Reddit', reddit),
    runSource('Telegram', telegram),
    runSource('KiwiSDR', kiwisdr),

    // Tier 4: Space & Satellites
    runSource('Space', space),

    // Tier 5: Live Market Data
    runSource('YFinance', yfinance),

    // Tier 6: Cyber & Infrastructure
    runSource('CISA-KEV', cisaKev),
    runSource('Cloudflare-Radar', cloudflareRadar),
    runSource('IODA', ioda),
    runSource('USGS', usgs),
    // Current free public data. Each adapter checks provider timestamps.
    runSource('Meteoalarm', meteoalarm, { countries: config.publicSources.meteoalarmCountries }),
    runSource('GDACS', gdacs),
    runSource('NOAA-SWPC', swpc),
    runSource('ECB', ecb),
    runSource('NASA-EONET', eonet),
    runSource('RIPEstat', ripestat, { resources: config.publicSources.routingASNs }),
    runSource('FIRST-EPSS', epss),
    runSource('MET-Norway', metNorway, { locations: config.publicSources.weatherLocations }),
    runSource('OONI', ooni, { countries: config.publicSources.ooniCountries }),
    runSource('IMF-PortWatch', portwatch, { chokepoints: config.publicSources.portwatchChokepoints }),
    runSource('EMSC', emsc),
    runSource('Copernicus-EMS', copernicusEms),
    runSource('Aviation-SIGMET', sigmet),
    runSource('ADSB-Military', adsbMilitary, { theaters: config.publicSources.adsbTheaters }),
    runSource('OpenSanctions-Index', opensanctionsIndex),
    runSource('Federal-Register', federalRegister),
    runSource('Energy-Charts-HU', energyCharts),
    runSource('ENTSOG-HU', entsog),
    runSource('Prediction-Markets', predictionMarkets, { queries: config.publicSources.marketQueries }),
    runSource('ThreatFox', threatfox),
    runSource('HIBP', hibp),
    // Conflict forecast and country risk baseline for the intelligence layer's country risk (plain sources, no live row).
    runSource('VIEWS-Forecast', viewsForecast),
    runSource('INFORM-Risk', informRisk),
    // Known adversary groups by attributed country: context for the country sheet (plain source, no live row).
    runSource('MISP-Galaxy', mispGalaxy),
  ];

  console.error(`[Crucix] Starting intelligence sweep — ${allPromises.length} sources...`);

  // Each runSource has its own 30s timeout, so allSettled will resolve
  // within ~30s even if APIs hang. Global timeout is a safety net.
  const results = await Promise.allSettled(allPromises);

  const sources = results.map(r => r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason?.message });
  const totalMs = Date.now() - start;

  const output = {
    crucix: {
      version: packageInfo.version,
      timestamp: new Date().toISOString(),
      totalDurationMs: totalMs,
      sourcesQueried: sources.length,
      sourcesOk: sources.filter(s => s.status === 'ok').length,
      sourcesFailed: sources.filter(s => s.status === 'error' || s.status === 'failed').length,
      sourcesDisabled: sources.filter(s => s.status === 'disabled').length,
      sourcesStale: sources.filter(s => s.status === 'stale').length,
    },
    sources: Object.fromEntries(
      sources.filter(s => s.name).map(s => [s.name, s.data || { error: s.error }])
    ),
    errors: sources.filter(s => s.status === 'error' || s.status === 'failed').map(s => ({ name: s.name, error: s.error })),
    timing: Object.fromEntries(
      sources.map(s => [s.name, { status: s.status, ms: s.durationMs }])
    ),
  };

  console.error(`[Crucix] Sweep complete in ${totalMs}ms — ${output.crucix.sourcesOk}/${sources.length} sources returned data`);
  return output;
}

// Run and output when executed directly
const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryHref && import.meta.url === entryHref) {
  const data = await fullBriefing();
  console.log(JSON.stringify(data, null, 2));
}
