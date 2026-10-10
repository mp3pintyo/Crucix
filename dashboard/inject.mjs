#!/usr/bin/env node
// Crucix Dashboard Data Synthesizer
// Reads runs/latest.json, fetches RSS news, generates signal-based ideas,
// and injects everything into dashboard/public/jarvis.html
//
// Exports synthesize(), generateIdeas(), fetchAllNews() for use by server.mjs

import { militarySiteAt } from '../lib/intelligence/military-sites.mjs';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { pathToFileURL } from 'node:url';
import { openBrowser } from '../lib/open-browser.mjs';
import { inlineJson } from '../lib/html.mjs';
import { safeFetch } from '../apis/utils/fetch.mjs';
import { parseFeed } from '../apis/utils/rss.mjs';
import { vesselName, mmsiOf } from '../apis/utils/ais-collector.mjs';
import { NEWS_FEEDS, feedBySource, HUNGARIAN_SOURCES, OFFICIAL_SOURCES } from '../apis/utils/news-feeds.mjs';
import config from '../crucix.config.mjs';
import { createLLMProvider } from '../lib/llm/index.mjs';
import { generateRuleBasedIdeas, resolveIdeas } from '../lib/llm/rule-ideas.mjs';
import { buildEvents, stampLiveEventIds } from '../lib/intelligence/events.mjs';
import { normalizeLiveSources } from '../lib/intelligence/live-sources.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// === Helpers ===
const cyrillic = /[\u0400-\u04FF]/;
function isEnglish(text) {
  if (!text) return false;
  return !cyrillic.test(text.substring(0, 80));
}

// === Geo-tagging keyword map ===
const geoKeywords = {
  'World':[0,0],
  'Ukraine':[49,32],'Russia':[56,38],'Moscow':[55.7,37.6],'Kyiv':[50.4,30.5],
  'China':[35,105],'Beijing':[39.9,116.4],'Iran':[32,53],'Tehran':[35.7,51.4],
  'Israel':[31.5,35],'Gaza':[31.4,34.4],'Palestine':[31.9,35.2],
  'Syria':[35,38],'Iraq':[33,44],'Saudi':[24,45],'Yemen':[15,48],'Lebanon':[34,36],
  'India':[20,78],'Japan':[36,138],'Korea':[37,127],'Pyongyang':[39,125.7],
  'Taiwan':[23.5,121],'Philippines':[13,122],'Myanmar':[20,96],
  'Canada':[56,-96],'Mexico':[23,-102],'Brazil':[-14,-51],'Argentina':[-38,-63],
  'Colombia':[4,-74],'Venezuela':[7,-66],'Cuba':[22,-80],'Chile':[-35,-71],
  'Germany':[51,10],'France':[46,2],'UK':[54,-2],'Britain':[54,-2],'London':[51.5,-0.1],
  'Spain':[40,-4],'Italy':[42,12],'Poland':[52,20],'NATO':[50,4],'EU':[50,4],
  'Turkey':[39,35],'Greece':[39,22],'Romania':[46,25],'Finland':[64,26],'Sweden':[62,15],
  'Africa':[0,20],'Nigeria':[10,8],'South Africa':[-30,25],'Kenya':[-1,38],
  'Egypt':[27,30],'Libya':[27,17],'Sudan':[13,30],'Ethiopia':[9,38],
  'Somalia':[5,46],'Congo':[-4,22],'Uganda':[1,32],'Morocco':[32,-6],
  'Pakistan':[30,70],'Afghanistan':[33,65],'Bangladesh':[24,90],
  'Australia':[-25,134],'Indonesia':[-2,118],'Thailand':[15,100],
  'US':[39,-98],'America':[39,-98],'Washington':[38.9,-77],'Pentagon':[38.9,-77],
  'Trump':[38.9,-77],'White House':[38.9,-77],
  'Wall Street':[40.7,-74],'New York':[40.7,-74],'California':[37,-120],
  'Nepal':[28,84],'Cambodia':[12.5,105],'Malawi':[-13.5,34],'Burundi':[-3.4,29.9],
  'Oman':[21,57],'Netherlands':[52.1,5.3],'Gabon':[-0.8,11.6],
  'Peru':[-10,-76],'Ecuador':[-2,-78],'Bolivia':[-17,-65],
  'Singapore':[1.35,103.8],'Malaysia':[4.2,101.9],'Vietnam':[16,108],
  'Algeria':[28,3],'Tunisia':[34,9],'Zimbabwe':[-20,30],'Mozambique':[-18,35],
  // Americas expansion
  'Texas':[31,-100],'Florida':[28,-82],'Chicago':[41.9,-87.6],'Los Angeles':[34,-118],
  'San Francisco':[37.8,-122.4],'Seattle':[47.6,-122.3],'Miami':[25.8,-80.2],
  'Toronto':[43.7,-79.4],'Ottawa':[45.4,-75.7],'Vancouver':[49.3,-123.1],
  'São Paulo':[-23.5,-46.6],'Rio':[-22.9,-43.2],'Buenos Aires':[-34.6,-58.4],
  'Bogotá':[4.7,-74.1],'Lima':[-12,-77],'Santiago':[-33.4,-70.7],
  'Caracas':[10.5,-66.9],'Havana':[23.1,-82.4],'Panama':[9,-79.5],
  'Guatemala':[14.6,-90.5],'Honduras':[14.1,-87.2],'El Salvador':[13.7,-89.2],
  'Costa Rica':[10,-84],'Jamaica':[18.1,-77.3],'Haiti':[19,-72],
  'Dominican':[18.5,-70],'Puerto Rico':[18.2,-66.5],
  // More Asia-Pacific
  'Sri Lanka':[7,80],'Hong Kong':[22.3,114.2],'Taipei':[25,121.5],
  'Seoul':[37.6,127],'Osaka':[34.7,135.5],'Mumbai':[19.1,72.9],
  'Delhi':[28.6,77.2],'Shanghai':[31.2,121.5],'Shenzhen':[22.5,114.1],
  'Auckland':[-36.8,174.8],'Papua New Guinea':[-6.3,147],
  // More Europe
  'Berlin':[52.5,13.4],'Paris':[48.9,2.3],'Madrid':[40.4,-3.7],
  'Rome':[41.9,12.5],'Warsaw':[52.2,21],'Prague':[50.1,14.4],
  'Vienna':[48.2,16.4],'Budapest':[47.5,19.1],'Bucharest':[44.4,26.1],
  'Kyiv':[50.4,30.5],'Oslo':[59.9,10.7],'Copenhagen':[55.7,12.6],
  'Brussels':[50.8,4.4],'Zurich':[47.4,8.5],'Dublin':[53.3,-6.3],
  'Lisbon':[38.7,-9.1],'Athens':[37.9,23.7],'Minsk':[53.9,27.6],
  // More Africa
  'Nairobi':[-1.3,36.8],'Lagos':[6.5,3.4],'Accra':[5.6,-0.2],
  'Addis Ababa':[9,38.7],'Cape Town':[-33.9,18.4],'Johannesburg':[-26.2,28],
  'Kinshasa':[-4.3,15.3],'Khartoum':[15.6,32.5],'Mogadishu':[2.1,45.3],
  'Dakar':[14.7,-17.5],'Abuja':[9.1,7.5],
  // Tech/Economy keywords with US locations
  'Fed':[38.9,-77],'Congress':[38.9,-77],'Senate':[38.9,-77],
  'Silicon Valley':[37.4,-122],'NASA':[28.6,-80.6],'Pentagon':[38.9,-77],
  'IMF':[38.9,-77],'World Bank':[38.9,-77],'UN':[40.7,-74],
};

