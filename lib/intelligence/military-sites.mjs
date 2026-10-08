// Mapped military areas (data/sites.json, built from God's Eye View / OpenStreetMap / Overture, ODbL) as a lookup for the server: is a
// point on, or right next to, a named military area? Used for FIRMS thermal detections. Loaded once and indexed on a 1-degree grid;
// a missing or damaged file means "no match anywhere", never an error.
import { readFileSync } from 'node:fs';

const FILE = new URL('../../dashboard/public/data/sites.json', import.meta.url);
const MARGIN_DEG = 0.01; // about 1 km: a detection beside the fence still counts
let index;

function build() {
  const grid = new Map();
  let doc;
  try { doc = JSON.parse(readFileSync(FILE, 'utf8')); } catch { return grid; }
  if (!doc || !Array.isArray(doc.military)) return grid;
  const classes = Array.isArray(doc.classes) ? doc.classes : [];
  for (const row of doc.military) {
    if (!Array.isArray(row) || row.length !== 9 || typeof row[0] !== 'string') continue;
    const [name, , , w, s, e, n, cls, area] = row;
    if (![w, s, e, n, area].every(Number.isFinite)) continue;
    const site = { name, kind: classes[cls] || '', areaKm2: area, box: [w - MARGIN_DEG, s - MARGIN_DEG, e + MARGIN_DEG, n + MARGIN_DEG] };
    for (let x = Math.floor(site.box[0]); x <= Math.floor(site.box[2]); x++) {
      for (let y = Math.floor(site.box[1]); y <= Math.floor(site.box[3]); y++) {
        const key = x + ',' + y;
        const list = grid.get(key);
        if (list) list.push(site); else grid.set(key, [site]);
      }
    }
  }
  return grid;
}

/** The smallest mapped military area containing (or within about 1 km of) the point, or null. */
export function militarySiteAt(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  index ??= build();
  let best = null;
  for (const site of index.get(Math.floor(lon) + ',' + Math.floor(lat)) || []) {
    const [w, s, e, n] = site.box;
    if (lon >= w && lon <= e && lat >= s && lat <= n && (!best || site.areaKm2 < best.areaKm2)) best = site;
  }
  return best ? { name: best.name, kind: best.kind, areaKm2: best.areaKm2 } : null;
}

export function resetMilitarySites() { index = undefined; }
