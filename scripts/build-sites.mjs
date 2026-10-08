// Builds dashboard/public/data/sites.json: mapped military areas, data centres and dams, from the God's Eye View repository
// (bilawalsidhu/gods-eye-view, MIT code; the datasets are OpenStreetMap / Overture, ODbL 1.0). Usage:
//   node scripts/build-sites.mjs <path to a gods-eye-view checkout>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) { console.error('usage: node scripts/build-sites.mjs <gods-eye-view checkout>'); process.exit(1); }
const local = join(root, 'src', 'data', 'local_data');
const r3 = n => Math.round(n * 1000) / 1000;
const clean = s => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70) : '');

const names = JSON.parse(readFileSync(join(local, 'osm_military_names', 'names.json'), 'utf8'));
const wanted = new Set(['airfield', 'naval_base', 'base']);
const military = names.records
  .filter(r => r[9] >= 1e6 || (wanted.has(names.classes[r[8]]) && r[9] >= 1.5e5))
  .map(r => [clean(r[1]), r3(r[2]), r3(r[3]), r3(r[4]), r3(r[5]), r3(r[6]), r3(r[7]), r[8], Math.round(r[9] / 1e4) / 100])
  .filter(r => r[0]);

function bboxCentre(geometry) {
  let w = 181, s = 91, e = -181, n = -91;
  (function walk(c) { if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(walk); })(geometry.coordinates);
  return w > e ? null : [r3((w + e) / 2), r3((s + n) / 2)];
}
function readLines(file) { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }

const datacenters = [];
for (const f of readLines(join(local, 'datacenters', 'datacenters.geojsonl'))) {
  const tags = f.properties?.tags || {}, c = bboxCentre(f.geometry);
  const name = clean(tags.name), operator = clean(tags.operator || tags['operator:short']);
  if (c && (name || operator)) datacenters.push([c[0], c[1], name || operator, name ? operator : '']);
}
const dams = [];
for (const f of readLines(join(local, 'dams', 'dams.geojsonl'))) {
  const p = f.properties || {}, c = bboxCentre(f.geometry), name = clean(p.name);
  if (c && name) dams.push([c[0], c[1], name, clean(p.source || '') , clean(p.output || '')]);
}

const doc = {
  version: 1, builtAt: new Date().toISOString().slice(0, 10), classes: names.classes,
  sources: {
    military: 'Named military areas: OpenStreetMap contributors via the Overture Maps Foundation (release ' + names.release + '), ODbL 1.0; compiled for God\u2019s Eye View (bilawalsidhu/gods-eye-view). Mapped areas, not a statement about use or garrison.',
    datacenters: 'Data centres: OpenStreetMap contributors, ODbL 1.0, via God\u2019s Eye View. Incomplete by nature.',
    dams: 'Dams: OpenStreetMap contributors / Open Infrastructure Map, ODbL 1.0, via God\u2019s Eye View. Incomplete by nature.',
  },
  military, datacenters, dams,
};
const out = join(import.meta.dirname, '..', 'dashboard', 'public', 'data', 'sites.json');
writeFileSync(out, JSON.stringify(doc));
console.log('military', military.length, 'datacenters', datacenters.length, 'dams', dams.length, '->', out);