function geoTagText(text) {
  if (!text) return null;
  for (const [keyword, [lat, lon]] of Object.entries(geoKeywords)) {
    if (text.includes(keyword)) {
      return { lat, lon, region: keyword };
    }
  }
  return null;
}

const iodaCountryGeo = {
  US: [39, -98, 'United States'],
  'United States': [39, -98, 'United States'],
  GB: [54, -2, 'United Kingdom'],
  UK: [54, -2, 'United Kingdom'],
  'United Kingdom': [54, -2, 'United Kingdom'],
  RU: [56, 38, 'Russia'],
  Russia: [56, 38, 'Russia'],
  UA: [49, 32, 'Ukraine'],
  Ukraine: [49, 32, 'Ukraine'],
  IR: [32, 53, 'Iran'],
  Iran: [32, 53, 'Iran'],
  AF: [33, 65, 'Afghanistan'],
  Afghanistan: [33, 65, 'Afghanistan'],
  IN: [20, 78, 'India'],
  India: [20, 78, 'India'],
  MM: [20, 96, 'Myanmar'],
  Myanmar: [20, 96, 'Myanmar'],
  ET: [9, 38, 'Ethiopia'],
  Ethiopia: [9, 38, 'Ethiopia'],
  SD: [13, 30, 'Sudan'],
  Sudan: [13, 30, 'Sudan'],
  PK: [30, 70, 'Pakistan'],
  Pakistan: [30, 70, 'Pakistan'],
  IQ: [33, 44, 'Iraq'],
  Iraq: [33, 44, 'Iraq'],
  SY: [35, 38, 'Syria'],
  Syria: [35, 38, 'Syria'],
  YE: [15, 48, 'Yemen'],
  Yemen: [15, 48, 'Yemen'],
  TR: [39, 35, 'Turkey'],
  Turkey: [39, 35, 'Turkey'],
  CN: [35, 105, 'China'],
  China: [35, 105, 'China'],
  BR: [-14, -51, 'Brazil'],
  Brazil: [-14, -51, 'Brazil'],
  CU: [22, -80, 'Cuba'],
  Cuba: [22, -80, 'Cuba'],
  VE: [7, -66, 'Venezuela'],
  Venezuela: [7, -66, 'Venezuela'],
  ZA: [-30, 25, 'South Africa'],
  'South Africa': [-30, 25, 'South Africa'],
  NG: [10, 8, 'Nigeria'],
  Nigeria: [10, 8, 'Nigeria'],
  KE: [-1, 38, 'Kenya'],
  Kenya: [-1, 38, 'Kenya'],
  BD: [24, 90, 'Bangladesh'],
  Bangladesh: [24, 90, 'Bangladesh'],
  ID: [-2, 118, 'Indonesia'],
  Indonesia: [-2, 118, 'Indonesia'],
  TH: [15, 100, 'Thailand'],
  Thailand: [15, 100, 'Thailand'],
  PH: [13, 122, 'Philippines'],
  Philippines: [13, 122, 'Philippines'],
  KR: [36, 128, 'South Korea'],
  'South Korea': [36, 128, 'South Korea'],
  KP: [40, 127, 'North Korea'],
  'North Korea': [40, 127, 'North Korea'],
  JP: [36, 138, 'Japan'],
  Japan: [36, 138, 'Japan'],
  FR: [46, 2, 'France'],
  France: [46, 2, 'France'],
  DE: [51, 10, 'Germany'],
  Germany: [51, 10, 'Germany'],
};

function geoTagIodaCountry(country, countryCode) {
  const exact = (countryCode && iodaCountryGeo[countryCode]) || (country && iodaCountryGeo[country]);
  if (exact) return { lat: exact[0], lon: exact[1], region: exact[2] };
  return geoTagText(country || countryCode || '');
}

