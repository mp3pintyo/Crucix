// GPSJam.org: GNSS (GPS) interference seen by aircraft. gpsjam.org derives it from ADS-B Exchange data: for each H3 resolution-4 hexagon
// and UTC day it counts aircraft that reported a good navigation-accuracy value and aircraft that reported a bad one; a high share of bad
// ones means jamming or spoofing. https://gpsjam.org/data/manifest.csv lists the days ("date,suspect,num_bad_hexes,merged", gzip-compressed on
// the wire, which fetch undoes); https://gpsjam.org/data/<date>-h3_4.csv is "hex,count_good_aircraft,count_bad_aircraft" (47,428 rows, 1 MB on
// 2026-10-08, when the newest day was 2026-10-06: the data lags about two days). No key.
// The rule is the one gpsjam.org and World Monitor use: a hexagon needs at least 3 aircraft that day; more than 10% bad is HIGH interference,
// more than 2% up to 10% MEDIUM, the rest is not shown. Measured on 2026-10-06: 806 high and 838 medium hexagons out of 47,428.
// What the dashboard gets is not 800 hexagons but a readable summary: one row per named region (a bounding box around a theatre where
// interference is routinely reported, the first matching box wins) with its hexagon counts and the worst share, located at the mean of its high
// hexagons, and the 15 single hexagons with the most bad aircraft weighted by their share (busy airspace alone does not rank). A hexagon is placed by its centre (h3-js cellToLatLng).
// Interference is a chronic condition in several theatres, so a row is never rated above moderate (5 or more high hexagons) and keeps one stable id per
// region or hexagon: it is updated each day instead of raising a new record.
// This is evidence about aircraft receivers, not a map of who jams whom: the kind is `interference`, no country is attributed, and the data
// says where aircraft see bad navigation data, nothing about the cause.
import { cellToLatLng, isValidCell } from 'h3-js';
import { safeFetch } from '../utils/fetch.mjs';
import { freshResult, unavailableResult } from '../utils/freshness.mjs';

const SOURCE = 'GPSJam';
const BASE = 'https://gpsjam.org/data';
const REQUEST = Object.freeze({ timeout: 20000, retries: 0, format: 'text', maxBytes: 4 * 1024 * 1024 });
const MAX_ROWS = 120000;
const MIN_AIRCRAFT = 3;
const HIGH_ABOVE = 0.10;
const MEDIUM_ABOVE = 0.02;
const TOP_CELLS = 15;
const CACHE_MS = 3 * 3600000;
const cache = { key: null, text: null, at: 0, fetcher: null };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HEX = /^[0-9a-f]{15}$/;
const REGIONS = Object.freeze([
  ['baltic', 'Baltic Sea', 53, 61, 9, 30.5],
  ['black-sea', 'Black Sea', 40.5, 47.5, 27, 42],
  ['ukraine-russia', 'Ukraine and western Russia', 44, 56, 22, 42],
  ['levant', 'Eastern Mediterranean and Levant', 29, 38, 29, 38],
  ['caucasus', 'Caucasus', 38, 44.5, 40, 51],
  ['gulf', 'Iraq, Iran and the Gulf', 21, 40, 38, 63],
  ['red-sea', 'Red Sea and Horn of Africa', 8, 21, 32, 53],
  ['korea', 'Korean Peninsula', 32, 43, 123, 132],
  ['south-china-sea', 'South China Sea and Taiwan', 4, 27, 104, 123],
  ['central-asia', 'Central and South Asia', 22, 42, 63, 80],
  ['arctic', 'Arctic and Barents Sea', 66, 82, 5, 45],
  ['mediterranean', 'Western and central Mediterranean', 30, 45, -6, 28],
]);
const EXTRAS = {
  attribution: 'GPSJam.org, using ADS-B Exchange data (https://gpsjam.org)',
  rights: 'GPSJam.org publishes its daily hexagon files openly and states that it builds them from ADS-B Exchange data; it publishes no licence text, so the source is cited and only a summary (region counts and the 15 worst hexagons) is shown, never the whole grid.',
  license: 'Provider terms (no licence text published); cite gpsjam.org',
  licenseUrl: null,
  summary: 'GNSS interference seen by aircraft on the latest published UTC day: hexagons (H3 resolution 4, about 1,700 km2) with at least 3 aircraft and more than 10% reporting bad navigation data are HIGH, 2% to 10% MEDIUM. One row per region and the 15 worst hexagons. It shows where aircraft see bad navigation data; it does not say who causes it. The data lags about two days.',
};

