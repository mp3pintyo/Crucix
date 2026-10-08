// Thermal escalation: satellite heat detections (NASA FIRMS) that are unusual for the ground they burn on. The method is World Monitor's thermal escalation
// (koala73/worldmonitor, AGPL-3.0, docs/methodology/thermal-escalation.mdx): detections of a region are grouped into clusters (a detection joins the nearest cluster
// within 20 km), each cluster is compared with what its 0.5 degree cell normally shows over the previous days, and gets a status:
//   persistent  burning 12+ hours and either 3+ detections above the usual or 80+ MW in total
//   spike       a z-score of 2.5+, 6+ detections or 120+ MW above the usual, or 8+ detections with 150+ MW in total
//   elevated    a z-score of 1.5+, 3+ detections or 50+ MW above the usual
// Crucix differences, stated in the panel: (1) the sample is the detections above 10 MW the FIRMS adapter keeps (at most 300 a region, strongest first), not every
// pixel; (2) the baseline is the daily count in the cell on the 2nd to 8th UTC day before now (the last two days are the window under test), kept in
// runs/intelligence/thermal.json, and nothing is reported until 3 of those days were observed (about 5 days after the first sweep): a fire that burns every day
// would otherwise look new; (3) conflict adjacency is the region label (the watched FIRMS regions), not a distance to confirmed events.
// A detection is heat, not a cause: the list is a prompt to look. The store is atomic with a .bak copy; a missing or corrupt file starts empty and never stops a sweep.
import { join } from 'node:path';
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.mjs';
import { militarySiteAt } from './military-sites.mjs';
import { welford } from './anomalies.mjs';

const VERSION = 1;
const HOUR = 3600000;
const DAY = 24 * HOUR;
export const THERMAL = Object.freeze({ clusterKm: 20, cell: 0.5, windowMs: 24 * HOUR, lookbackMs: 48 * HOUR, gapMs: 18 * HOUR, baselineFromDays: 2, baselineToDays: 8, minBaselineDays: 3,
  retentionDays: 30, seenDays: 3, maxCells: 6000, maxPerRegion: 300, stdFloor: 0.5, top: 12,
  persistent: Object.freeze({ hours: 12, countDelta: 3, frp: 80 }), spike: Object.freeze({ z: 2.5, countDelta: 6, frpDelta: 120, count: 8, frp: 150 }), elevated: Object.freeze({ z: 1.5, countDelta: 3, frpDelta: 50 }) });
// The FIRMS regions of the adapter that are conflict regions (South Asia is mostly agriculture and industry).
const CONFLICT_REGIONS = new Set(['Middle East', 'Ukraine', 'Iran', 'Sudan / Horn of Africa', 'Myanmar']);
const RANK = { spike: 0, persistent: 1, elevated: 2 };

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const cellOf = value => Math.round(value / THERMAL.cell) * THERMAL.cell;
const cellKey = (lat, lon) => `${cellOf(lat).toFixed(1)},${cellOf(lon).toFixed(1)}`;
const round1 = value => Math.round(value * 10) / 10;

