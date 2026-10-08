// Current 10 m wind at the six watched nuclear sites (the Safecast sites), from Open-Meteo's current-conditions model. One request for all six points:
// https://api.open-meteo.com/v1/forecast?latitude=a,b,..&longitude=..&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=ms&timezone=GMT
// (no key; checked live on 2026-10-08 from Hungary: HTTP 200, 0.2 s; values every 15 minutes). The idea (a wind reading at a point of interest) comes from God's
// Eye View (bilawalsidhu/gods-eye-view, MIT), which animates GFS/ECMWF wind fields; Crucix takes only this reading, not the heavy GRIB2 decoding.
// Open-Meteo's data is CC BY 4.0 and free for non-commercial use (a commercial deployment needs an API key from open-meteo.com).
// A row says where the wind blows FROM and TO at a site. It is NOT a dispersion forecast: nothing here models a release, its height or its fall-out.
import { safeFetch } from '../utils/fetch.mjs';
import { providerTime, freshResult, unavailableResult } from '../utils/freshness.mjs';
import { NUCLEAR_SITES } from './safecast.mjs';

const SOURCE = 'Open-Meteo-Wind';
const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const PAGE = 'https://open-meteo.com/';
const REQUEST = Object.freeze({ timeout: 12000, retries: 0, maxBytes: 256 * 1024, headers: Object.freeze({ 'User-Agent': 'Crucix/2.x' }) });
const CACHE_MS = 10 * 60000;
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const state = { at: 0, result: null };
const EXTRAS = {
  attribution: 'Weather data by Open-Meteo.com (https://open-meteo.com)',
  rights: 'Open-Meteo data is licensed CC BY 4.0 and free for non-commercial use; a commercial deployment needs an API key. The values are modelled current conditions, not station measurements.',
  license: 'CC BY 4.0 (Open-Meteo.com)',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  summary: 'Modelled current 10 m wind (speed, direction it blows from and toward, gusts) at the watched nuclear sites. Not a dispersion forecast.'
};

const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const compass = deg => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
const r1 = value => Math.round(value * 10) / 10;

/** The site table as [{ key, label, lat, lon }], from the Safecast sites. */
export function sites() {
  return Object.entries(NUCLEAR_SITES).map(([key, site]) => ({ key, label: site.label, lat: site.lat, lon: site.lon }));
}

export function parseWind(answer, list = sites(), now = Date.now()) {
  const items = Array.isArray(answer) ? answer : answer && typeof answer === 'object' && !answer.error ? [answer] : null;
  if (!items || items.length !== list.length) return unavailableResult(SOURCE, 'Open-Meteo returned an unexpected response', EXTRAS, now);
  const rows = [];
  let newest = 0;
  items.forEach((item, index) => {
    const site = list[index], current = item?.current;
    const speed = num(current?.wind_speed_10m), from = num(current?.wind_direction_10m), gust = num(current?.wind_gusts_10m);
    // Open-Meteo writes the time without seconds ("2026-10-08T07:00"), in GMT because the request asks for it.
    const at = providerTime(typeof current?.time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(current.time) ? `${current.time}:00` : null, { assumeUTC: true });
    if (!site || speed === null || from === null || speed < 0 || speed > 120 || from < 0 || from > 360 || !at || Date.parse(at) - now > 300000) return;
    const to = (from + 180) % 360;
    newest = Math.max(newest, Date.parse(at));
    rows.push({ kind: 'weather', providerId: `wind:${site.key}`, source: SOURCE,
      title: `Wind at ${site.label}: ${r1(speed)} m/s from ${compass(from)}`,
      summary: `Modelled 10 m wind at ${site.label}: ${r1(speed)} m/s${gust !== null ? ` (gusts ${r1(gust)} m/s)` : ''} from ${compass(from)} (${Math.round(from)}°), blowing toward ${compass(to)} (${Math.round(to)}°). This is the current wind at one point, not a dispersion forecast: it does not model any release.`,
      url: `${PAGE}en/docs`, observedAt: at, publishedAt: at, severity: 'info',
      lat: site.lat, lon: site.lon, locationMethod: 'configured-point', locationPrecision: 'exact', place: site.label,
      windMs: r1(speed), windFromDeg: Math.round(from), windTowardDeg: Math.round(to), windToward: compass(to), ...(gust !== null ? { windGustMs: r1(gust) } : {}) });
  });
  if (!rows.length) return unavailableResult(SOURCE, 'Open-Meteo returned no usable wind reading', EXTRAS, now);
  return freshResult(SOURCE, new Date(newest).toISOString(), rows, { ...EXTRAS, examinedRecords: items.length }, now);
}

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  if (useCache && state.result && now >= state.at && now - state.at < CACHE_MS) return state.result;
  const list = sites();
  const url = `${ENDPOINT}?${new URLSearchParams({ latitude: list.map(s => s.lat).join(','), longitude: list.map(s => s.lon).join(','), current: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m', wind_speed_unit: 'ms', timezone: 'GMT' })}`;
  let answer;
  try {
    answer = await fetcher(url, { ...REQUEST, timeout: Math.max(1, Math.min(REQUEST.timeout, Number(options.timeout) || REQUEST.timeout)) });
    if (answer?.error) throw new Error(String(answer.error));
  } catch (error) {
    const reason = (error instanceof Error ? error.message : '').replace(/https?:\/\/\S*/gi, '').trim().slice(0, 120);
    return unavailableResult(SOURCE, `Open-Meteo request failed${reason ? `: ${reason}` : ''}`, EXTRAS, now);
  }
  const result = parseWind(answer, list, now);
  if (useCache && result.status !== 'error') { state.at = now; state.result = result; }
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('openmeteo-wind.mjs')) {
  const result = await briefing();
  console.log(JSON.stringify({ ...result, observations: result.observations?.map(row => `${row.title} | toward ${row.windToward} | ${row.observedAt}`) }, null, 2));
}