const whoGeoKeywords = {
  'Democratic Republic of the Congo': [-2.88, 23.66],
  'DR Congo': [-2.88, 23.66],
  'Republic of the Congo': [-0.69, 15.83],
  'Congo': [-2.88, 23.66],
  'Uganda': [1.37, 32.29],
  'Kenya': [-1.29, 36.82],
  'Tanzania': [-6.37, 34.89],
  'Rwanda': [-1.94, 29.87],
  'Burundi': [-3.37, 29.92],
  'South Sudan': [7.86, 29.69],
  'Sudan': [15.5, 32.56],
  'Saudi Arabia': [23.89, 45.08],
  'Yemen': [15.55, 48.52],
  'Pakistan': [30.38, 69.35],
  'Afghanistan': [33.94, 67.71],
  'Nepal': [28.39, 84.12],
  'India': [20.59, 78.96],
  'Cambodia': [12.57, 104.99],
  'Laos': [19.86, 102.5],
  'Thailand': [15.87, 100.99],
  'China': [35.86, 104.2],
  'Mongolia': [46.86, 103.85],
  'Indonesia': [-2.55, 118.01],
  'Papua New Guinea': [-6.31, 143.96],
  'Gabon': [-0.8, 11.61],
  'Ghana': [7.95, -1.02],
  'Niger': [17.61, 8.08],
  'Nigeria': [9.08, 8.68],
  'Cameroon': [5.96, 12.89],
  'Ethiopia': [9.15, 40.49],
  'Somalia': [5.15, 46.2],
  'Madagascar': [-18.77, 46.87],
  'Brazil': [-14.24, -51.93],
  'Peru': [-9.19, -75.02],
  'Bolivia': [-16.29, -63.59],
  'Mexico': [23.63, -102.55],
  'United States': [39.83, -98.58],
  'USA': [39.83, -98.58]
};

const whoRegionCentroids = {
  AFRO: { lat: 0.3, lon: 20.5, region: 'African Region' },
  AMRO: { lat: -8.8, lon: -67.3, region: 'Region of the Americas' },
  EMRO: { lat: 24.4, lon: 43.8, region: 'Eastern Mediterranean Region' },
  EURO: { lat: 54.5, lon: 15.3, region: 'European Region' },
  SEARO: { lat: 15.9, lon: 92.8, region: 'South-East Asia Region' },
  WPRO: { lat: 21.4, lon: 124.7, region: 'Western Pacific Region' }
};

function geoTagWhoAlert(alert = {}) {
  if (alert.whoRegionCode && whoRegionCentroids[alert.whoRegionCode]) {
    return { ...whoRegionCentroids[alert.whoRegionCode], method: 'who-region-centroid' };
  }

  const text = [alert.title, alert.summary, alert.overview, alert.assessment]
    .filter(Boolean)
    .join(' ');

  for (const [keyword, [lat, lon]] of Object.entries(whoGeoKeywords)) {
    if (text.includes(keyword)) return { lat, lon, region: keyword, method: 'text-keyword' };
  }

  const geo = geoTagText(text);
  return geo ? { ...geo, method: 'text-keyword' } : null;
}

function getWhoMarkerSize(alert) {
  if (alert.severity === 'critical') return 0.34;
  if (alert.severity === 'high') return 0.3;
  if (alert.severity === 'elevated') return 0.26;
  return 0.22;
}

