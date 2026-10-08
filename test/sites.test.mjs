import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { militarySiteAt } from '../lib/intelligence/military-sites.mjs';
import { synthesize } from '../dashboard/inject.mjs';

const root = new URL('../dashboard/public/', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const load = () => { const window = {}; vm.runInContext(read('infrastructure.js'), vm.createContext({ window, Math, Number, Object, Array, JSON, Promise, String })); return window.CrucixInfrastructure; };

test('the shipped sites file parses whole: military areas, data centres, dams, ODbL attribution, under 1 MB', () => {
  const api = load();
  const doc = JSON.parse(read('data/sites.json'));
  const data = api.parseSites(doc);
  assert.equal(data.military.length, doc.military.length, 'no military area is dropped');
  assert.equal(data.datacenters.length, doc.datacenters.length);
  assert.equal(data.dams.length, doc.dams.length);
  assert.ok(data.military.length > 5000 && data.datacenters.length > 3000 && data.dams.length > 500);
  assert.ok(data.military.every(site => site.box[0] <= site.box[2] && site.box[1] <= site.box[3]));
  assert.match(data.sources.military, /ODbL/);
  assert.ok(statSync(new URL('data/sites.json', root)).size < 1024 * 1024);
});

test('parseSites cuts damaged rows and refuses a wrong document; the load is one request and a failure is remembered', async () => {
  const api = load();
  const data = api.parseSites({
    classes: ['airfield'],
    military: [['Fort X', 10, 50, 9.9, 49.9, 10.1, 50.1, 0, 12.5], ['No box', 10, 50], ['Flipped', 10, 50, 11, 49, 9, 51, 0, 1], ['Far', 10, 999, 9, 49, 11, 51, 0, 1]],
    datacenters: [[10, 50, 'DC One', 'Op'], [10, 50]], dams: [[10, 50, 'Dam', 'hydro', '330KW']],
  });
  assert.deepEqual(plain(data.military.map(site => site.name)), ['Fort X']);
  assert.equal(data.datacenters.length, 1);
  assert.equal(api.parseSites({ military: [], datacenters: [] }), null, 'a document without dams is refused');
  let calls = 0;
  assert.equal(await api.loadSites(() => { calls++; return Promise.reject(new Error('down')); }), null);
  assert.equal(await api.loadSites(() => { calls++; return Promise.resolve({}); }), null);
  assert.equal(calls, 1, 'a failure is remembered for the life of the page');
});

test('nearbySites: inside a military area is 0 km, others are nearest first and capped; an unloaded dataset finds nothing', async () => {
  const api = load();
  assert.deepEqual(plain(api.nearbySites(50, 10, 200, 3)), { military: [], datacenters: [], dams: [] });
  await api.loadSites(() => Promise.resolve(JSON.parse(read('data/sites.json'))));
  const found = api.nearbySites(38.5438, -89.8528, 200, 3);                  // Scott Air Force Base, Illinois
  assert.equal(found.military[0].km, 0);
  assert.match(found.military[0].item.name, /Scott/);
  assert.ok(found.military.length <= 3 && found.military.every((entry, i, all) => !i || all[i - 1].km <= entry.km));
  assert.ok(found.datacenters.every(entry => entry.km <= 200));
  assert.match(api.siteText(found.military[0].item, null), /OpenStreetMap/);
});

test('militarySiteAt (server): a point on a mapped area matches, the open sea and bad input do not', () => {
  assert.match(militarySiteAt(38.5438, -89.8528)?.name || '', /Scott/);
  assert.equal(militarySiteAt(0, -30), null);
  assert.equal(militarySiteAt(NaN, 10), null);
  assert.equal(militarySiteAt(95, 10), null);
});

test('a FIRMS detection on a mapped military area is marked in the thermal rows and raises one signal; one elsewhere raises none', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-sites-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hotspot = fires => ({ region: 'Test region', totalDetections: 9, nightDetections: 3, highConfidence: 2, highIntensity: fires });
  const run = fires => synthesize({ crucix: { timestamp: '2026-10-08T12:00:00Z' }, sources: { FIRMS: { hotspots: [hotspot(fires)], signals: [] } } }, { news: [], runsDir: dir });
  const on = await run([{ lat: 38.5438, lon: -89.8528, frp: 55 }, { lat: 0, lon: -30, frp: 20 }]);
  assert.match(on.thermal[0].fires[0].site, /Scott/);
  assert.equal(on.thermal[0].fires[1].site, undefined);
  const mine = on.tSignals.filter(signal => /mapped military areas/.test(signal));
  assert.equal(mine.length, 1);
  assert.match(mine[0], /1 high-intensity thermal detection \(top 55 MW\)/);
  const off = await run([{ lat: 0, lon: -30, frp: 20 }]);
  assert.equal(off.tSignals.filter(signal => /mapped military areas/.test(signal)).length, 0);
});