function failure(error) {
  const reason = typeof error === 'string' ? error.slice(0, 300).replace(/https?:\/\/\S*/gi, '').trim().slice(0, 120) : '';
  return `GPSJam request failed${reason ? `: ${reason}` : ''}`;
}

/** The newest published, not suspect, day of the manifest ("date,suspect,num_bad_hexes,…"). */
export function latestDay(manifest) {
  if (typeof manifest !== 'string') return null;
  let best = null;
  for (const line of manifest.slice(0, 200000).split(/\r?\n/).slice(0, 5000)) {
    const [day, suspect] = line.split(',');
    if (!DATE.test(day ?? '') || String(suspect).trim() === 'true') continue;
    if (!best || day > best) best = day;
  }
  if (!best) return null;
  const date = new Date(`${best}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === best ? best : null;
}

const regionOf = (lat, lon) => REGIONS.find(([, , south, north, west, east]) => lat >= south && lat <= north && lon >= west && lon <= east) ?? null;
const round1 = value => Math.round(value * 10) / 10;

/** Rows of one day's hexagon file. `day` is the manifest date; the observation time is the end of that UTC day. */
export function parseGpsJam(csv, day, { now = Date.now() } = {}) {
  if (typeof csv !== 'string' || !DATE.test(day ?? '')) return unavailableResult(SOURCE, 'GPSJam returned an unexpected response', EXTRAS, now);
  const lines = csv.split(/\r?\n/);
  if (!/^hex,count_good_aircraft,count_bad_aircraft/.test(lines[0] ?? '') || lines.length > MAX_ROWS) return unavailableResult(SOURCE, 'GPSJam returned an unexpected file', EXTRAS, now);
  const cells = [];
  let read = 0, bad = 0, high = 0, medium = 0, aircraftTotal = 0;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    read++;
    const [hex, good, wrong] = line.split(',');
    const total = Number(good) + Number(wrong);
    if (!HEX.test(hex ?? '') || !Number.isInteger(Number(good)) || !Number.isInteger(Number(wrong)) || Number(good) < 0 || Number(wrong) < 0) { bad++; continue; }
    if (total < MIN_AIRCRAFT) continue;
    aircraftTotal += total;
    const share = Number(wrong) / total;
    if (share <= MEDIUM_ABOVE) continue;
    if (!isValidCell(hex)) { bad++; continue; }
    const level = share > HIGH_ABOVE ? 'high' : 'medium';
    if (level === 'high') high++; else medium++;
    const [lat, lon] = cellToLatLng(hex);
    cells.push({ hex, lat, lon, level, total, wrong: Number(wrong), share });
  }
  if (!read || bad * 10 > read) return unavailableResult(SOURCE, 'GPSJam returned a file in an unexpected shape', EXTRAS, now);
  const observedAt = `${day}T23:59:59Z`;
  const groups = new Map();
  for (const cell of cells) {
    const region = regionOf(cell.lat, cell.lon);
    if (!region) continue;
    const group = groups.get(region[0]) ?? { region, high: 0, medium: 0, latSum: 0, lonSum: 0, worst: 0, aircraft: 0 };
    if (cell.level === 'high') { group.high++; group.latSum += cell.lat; group.lonSum += cell.lon; } else group.medium++;
    group.worst = Math.max(group.worst, cell.share);
    group.aircraft += cell.total;
    groups.set(region[0], group);
  }
  const rows = [];
  for (const group of [...groups.values()].filter(item => item.high > 0).sort((a, b) => b.high - a.high)) {
    const [id, name] = group.region;
    rows.push({ kind: 'interference', providerId: `region:${id}`, source: SOURCE, title: `GNSS interference: ${name}`,
      summary: `On ${day} aircraft reported bad navigation data in ${group.high} high-interference and ${group.medium} medium-interference hexagons in ${name}; at worst ${Math.round(group.worst * 100)}% of the aircraft in one hexagon. This shows where aircraft see bad navigation data, not who causes it.`,
      url: `https://gpsjam.org/?lat=${round1(group.latSum / group.high)}&lon=${round1(group.lonSum / group.high)}&z=5&date=${day}`,
      observedAt, publishedAt: observedAt, lat: round1(group.latSum / group.high), lon: round1(group.lonSum / group.high), locationMethod: 'centroid', locationPrecision: 'approximate',
      region: name, severity: group.high >= 5 ? 'moderate' : 'low',
      highCells: group.high, mediumCells: group.medium, worstPct: Math.round(group.worst * 100) });
  }
  const worst = cells.filter(cell => cell.level === 'high').sort((a, b) => b.wrong * b.share - a.wrong * a.share || (a.hex < b.hex ? -1 : 1)).slice(0, TOP_CELLS);
  for (const cell of worst) {
    const lat = round1(cell.lat), lon = round1(cell.lon);
    rows.push({ kind: 'interference', providerId: `cell:${cell.hex}`, source: SOURCE, title: `GNSS interference hexagon at ${lat.toFixed(1)}, ${lon.toFixed(1)}`,
      summary: `On ${day}, ${cell.wrong} of ${cell.total} aircraft in this hexagon (${Math.round(cell.share * 100)}%) reported bad navigation data.`,
      url: `https://gpsjam.org/?lat=${lat}&lon=${lon}&z=7&date=${day}`, observedAt, publishedAt: observedAt, lat, lon, locationMethod: 'provider', locationPrecision: 'approximate',
      region: regionOf(cell.lat, cell.lon)?.[1] ?? 'Elsewhere', severity: cell.share >= 0.3 && cell.wrong >= 5 ? 'moderate' : 'low',
      badAircraft: cell.wrong, totalAircraft: cell.total, sharePct: Math.round(cell.share * 100) });
  }
  const note = ` Day ${day}: ${high} high and ${medium} medium hexagons of ${read} listed (${aircraftTotal} aircraft counted in hexagons with at least 3).`;
  return freshResult(SOURCE, observedAt, rows, { ...EXTRAS, summary: EXTRAS.summary + note, examinedRecords: read, highHexagons: high, mediumHexagons: medium }, now);
}

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  const request = { ...REQUEST, timeout: Math.max(1, Math.min(REQUEST.timeout, Number(options.timeout) || REQUEST.timeout)) };
  const read = async url => {
    let reply;
    try { reply = await fetcher(url, request); } catch { reply = { error: 'network error' }; }
    return typeof reply?.rawText === 'string' ? reply.rawText : { error: typeof reply?.error === 'string' ? reply.error : 'no text' };
  };
  const manifest = await read(`${BASE}/manifest.csv`);
  if (typeof manifest !== 'string') return unavailableResult(SOURCE, failure(manifest.error), EXTRAS, now);
  const day = latestDay(manifest);
  if (!day) return unavailableResult(SOURCE, 'GPSJam lists no published day', EXTRAS, now);
  if (useCache && cache.key === day && cache.fetcher === fetcher && now >= cache.at && now - cache.at < CACHE_MS) return parseGpsJam(cache.text, day, { now });
  const csv = await read(`${BASE}/${day}-h3_4.csv`);
  if (typeof csv !== 'string') return unavailableResult(SOURCE, failure(csv.error), EXTRAS, now);
  const result = parseGpsJam(csv, day, { now });
  if (useCache && result.status !== 'error') Object.assign(cache, { key: day, text: csv, at: now, fetcher });
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('gpsjam.mjs')) {
  const result = await briefing();
  console.log(JSON.stringify({ ...result, observations: result.observations?.map(row => `${row.severity} ${row.title} [${row.lat},${row.lon}] ${row.highCells ?? ''}`) }, null, 2));
}