function rankSupplementalHealthAlert(alert = {}) {
  const text = [alert.title, ...(alert.disasterType || []), ...(alert.countries || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  let score = 18;

  const weights = [
    [/ebola|marburg|hantavirus/i, 26],
    [/cholera|polio|yellow fever|meningitis/i, 20],
    [/measles|dengue|mpox|influenza|avian influenza/i, 15],
    [/outbreak|epidemic|pandemic|surveillance/i, 10],
    [/response|update|situation report/i, 4],
  ];
  for (const [pattern, weight] of weights) {
    if (pattern.test(text)) score += weight;
  }

  const recencyDays = Math.max(
    0,
    Math.floor((Date.now() - new Date(alert.date || 0).getTime()) / (24 * 60 * 60 * 1000))
  );
  score += Math.max(0, 20 - recencyDays);

  let severity = 'monitor';
  if (score >= 50) severity = 'critical';
  else if (score >= 35) severity = 'high';
  else if (score >= 24) severity = 'elevated';

  return { score, severity };
}

function getSupplementalMarkerSize(alert) {
  if (alert.severity === 'critical') return 0.28;
  if (alert.severity === 'high') return 0.25;
  if (alert.severity === 'elevated') return 0.22;
  return 0.18;
}

function sanitizeExternalUrl(raw) {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sumAirHotspots(hotspots = []) {
  return hotspots.reduce((sum, hotspot) => sum + (hotspot.totalAircraft || 0), 0);
}

function summarizeAirHotspots(hotspots = []) {
  return hotspots.map(h => ({
    region: h.region,
    total: h.totalAircraft || 0,
    noCallsign: h.noCallsign || 0,
    highAlt: h.highAltitude || 0,
    top: Object.entries(h.byCountry || {}).sort((a, b) => b[1] - a[1]).slice(0, 5),
  }));
}

export function loadOpenSkyFallback(currentTimestamp, runsDir = config.runsDir || join(ROOT, 'runs'), ttlMs = 3600000) {
  if (!existsSync(runsDir)) return null;

  const currentMs = currentTimestamp ? new Date(currentTimestamp).getTime() : NaN;
  if (!Number.isFinite(currentMs)) return null;
  const files = readdirSync(runsDir)
    .filter(name => /^briefing_.*\.json$/.test(name))
    .sort()
    .reverse();

  const candidates = [];
  for (const file of files) {
    const filePath = join(runsDir, file);
    try {
      const prior = JSON.parse(readFileSync(filePath, 'utf8'));
      const priorTimestamp = prior.sources?.OpenSky?.timestamp || null;
      const priorMs = Date.parse(priorTimestamp);
      if (!Number.isFinite(priorMs) || priorMs >= currentMs || currentMs - priorMs > ttlMs) continue;

      const hotspots = prior.sources?.OpenSky?.hotspots || [];
      if (!prior.sources?.OpenSky?.error && sumAirHotspots(hotspots) > 0) {
        candidates.push({ file, timestamp: priorTimestamp, hotspots, ageMs: currentMs - priorMs });
      }
    } catch {
      // Ignore unreadable historical runs and continue searching backward.
    }
  }

  return candidates.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0] || null;
}

// === RSS Fetching ===
async function fetchRSS(url, source, meta = {}) {
  try {
    const response = await safeFetch(url, { timeout: 8000, retries: 0, format: 'text', maxBytes: 2 * 1024 * 1024 });
    if (response.error) throw new Error(response.error);
    const items = [];
    for (const item of parseFeed(response.rawText)) {
      const link = sanitizeExternalUrl(item.link);
      if (item.title !== source) items.push({ title: item.title, date: item.date, source, url: link || undefined, ...(meta.tier ? { tier: meta.tier } : {}), ...(meta.lang && meta.lang !== 'en' ? { lang: meta.lang } : {}), ...(meta.state ? { state: true } : {}) });
    }
    return items.slice(0, MAX_PER_FEED);
  } catch (e) {
    console.log(`RSS fetch failed (${source}):`, e.message);
    return [];
  }
}

const REGIONAL_NEWS_SOURCES = ['MercoPress', 'Indian Express', 'The Hindu', 'SBS Australia'];
// Newest headlines taken from one feed (some feeds list 300) and the size of the selection that reaches the dashboard.
const MAX_PER_FEED = 15;
const NEWS_LIMIT = 60;
const PER_SOURCE_LIMIT = 5;

// `customFeeds` takes [url, source] pairs (tests, local overrides); the default is the tiered registry.
export async function fetchAllNews(customFeeds) {
  const feeds = customFeeds ? customFeeds.map(([url, source]) => ({ ...feedBySource(source), url, source })) : NEWS_FEEDS;

  const results = await Promise.allSettled(
    feeds.map(feed => fetchRSS(feed.url, feed.source, feed))
  );

  const allNews = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  // De-duplicate and geo-tag
  const seen = new Set();
  const geoNews = [];
  for (const item of allNews) {
    const key = item.title.substring(0, 40).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const geo = geoTagText(item.title);
      geoNews.push({
        title: item.title.substring(0, 2000),
        source: item.source,
        date: item.date,
        url: item.url,
        ...(item.tier ? { tier: item.tier } : {}),
        ...(item.lang ? { lang: item.lang } : {}),
        ...(item.state ? { state: true } : {}),
        ...(geo ? { lat: geo.lat, lon: geo.lon, region: geo.region, locationMethod: 'headline-keyword', locationPrecision: 'approximate' }
          : { region: 'Global', locationMethod: 'unknown' }),
      });
  }

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const filtered = geoNews.filter(n => !n.date || new Date(n.date) >= cutoff);
  filtered.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  const selected = [];
  const selectedKeys = new Set();
  const keyFor = item => `${item.source}|${item.title}|${item.date}`;
  const pushUnique = item => {
    const key = keyFor(item);
    if (selectedKeys.has(key)) return;
    selected.push(item);
    selectedKeys.add(key);
  };

  // Reserve a little space so regional, Hungarian and official feeds are not crowded out by larger globals.
  for (const source of REGIONAL_NEWS_SOURCES) {
    filtered.filter(item => item.source === source).slice(0, 2).forEach(pushUnique);
  }
  for (const source of [...HUNGARIAN_SOURCES, ...OFFICIAL_SOURCES]) {
    filtered.filter(item => item.source === source).slice(0, 1).forEach(pushUnique);
  }
  // After the reserved slots no feed may hold more than PER_SOURCE_LIMIT of the selection, so one busy feed cannot fill it.
  const counts = new Map();
  for (const item of selected) counts.set(item.source, (counts.get(item.source) || 0) + 1);
  for (const item of filtered) {
    if ((counts.get(item.source) || 0) >= PER_SOURCE_LIMIT || selectedKeys.has(keyFor(item))) continue;
    pushUnique(item);
    counts.set(item.source, (counts.get(item.source) || 0) + 1);
  }
  return selected.slice(0, NEWS_LIMIT);
}

// === Leverageable Ideas from Signals ===
export function generateIdeas(V2) { return generateRuleBasedIdeas(V2, config.llm.tradeIdeasLang); }

// === Synthesize raw sweep data into dashboard format ===
// One signal for the high-intensity (FRP > 10 MW) detections that fall on or beside a mapped military area. A fire there can be a range fire,
// a burn-off or an attack: the text says where and how many, not what it was.
function militarySiteSignal(fires) {
  const names = [...new Set(fires.map(f => f.site.name))];
  const regions = [...new Set(fires.map(f => f.region))].slice(0, 3);
  const top = Math.max(...fires.map(f => f.frp));
  return `${fires.length} high-intensity thermal detection${fires.length === 1 ? '' : 's'} (top ${top.toFixed(0)} MW) on or beside mapped military areas in ${regions.join(', ')}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}. Range fire, burn-off and attack look alike from orbit; check other sources.`;
}

export async function synthesize(data, options = {}) {
  const liveAirHotspots = data.sources.OpenSky?.hotspots || [];
  const hasUsableLiveAir = liveAirHotspots.some(h => !h.error && Number.isFinite(h.totalAircraft));
  const airFallback = !hasUsableLiveAir && (data.sources.OpenSky?.error || !data.sources.OpenSky)
    ? loadOpenSkyFallback(data.crucix?.timestamp, options.runsDir, options.airFallbackTtlMs)
    : null;
  const effectiveAirHotspots = airFallback?.hotspots || liveAirHotspots;
  const air = summarizeAirHotspots(effectiveAirHotspots);
  const thermal = (data.sources.FIRMS?.hotspots || []).map(h => ({
    region: h.region, det: h.totalDetections || 0, night: h.nightDetections || 0,
    hc: h.highConfidence || 0,
    fires: (h.highIntensity || []).slice(0, 8).map(f => {
      const row = { lat: f.lat, lon: f.lon, frp: f.frp || 0 };
      const site = militarySiteAt(f.lat, f.lon);
      if (site) row.site = site.name;
      return row;
    })
  }));
  // Forecast tracks (and cones) of the active tropical cyclones (NOAA-NHC, JMA-Typhoon); only from a source that answered fresh.
  const cyclones = ['NOAA-NHC', 'JMA-Typhoon'].flatMap(name => data.sources[name]?.status === 'ok' && Array.isArray(data.sources[name].geometry) ? data.sources[name].geometry.slice(0, 12) : []).slice(0, 20);
  const siteFires = (data.sources.FIRMS?.hotspots || []).flatMap(h => (h.highIntensity || [])
    .map(f => ({ region: h.region, frp: f.frp || 0, site: militarySiteAt(f.lat, f.lon) })).filter(f => f.site));
  const siteSignals = siteFires.length ? [militarySiteSignal(siteFires)] : [];
  const iodaData = data.sources.IODA || {};
  const iodaCountries = (iodaData.outages?.affectedCountries || [])
    .map(country => {
      const geo = geoTagIodaCountry(country.country, country.countryCode);
      return {
        country: country.country,
        countryCode: country.countryCode,
        eventCount: country.eventCount || 0,
        activeCount: country.activeCount || 0,
        overallScore: country.overallScore || 0,
        topDatasource: country.topDatasource || 'overall',
        lastStart: country.lastStart || null,
        lat: geo?.lat ?? null,
        lon: geo?.lon ?? null,
        region: geo?.region || country.country || 'Global',
        markerSize: Math.max(0.2, Math.min(0.42, 0.2 + (country.activeCount || 0) * 0.04 + Math.min((country.overallScore || 0) / 8000, 0.16))),
      };
    })
    .filter(country => country.lat != null && country.lon != null)
    .sort((a, b) => {
      if (b.activeCount !== a.activeCount) return b.activeCount - a.activeCount;
      if (b.overallScore !== a.overallScore) return b.overallScore - a.overallScore;
      return b.eventCount - a.eventCount;
    })
    .slice(0, 15);
  const ioda = {
    totalEvents: iodaData.outages?.totalEvents || 0,
    activeEvents: iodaData.outages?.activeEvents || 0,
    countries: iodaCountries,
    recentEvents: (iodaData.outages?.recentEvents || []).slice(0, 12).map(event => ({
      id: event.id,
      country: event.country,
      countryCode: event.countryCode,
      start: event.startIso || null,
      end: event.endIso || null,
      active: Boolean(event.active),
      datasource: event.datasource || 'overall',
      method: event.method || 'unknown',
      score: event.score || 0,
      durationSeconds: event.durationSeconds || 0,
      lat: iodaCountryGeo[event.countryCode]?.[0] ?? null,
      lon: iodaCountryGeo[event.countryCode]?.[1] ?? null,
      locationMethod: 'country-centroid', locationPrecision: 'approximate',
    })),
    signals: (iodaData.signals || []).map(signal => signal.signal || signal).filter(Boolean),
  };
  const tSignals = [
    ...(data.sources.FIRMS?.signals || []),
    ...siteSignals,
    ...ioda.signals,
  ];
  const chokepoints = Object.values(data.sources.Maritime?.chokepoints || {}).map(c => ({
    label: c.label || c.name, note: c.note || '', lat: c.lat || 0, lon: c.lon || 0
  }));
  // Live AIS vessels (Maritime with AISSTREAM_API_KEY): markers of the maritime layer only, on purpose never live rows, events or history.
  // Structured fields only: the dashboard words them in its language (jarvis.html aisVesselText). The name was sanitised by the source;
  // it is checked again here (the same AIS text allowlist), since runs/latest.json is read back from disk. A marker needs a name or a valid MMSI.
  const aisKey = value => typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : null;
  const aisVessels = (data.sources.Maritime?.status === 'ok' && Array.isArray(data.sources.Maritime.vessels) ? data.sources.Maritime.vessels.slice(0, 89) : [])
    .filter(v => v && Number.isFinite(v.lat) && Number.isFinite(v.lon) && Math.abs(v.lat) <= 90 && Math.abs(v.lon) <= 180)
    .map(v => ({ name: vesselName(v.name), mmsi: mmsiOf(v.mmsi),
      area: aisKey(v.area), speedKn: Number.isFinite(v.speedKn) && v.speedKn >= 0 && v.speedKn < 102.3 ? v.speedKn : null, vesselType: aisKey(v.vesselType),
      lastSeen: typeof v.lastSeen === 'string' && v.lastSeen.length <= 30 && Number.isFinite(Date.parse(v.lastSeen)) ? new Date(v.lastSeen).toISOString() : null, lat: v.lat, lon: v.lon }))
    .filter(v => v.name || v.mmsi !== null);
  // Modelled current wind at each site (Open-Meteo-Wind), matched by the site's label; absent when that source did not answer fresh.
  const windAt = new Map(data.sources['Open-Meteo-Wind']?.status === 'ok' ? (data.sources['Open-Meteo-Wind'].observations || []).map(o => [o.place, o]) : []);
  const nuke = (data.sources.Safecast?.sites || []).map(s => {
    const w = windAt.get(s.site);
    return {
      site: s.site, anom: s.anomaly || false, cpm: s.avgCPM, n: s.recentReadings || 0,
      status: s.status, last: s.lastReading ?? null,
      ...(w ? { wind: { ms: w.windMs, from: w.windFromDeg, toward: w.windTowardDeg, dir: w.windToward, at: w.observedAt } } : {})
    };
  });
  const nukeSignals = (data.sources.Safecast?.signals || []).filter(s => s);
  const sdrData = data.sources.KiwiSDR || {};
  const sdrNet = sdrData.network || {};
  const sdrConflict = sdrData.conflictZones || {};
  const sdrZones = Object.values(sdrConflict).map(z => ({
    region: z.region, count: z.count || 0,
    receivers: (z.receivers || []).slice(0, 5).map(r => ({ name: r.name || '', lat: r.lat || 0, lon: r.lon || 0 }))
  }));
  const tgData = data.sources.Telegram || {};
  const tgUrgent = (tgData.urgentPosts || []).filter(p => isEnglish(p.text)).map(p => ({
    id: p.postId, channel: p.channel, text: p.text?.substring(0, 2000), views: p.views, date: p.date, url: sanitizeExternalUrl(p.url), urgentFlags: p.urgentFlags || []
  }));
  const tgTop = (tgData.topPosts || []).filter(p => isEnglish(p.text)).map(p => ({
    id: p.postId, channel: p.channel, text: p.text?.substring(0, 2000), views: p.views, date: p.date, url: sanitizeExternalUrl(p.url), urgentFlags: []
  }));
  const who = (data.sources.WHO?.diseaseOutbreakNews || [])
    .map(w => {
      const geo = geoTagWhoAlert(w);
      return {
        title: w.title?.substring(0, 2000),
        date: w.date,
        lastModified: w.lastModified,
        summary: w.summary?.substring(0, 150),
        overview: w.overview?.substring(0, 220),
        assessment: w.assessment?.substring(0, 180),
        response: w.response?.substring(0, 150),
        url: sanitizeExternalUrl(w.url),
        severity: w.severity || 'monitor',
        score: w.severityScore || 0,
        lat: geo?.lat ?? null,
        lon: geo?.lon ?? null,
        locationMethod: geo?.method || 'unknown', locationPrecision: geo ? 'approximate' : 'unknown',
        region: geo?.region || w.whoRegion || 'Global',
        whoRegion: w.whoRegion || null,
        whoRegionCode: w.whoRegionCode || null,
        emergencyEvent: w.emergencyEvent || null,
        emergencyEventId: w.emergencyEventId || null,
        emergencyEventStartDate: w.emergencyEventStartDate || null,
        markerSize: getWhoMarkerSize(w),
      };
    })
    .filter(w => w.lat != null && w.lon != null)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.date || 0) - new Date(a.date || 0);
    })
    .slice(0, 10);
  const supplementalHealth = (data.sources.ReliefWeb?.healthAlerts || [])
    .map(item => {
      const primaryGeo = geoTagText((item.countries || []).join(' '));
      const fallbackGeo = geoTagText(item.title || '');
      const geo = primaryGeo || fallbackGeo;
      const ranked = rankSupplementalHealthAlert(item);
      return {
        title: item.title?.substring(0, 2000),
        date: item.date,
        source: Array.isArray(item.source) ? item.source.join(', ') : item.source,
        countries: item.countries || [],
        disasterType: item.disasterType || [],
        url: sanitizeExternalUrl(item.url),
        severity: ranked.severity,
        score: ranked.score,
        lat: geo?.lat ?? null,
        lon: geo?.lon ?? null,
        locationMethod: primaryGeo ? 'country-centroid' : fallbackGeo ? 'headline-keyword' : 'unknown',
        locationPrecision: geo ? 'approximate' : 'unknown',
        region: geo?.region || item.countries?.[0] || 'Global',
        markerSize: getSupplementalMarkerSize(ranked),
      };
    })
    .filter(item => item.lat != null && item.lon != null)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.date || 0) - new Date(a.date || 0);
    })
    .slice(0, 10);
  const fred = (data.sources.FRED?.indicators || []).map(f => ({
    id: f.id, label: f.label, value: f.value, date: f.date,
    recent: f.recent || [],
    momChange: f.momChange, momChangePct: f.momChangePct
  }));
  const energyData = data.sources.EIA || {};
  const oilPrices = energyData.oilPrices || {};
  const wtiRecent = (oilPrices.wti?.recent || []).map(d => d.value);
  const energy = {
    wti: oilPrices.wti?.value, brent: oilPrices.brent?.value,
    natgas: energyData.gasPrice?.value, crudeStocks: energyData.inventories?.crudeStocks?.value,
    wtiRecent, signals: energyData.signals || []
  };
  const bls = data.sources.BLS?.indicators || [];
  const treasuryData = data.sources.Treasury || {};
  const debtArr = treasuryData.debt || [];
  const treasury = { totalDebt: debtArr[0]?.totalDebt || '0', signals: treasuryData.signals || [] };
  const gscpi = data.sources.GSCPI?.latest || null;
  const defense = (data.sources.USAspending?.recentDefenseContracts || []).slice(0, 5).map(c => ({
    recipient: c.recipient?.substring(0, 40), amount: c.amount, desc: c.description?.substring(0, 80)
  }));
  const noaa = {
    totalAlerts: data.sources.NOAA?.totalSevereAlerts || 0,
    alerts: (data.sources.NOAA?.topAlerts || []).filter(a => a.lat != null && a.lon != null).slice(0, 10).map(a => ({
      id: a.id, url: sanitizeExternalUrl(a.url), sent: a.sent, onset: a.onset, expires: a.expires,
      areas: a.areas, event: a.event, severity: a.severity, headline: a.headline?.substring(0, 2000),
      lat: a.lat, lon: a.lon, locationMethod: a.locationMethod || 'unknown', locationPrecision: a.locationPrecision || 'unknown'
    }))
  };

  // EPA RadNet — pass through geo-tagged readings
  const epaData = data.sources.EPA || {};
  const epaStations = [];
  const seenEpa = new Set();
  for (const r of (epaData.readings || [])) {
    if (r.lat == null || r.lon == null) continue;
    const key = `${r.lat},${r.lon}`;
    if (seenEpa.has(key)) continue;
    seenEpa.add(key);
    epaStations.push({ location: r.location, state: r.state, lat: r.lat, lon: r.lon, analyte: r.analyte, result: r.result, unit: r.unit });
  }
  const epa = { totalReadings: epaData.totalReadings || 0, stations: epaStations.slice(0, 10) };

  // Space/CelesTrak satellite data
  const spaceData = data.sources.Space || {};
  // Approximate subsatellite position from TLE orbital elements
  function estimateSatPosition(sat) {
    if (!sat?.inclination || !sat?.epoch) return null;
    const epoch = new Date(sat.epoch);
    const now = new Date();
    const elapsed = (now - epoch) / 1000;
    const period = (sat.period || 92.7) * 60; // minutes to seconds
    const orbits = elapsed / period;
    const frac = orbits % 1;
    const lat = sat.inclination * Math.sin(frac * 2 * Math.PI);
    const lonShift = (elapsed / 86400) * 360;
    const orbitLon = frac * 360;
    const lon = ((orbitLon - lonShift) % 360 + 540) % 360 - 180;
    return { lat: +lat.toFixed(2), lon: +lon.toFixed(2), name: sat.name };
  }
  const issPos = estimateSatPosition(spaceData.iss);
  const spaceStations = (spaceData.spaceStations || []).map(s => estimateSatPosition(s)).filter(Boolean);
  const space = {
    totalNewObjects: spaceData.totalNewObjects || 0,
    militarySats: spaceData.militarySatellites || 0,
    militaryByCountry: spaceData.militaryByCountry || {},
    constellations: spaceData.constellations || {},
    iss: spaceData.iss || null,
    issPosition: issPos,
    stationPositions: spaceStations.slice(0, 5),
    recentLaunches: (spaceData.recentLaunches || []).slice(0, 10).map(l => ({
      name: l.name, country: l.country, epoch: l.epoch,
      apogee: l.apogee, perigee: l.perigee, type: l.objectType
    })),
    launchByCountry: spaceData.launchByCountry || {},
    signals: spaceData.signals || [],
  };

  // ACLED conflict events
  const acledData = data.sources.ACLED || {};
  const acled = acledData.error ? { totalEvents: 0, totalFatalities: 0, byRegion: {}, byType: {}, deadliestEvents: [] } : {
    totalEvents: acledData.totalEvents || 0,
    totalFatalities: acledData.totalFatalities || 0,
    byRegion: acledData.byRegion || {},
    byType: acledData.byType || {},
    deadliestEvents: (acledData.deadliestEvents || []).slice(0, 15).map(e => ({
      id: e.id, url: sanitizeExternalUrl(e.url), notes: e.notes, date: e.date, type: e.type, country: e.country, location: e.location,
      locationMethod: e.locationMethod || 'provider', locationPrecision: e.locationPrecision || 'unknown',
      fatalities: e.fatalities || 0, lat: e.lat ?? null, lon: e.lon ?? null
    }))
  };

  // GDELT news articles + geo events
  const gdeltData = data.sources.GDELT || {};
  const gdelt = {
    totalArticles: gdeltData.totalArticles || 0,
    conflicts: (gdeltData.conflicts || []).length,
    economy: (gdeltData.economy || []).length,
    health: (gdeltData.health || []).length,
    crisis: (gdeltData.crisis || []).length,
    topTitles: (gdeltData.allArticles || []).slice(0, 5).map(a => a.title?.substring(0, 80)),
    geoPoints: (gdeltData.geoPoints || []).slice(0, 20).map(p => ({
      lat: p.lat, lon: p.lon, name: (p.name || '').substring(0, 80), count: p.count || 1
    }))
  };

  const liveSources = normalizeLiveSources(data.sources, options.now ?? Date.now());
  const liveStates = new Map(liveSources.map(row=>[row.source,row]));
  const health = Object.entries(data.sources).map(([name, src]) => ({
    n: name, err: Boolean(src.error), stale: Boolean(src.stale) || (name === 'OpenSky' && Boolean(airFallback)),
    disabled: Boolean(src.disabled), message: src.error || src.message || null,
    timestamp: name === 'OpenSky' && airFallback ? airFallback.timestamp : src.timestamp || null,
    ...(liveStates.has(name) ? { stale:liveStates.get(name).status==='stale', err:liveStates.get(name).status==='error', observedAt:liveStates.get(name).observedAt, freshness:liveStates.get(name).freshness } : {}),
  }));

  // === Yahoo Finance live market data ===
  const yfData = data.sources.YFinance || {};
  const yfQuotes = yfData.quotes || {};
  const markets = {
    indexes: (yfData.indexes || []).map(q => ({
      symbol: q.symbol, name: q.name, price: q.price,
      change: q.change, changePct: q.changePct, history: q.history || []
    })),
    rates: (yfData.rates || []).map(q => ({
      symbol: q.symbol, name: q.name, price: q.price,
      change: q.change, changePct: q.changePct
    })),
    commodities: (yfData.commodities || []).map(q => ({
      symbol: q.symbol, name: q.name, price: q.price,
      change: q.change, changePct: q.changePct, history: q.history || []
    })),
    crypto: (yfData.crypto || []).map(q => ({
      symbol: q.symbol, name: q.name, price: q.price,
      change: q.change, changePct: q.changePct
    })),
    vix: yfQuotes['^VIX'] ? {
      value: yfQuotes['^VIX'].price,
      change: yfQuotes['^VIX'].change,
      changePct: yfQuotes['^VIX'].changePct,
    } : null,
    timestamp: yfData.summary?.timestamp || null,
  };

  const yfGold = yfQuotes['GC=F'];
  const yfSilver = yfQuotes['SI=F'];
  const metals = {
    gold: yfGold?.price,
    goldChange: yfGold?.change,
    goldChangePct: yfGold?.changePct,
    goldRecent: yfGold?.history?.map(h => h.close) || [],
    silver: yfSilver?.price,
    silverChange: yfSilver?.change,
    silverChangePct: yfSilver?.changePct,
    silverRecent: yfSilver?.history?.map(h => h.close) || [],
  };

  // Override stale EIA prices with live Yahoo Finance data if available
  const yfWti = yfQuotes['CL=F'];
  const yfBrent = yfQuotes['BZ=F'];
  const yfNatgas = yfQuotes['NG=F'];
  if (yfWti?.price) energy.wti = yfWti.price;
  if (yfBrent?.price) energy.brent = yfBrent.price;
  if (yfNatgas?.price) energy.natgas = yfNatgas.price;
  if (yfWti?.history?.length) energy.wtiRecent = yfWti.history.slice().reverse().map(h => h.close);

  // Fetch RSS
  const allNews = options.news ?? await fetchAllNews();
  const news = allNews.filter(n => Number.isFinite(n.lat) && Number.isFinite(n.lon));

  const V2 = {
    meta: data.crucix, air, thermal, tSignals, chokepoints, aisVessels, nuke, nukeSignals, liveSources, cyclones,
    airMeta: {
      fallback: Boolean(airFallback),
      liveTotal: sumAirHotspots(liveAirHotspots),
      timestamp: airFallback?.timestamp || data.sources.OpenSky?.timestamp || data.crucix?.timestamp || null,
      source: airFallback ? 'OpenSky fallback' : 'OpenSky',
      ...(airFallback ? { fallbackFile: airFallback.file } : {}),
      ...(airFallback ? { stale: true, ageMs: airFallback.ageMs } : {}),
      ...(data.sources.OpenSky?.error ? { error: data.sources.OpenSky.error } : {}),
    },
    sdr: { total: sdrNet.totalReceivers || 0, online: sdrNet.online || 0, zones: sdrZones },
    earthquakes: data.sources.USGS?.earthquakes || [],
    ioda,
    tg: { posts: tgData.totalPosts || 0, urgent: tgUrgent, topPosts: tgTop },
    who, supplementalHealth, fred, energy, metals, bls, treasury, gscpi, defense, noaa, epa, acled, gdelt, space, health, news,
    markets, // Live Yahoo Finance market data
    ideas: [], ideasSource: 'rules',
    // newsFeed for ticker (merged RSS + GDELT + Telegram)
    newsFeed: buildNewsFeed(allNews, gdeltData, tgUrgent, tgTop),
  };

  V2.ideas = generateIdeas(V2);
  V2.liveSources = stampLiveEventIds(V2.liveSources);
  V2.events = buildEvents(V2, { now: options.now ?? Date.now() });
  return V2;
}

