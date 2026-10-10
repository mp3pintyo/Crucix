import { readFileSync, existsSync } from 'node:fs';
import { countryByName, countryByNum } from './countries.mjs';
import defaultShapes from '../../dashboard/public/vendor/countries-110m-2.0.2.json' with { type: 'json' };

// Point-in-country over the vendored world-atlas 110m shapes (the same file the dashboard map draws). Small countries and
// islands missing from the 110m layer, and every point at sea, give null.
const SHAPES_URL = new URL('../../dashboard/public/vendor/countries-110m-2.0.2.json', import.meta.url);

let shapes = null;

// TopoJSON arcs are delta-encoded integers; the transform maps them to degrees.
function decodeArcs(topology) {
  const [sx, sy] = topology.transform.scale;
  const [tx, ty] = topology.transform.translate;
  return topology.arcs.map(arc => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; });
  });
}

// A ring is a list of arc indexes; ~i is arc i reversed. Consecutive arcs share their joining point.
// Rings cut at the antimeridian (Russia, Fiji) jump between -180 and 180; such a ring is unwrapped into one continuous
// ring (Chukotka then lies beyond 180) when the jumps cancel out. A ring around a pole (Antarctica) is left as it is.
function ring(arcs, indexes) {
  const points = [];
  for (const index of indexes) {
    const arc = index < 0 ? arcs[~index].slice().reverse() : arcs[index];
    points.push(...(points.length ? arc.slice(1) : arc));
  }
  let offset = 0;
  const jumps = [];
  const unwrapped = points.map(([x, y], i) => {
    if (i > 0) {
      const jump = x - points[i - 1][0];
      if (jump > 180) { offset -= 360; jumps.push(i); } else if (jump < -180) { offset += 360; jumps.push(i); }
    }
    return [x + offset, y];
  });
  if (offset === 0) return unwrapped;
  // A ring around a pole closes along the map edge at that pole instead of across the map.
  if (jumps.length !== 1) return points;
  const at = jumps[0];
  const pole = points.reduce((sum, [, y]) => sum + y, 0) < 0 ? -90 : 90;
  return [...points.slice(0, at), [points[at - 1][0], pole], [points[at][0], pole], ...points.slice(at)];
}

function boxOf(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const points of rings) for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function load() {
  if (shapes) return shapes;
  shapes = [];
  try {
    let topology = defaultShapes;
    if (existsSync(SHAPES_URL)) {
      try {
        topology = JSON.parse(readFileSync(SHAPES_URL, 'utf8'));
      } catch {
        topology = defaultShapes;
      }
    }
    const arcs = decodeArcs(topology);
    for (const geometry of topology.objects.countries.geometries) {
      // Three shapes carry no ISO numeric id (N. Cyprus, Somaliland, Kosovo): their name resolves them instead.
      const country = (geometry.id !== undefined ? countryByNum(geometry.id) : null) ?? countryByName(geometry.properties?.name);
      if (!country) continue;
      const polygons = geometry.type === 'Polygon' ? [geometry.arcs] : geometry.type === 'MultiPolygon' ? geometry.arcs : [];
      for (const polygon of polygons) {
        const rings = polygon.map(indexes => ring(arcs, indexes));
        shapes.push({ iso3: country.iso3, rings, box: boxOf(rings) });
      }
    }
  } catch { shapes = []; }
  return shapes;
}

// Even-odd ray casting over all rings of one polygon (holes included).
function inside(rings, x, y) {
  let hit = false;
  for (const points of rings) {
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i], [xj, yj] = points[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

/** The ISO3 code of the country containing (lat, lon), or null (at sea, off the 110m layer, or bad input). Never throws. */
export function countryAt(lat, lon) {
  try {
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) return null;
    const x = ((lon + 180) % 360 + 360) % 360 - 180;
    for (const shape of load()) {
      const [minX, minY, maxX, maxY] = shape.box;
      if (lat < minY || lat > maxY) continue;
      // An unwrapped ring may extend past ±180: try the point one turn east or west as well.
      for (const px of [x, x + 360, x - 360]) {
        if (px >= minX && px <= maxX && inside(shape.rings, px, lat)) return shape.iso3;
      }
    }
    return null;
  } catch { return null; }
}