/** Great-circle distance in kilometres (haversine). */
export function km(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180, dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The detections of the FIRMS result as regions: [{ region, detections: [[lat, lon, frp, atMs]] }]; null when the source did not answer with hotspots. */
export function regionsOf(firms) {
  if (!object(firms) || !Array.isArray(firms.hotspots)) return null;
  return firms.hotspots.filter(h => object(h) && typeof h.region === 'string' && Array.isArray(h.detections)).map(h => ({ region: h.region.slice(0, 60),
    detections: h.detections.slice(0, THERMAL.maxPerRegion).filter(d => Array.isArray(d) && finite(d[0]) && finite(d[1]) && finite(d[2]) && finite(d[3]) && Math.abs(d[0]) <= 90 && Math.abs(d[1]) <= 180 && d[2] > 0) }));
}

/** Greedy clusters of detections sorted by time: each joins the nearest cluster whose centroid is within 20 km, else starts one. */
export function cluster(detections) {
  const clusters = [];
  for (const d of [...detections].sort((a, b) => a[3] - b[3])) {
    let best = null, bestKm = THERMAL.clusterKm;
    for (const c of clusters) {
      const distance = km(c.lat, c.lon, d[0], d[1]);
      if (distance <= bestKm) { best = c; bestKm = distance; }
    }
    if (!best) { best = { lat: d[0], lon: d[1], items: [] }; clusters.push(best); }
    best.items.push(d);
    best.lat = best.items.reduce((s, x) => s + x[0], 0) / best.items.length;
    best.lon = best.items.reduce((s, x) => s + x[1], 0) / best.items.length;
  }
  return clusters;
}

/** Hours the cluster has been burning: the chain of detections back from the newest one with gaps of at most 18 hours. */
export function persistenceHours(times) {
  const sorted = [...times].sort((a, b) => b - a);
  let last = sorted[0], first = sorted[0];
  for (const t of sorted.slice(1)) { if (last - t > THERMAL.gapMs) break; first = t; last = t; }
  return sorted.length ? Math.round((sorted[0] - first) / HOUR) : 0;
}

/** The status of a cluster against its baseline, or 'normal'. */
export function statusOf({ count, frp, z, countDelta, frpDelta, hours }) {
  const p = THERMAL.persistent, s = THERMAL.spike, e = THERMAL.elevated;
  if (hours >= p.hours && (countDelta >= p.countDelta || frp >= p.frp)) return 'persistent';
  if (z >= s.z || countDelta >= s.countDelta || frpDelta >= s.frpDelta || (count >= s.count && frp >= s.frp)) return 'spike';
  if (z >= e.z || countDelta >= e.countDelta || frpDelta >= e.frpDelta) return 'elevated';
  return 'normal';
}

export class ThermalStore {
  #now;

  constructor(runsDir, { now = Date.now } = {}) {
    this.path = join(String(runsDir), 'intelligence', 'thermal.json');
    this.#now = typeof now === 'function' ? now : Date.now;
    this.cells = new Map(); // "lat,lon" -> Map<day, [count, frpSum]>
    this.seen = new Map();  // detection key -> day
    this.since = null;
    this.status = 'empty';
  }

  load() {
    const result = readJsonWithBackup(this.path, { validate: value => object(value) && value.version === VERSION && object(value.cells) });
    this.cells = new Map();
    this.seen = new Map();
    this.since = null;
    const value = result.value;
    if (value) {
      for (const [key, days] of Object.entries(value.cells).slice(0, THERMAL.maxCells)) {
        if (!/^-?\d{1,3}\.\d,-?\d{1,3}\.\d$/.test(key) || !object(days)) continue;
        const map = new Map();
        for (const [day, entry] of Object.entries(days)) if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Array.isArray(entry) && Number.isInteger(entry[0]) && entry[0] > 0 && finite(entry[1])) map.set(day, [entry[0], entry[1]]);
        if (map.size) this.cells.set(key, map);
      }
      for (const [key, day] of Object.entries(object(value.seen) ? value.seen : {})) if (typeof day === 'string') this.seen.set(key, day);
      this.since = finite(value.since) ? value.since : null;
    }
    this.status = result.source === 'primary' ? 'ok' : result.source === 'backup' ? 'recovered' : result.error ? 'corrupt' : 'empty';
    this.#prune(this.#now());
    return this.status;
  }

  /** Count the detections not seen before into their cell and day. Returns how many were new. */
  ingest(regions, { now = this.#now() } = {}) {
    if (this.since === null) this.since = now;
    let added = 0;
    for (const region of Array.isArray(regions) ? regions : []) {
      for (const d of region.detections) {
        if (d[3] > now + 300000 || d[3] < now - THERMAL.seenDays * DAY) continue;
        const key = `${d[0].toFixed(3)}|${d[1].toFixed(3)}|${Math.round(d[3] / 1000)}`;
        if (this.seen.has(key)) continue;
        const day = dayOf(d[3]);
        this.seen.set(key, day);
        const cell = cellKey(d[0], d[1]);
        const days = this.cells.get(cell) ?? new Map();
        const entry = days.get(day) ?? [0, 0];
        entry[0]++; entry[1] += d[2];
        days.set(day, entry);
        this.cells.set(cell, days);
        added++;
      }
    }
    this.#prune(now);
    return added;
  }

  /** `{ ready, observedDays, items }`: items are the escalating clusters, strongest first. */
  assess(regions, { now = this.#now() } = {}) {
    const observedDays = this.since === null ? 0 : Math.max(0, Math.floor((now - this.since) / DAY));
    // The baseline days are the UTC days 2 to 8 back that the store watched from their first minute.
    const days = [];
    if (this.since !== null) for (let back = THERMAL.baselineFromDays; back <= THERMAL.baselineToDays; back++) if (Math.floor((now - back * DAY) / DAY) * DAY >= this.since) days.push(dayOf(now - back * DAY));
    if (days.length < THERMAL.minBaselineDays) return { ready: false, observedDays, items: [] };
    const items = [];
    for (const region of Array.isArray(regions) ? regions : []) {
      const recent = region.detections.filter(d => d[3] >= now - THERMAL.lookbackMs && d[3] <= now + 300000);
      for (const c of cluster(recent)) {
        const current = c.items.filter(d => d[3] >= now - THERMAL.windowMs);
        if (!current.length) continue;
        const count = current.length, frp = current.reduce((s, d) => s + d[2], 0);
        const cellDays = this.cells.get(cellKey(c.lat, c.lon));
        const counts = days.map(day => cellDays?.get(day)?.[0] ?? 0), frps = days.map(day => cellDays?.get(day)?.[1] ?? 0);
        const base = welford(counts), baseFrp = welford(frps);
        const z = (count - base.mean) / Math.max(base.std, THERMAL.stdFloor);
        const hours = persistenceHours(c.items.map(d => d[3]));
        const status = statusOf({ count, frp, z, countDelta: count - base.mean, frpDelta: frp - baseFrp.mean, hours });
        if (status === 'normal') continue;
        const site = militarySiteAt(c.lat, c.lon);
        items.push({ region: region.region, lat: Math.round(c.lat * 100) / 100, lon: Math.round(c.lon * 100) / 100, count, frp: Math.round(frp), status,
          relevance: CONFLICT_REGIONS.has(region.region) && status !== 'elevated' ? 'high' : 'normal', z: round1(z), usual: round1(base.mean), hours, ...(site ? { site: site.name } : {}) });
      }
    }
    items.sort((a, b) => RANK[a.status] - RANK[b.status] || (a.relevance === b.relevance ? 0 : a.relevance === 'high' ? -1 : 1) || b.frp - a.frp);
    return { ready: true, observedDays, items: items.slice(0, THERMAL.top) };
  }

  #prune(now) {
    const oldest = dayOf(now - THERMAL.retentionDays * DAY), seenOldest = dayOf(now - THERMAL.seenDays * DAY);
    for (const [key, day] of this.seen) if (day < seenOldest) this.seen.delete(key);
    for (const [cell, days] of this.cells) {
      for (const day of days.keys()) if (day < oldest) days.delete(day);
      if (!days.size) this.cells.delete(cell);
    }
    if (this.cells.size > THERMAL.maxCells) {
      const newest = cell => [...this.cells.get(cell).keys()].sort().at(-1);
      for (const cell of [...this.cells.keys()].sort((a, b) => (newest(a) < newest(b) ? -1 : 1)).slice(0, this.cells.size - THERMAL.maxCells)) this.cells.delete(cell);
    }
  }

  save(logger = console) {
    this.#prune(this.#now());
    try {
      const cells = {};
      for (const [cell, days] of this.cells) cells[cell] = Object.fromEntries([...days].map(([day, [n, frp]]) => [day, [n, Math.round(frp * 10) / 10]]));
      writeJsonAtomic(this.path, { version: VERSION, since: this.since, cells, seen: Object.fromEntries(this.seen) });
      return true;
    } catch (error) {
      try { logger?.warn?.(`[Thermal] thermal.json not saved (${error instanceof Error ? error.message : String(error)})`); } catch { /* logging never breaks the store */ }
      return false;
    }
  }
}