// === Unified News Feed for Ticker ===
export function sourceTimestamp(raw) {
  if (!raw) return null;
  const compact = String(raw).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (compact && (Number(compact[4]) > 23 || Number(compact[5]) > 59 || Number(compact[6]) > 59)) return null;
  const value = compact ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z` : raw;
  const calendar = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (calendar) {
    const day = new Date(`${calendar[1]}T00:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== calendar[1]) return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function buildNewsFeed(rssNews, gdeltData, tgUrgent, tgTop) {
  const feed = [];

  // RSS news
  for (const n of rssNews) {
    feed.push({
      headline: n.title, source: n.source, type: 'rss',
      timestamp: sourceTimestamp(n.date), publishedAt: sourceTimestamp(n.date), region: n.region, urgent: false, url: sanitizeExternalUrl(n.url),
      ...(n.tier ? { tier: n.tier } : {}), ...(n.lang ? { lang: n.lang } : {}), ...(n.state ? { state: true } : {}),
      lat: n.lat, lon: n.lon, locationMethod: n.locationMethod || 'unknown', locationPrecision: n.locationPrecision || 'unknown'
    });
  }

  // GDELT top articles
  for (const a of (gdeltData.allArticles || []).slice(0, 10)) {
    if (a.title) {
      const geo = geoTagText(a.title);
      feed.push({
        headline: a.title.substring(0, 2000), source: 'GDELT', type: 'gdelt',
        timestamp: sourceTimestamp(a.seendate || a.date), observedAt: sourceTimestamp(a.seendate), publishedAt: sourceTimestamp(a.date),
        region: geo?.region || 'Global', urgent: false, url: sanitizeExternalUrl(a.url),
        lat: geo?.lat, lon: geo?.lon, locationMethod: geo ? 'headline-keyword' : 'unknown', locationPrecision: geo ? 'approximate' : 'unknown'
      });
    }
  }

  // Telegram urgent
  for (const p of tgUrgent.slice(0, 10)) {
    const text = (p.text || '').replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '').trim();
    feed.push({
      id: p.id, headline: text.substring(0, 2000), source: p.channel?.toUpperCase() || 'TELEGRAM', publishedAt: sourceTimestamp(p.date),
      type: 'telegram', timestamp: sourceTimestamp(p.date), region: 'OSINT', urgent: true, url: sanitizeExternalUrl(p.url)
    });
  }

  // Telegram top (non-urgent)
  for (const p of tgTop.slice(0, 5)) {
    const text = (p.text || '').replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '').trim();
    feed.push({
      id: p.id, headline: text.substring(0, 2000), source: p.channel?.toUpperCase() || 'TELEGRAM', publishedAt: sourceTimestamp(p.date),
      type: 'telegram', timestamp: sourceTimestamp(p.date), region: 'OSINT', urgent: false, url: sanitizeExternalUrl(p.url)
    });
  }

  // Filter to last 30 days, sort by timestamp descending, limit to 50
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recent = feed.filter(item => !item.timestamp || new Date(item.timestamp) >= cutoff);
  recent.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

  const selected = [];
  const selectedKeys = new Set();
  const keyFor = item => `${item.type}|${item.source}|${item.headline}|${item.timestamp}`;
  const pushUnique = item => {
    const key = keyFor(item);
    if (selectedKeys.has(key)) return;
    selected.push(item);
    selectedKeys.add(key);
  };

  for (const source of REGIONAL_NEWS_SOURCES) {
    recent.filter(item => item.source === source).slice(0, 2).forEach(pushUnique);
  }
  recent.forEach(pushUnique);
  return selected.slice(0, 50);
}

