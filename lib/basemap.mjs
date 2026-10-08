// The daily globe basemap: NASA GIBS' VIIRS (NOAA-20) true-colour image of the whole Earth for the previous UTC day, fetched once a day through the
// Worldview Snapshots service (keyless, public domain NASA data; checked live on 2026-10-08 from Hungary: a 4096 x 2048 JPEG is about 2 MB and takes
// 3-8 s, so it is cached here and served from memory). Yesterday is used because the current day's swaths are incomplete; if yesterday is not yet
// available the day before is tried. The image has gaps between orbits and black polar caps; it is a daily composite, not live.
// The idea comes from God's Eye View (bilawalsidhu/gods-eye-view, MIT).
import { readBoundedBytes } from '../apis/utils/fetch.mjs';

export const GIBS_LAYER = 'VIIRS_NOAA20_CorrectedReflectance_TrueColor';
const ENDPOINT = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot';
const MAX_BYTES = 8 * 1024 * 1024;
const MIN_BYTES = 50 * 1024;
const DAY_MS = 86400000;

export const dayOffset = (now, days) => new Date(now - days * DAY_MS).toISOString().slice(0, 10);
export function snapshotUrl(day) {
  return `${ENDPOINT}?${new URLSearchParams({ REQUEST: 'GetSnapshot', LAYERS: GIBS_LAYER, CRS: 'EPSG:4326', TIME: day, WRAP: 'DAY', BBOX: '-90,-180,90,180', FORMAT: 'image/jpeg', WIDTH: '4096', HEIGHT: '2048' })}`;
}
const isJpeg = buffer => buffer.length >= MIN_BYTES && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;

/** A cache of the daily image: get() resolves { day, buffer, stale }; concurrent calls share one download; an old image serves when a refresh fails. */
export function createDailyBasemap({ fetchImpl = fetch, now = Date.now, timeoutMs = 45000 } = {}) {
  let cache = null, pending = null;
  async function download(day) {
    const response = await fetchImpl(snapshotUrl(day), { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Crucix/2.x' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await readBoundedBytes(response, MAX_BYTES);
    if (!isJpeg(buffer)) throw new Error('not a usable JPEG');
    return { day, buffer };
  }
  async function refresh() {
    let last;
    for (const days of [1, 2]) {
      try { return await download(dayOffset(now(), days)); } catch (error) { last = error; }
    }
    throw last;
  }
  return {
    async get() {
      const wanted = dayOffset(now(), 1);
      if (cache && cache.day >= wanted) return { ...cache, stale: false };
      pending ??= refresh().then(image => { cache = image; return image; }).finally(() => { pending = null; });
      try { return { ...(await pending), stale: false }; } catch (error) {
        if (cache) return { ...cache, stale: true };
        throw error;
      }
    },
  };
}