// === CLI Mode: inject into HTML file ===
function getCliArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

async function cliInject() {
  const data = JSON.parse(readFileSync(join(ROOT, 'runs/latest.json'), 'utf8'));
  const htmlOverride = getCliArg('--html');
  const shouldOpen = !process.argv.includes('--no-open');

  console.log('Fetching RSS news feeds...');
  const V2 = await synthesize(data);
  const llmProvider = createLLMProvider(config.llm);

  Object.assign(V2, await resolveIdeas(llmProvider, V2, null, [], config.llm.tradeIdeasLang));
  console.log(`Generated ${V2.ideas.length} leverageable ideas`);

  const json = inlineJson(V2);
  console.log('\n--- Synthesis ---');
  console.log('Size:', json.length, 'bytes | Air:', V2.air.length, '| Thermal:', V2.thermal.length,
    '| News:', V2.news.length, '| Ideas:', V2.ideas.length, '| Sources:', V2.health.length);

  const htmlPath = htmlOverride || join(ROOT, 'dashboard/public/jarvis.html');
  let html = readFileSync(htmlPath, 'utf8');
  // Use a replacer function so JSON is inserted literally even if it contains `$`.
  html = html.replace(/^(let|const) D = .*;\s*$/m, () => 'let D = ' + json + ';');
  writeFileSync(htmlPath, html);
  console.log('Data injected into jarvis.html!');

  if (!shouldOpen) return;

  // Auto-open dashboard in default browser
  openBrowser(pathToFileURL(htmlPath).href);
}

// Run CLI if invoked directly
const isMain = process.argv[1]
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');
if (isMain) {
  await cliInject();
}
