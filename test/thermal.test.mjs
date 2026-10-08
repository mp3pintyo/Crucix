import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThermalStore, THERMAL, km, cluster, persistenceHours, statusOf, regionsOf } from '../lib/intelligence/thermal.mjs';
import { EntityStore } from '../lib/intelligence/entities.mjs';
import { runRiskStep } from '../lib/intelligence/risk-step.mjs';
import { firmsTime } from '../apis/sources/firms.mjs';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-08T12:30:00Z');
const quiet = { warn() {}, error() {}, log() {}, info() {} };
const tempDir = t => { const dir = mkdtempSync(join(tmpdir(), 'crucix-th-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
// A detection [lat, lon, frp, atMs]; `n` copies spread a few hundred metres apart and 20 minutes apart.
const burst = (lat, lon, at, n, frp = 20) => Array.from({ length: n }, (_, i) => [lat + i * 0.002, lon + i * 0.002, frp, at + i * 20 * 60000]);
const regionOf = (detections, region = 'Ukraine') => [{ region, detections }];

test('thermal: distances, clusters within 20 km, persistence chains, the status rules and the FIRMS time all behave', () => {
  assert.ok(Math.abs(km(50, 30, 50, 30.1) - 7.15) < 0.3);
  const groups = cluster([[50, 30, 20, 1], [50.05, 30.05, 20, 2], [51, 31, 20, 3]]);
  assert.deepEqual(groups.map(g => g.items.length).sort(), [1, 2]);
  assert.equal(persistenceHours([NOW, NOW - 10 * HOUR, NOW - 20 * HOUR]), 20);
  assert.equal(persistenceHours([NOW, NOW - 30 * HOUR]), 0, 'a gap above 18 hours breaks the chain');
  const base = { count: 3, frp: 40, z: 0, countDelta: 0, frpDelta: 0, hours: 0 };
  assert.deepEqual([statusOf(base), statusOf({ ...base, z: 1.6 }), statusOf({ ...base, z: 2.6 }), statusOf({ ...base, hours: 13, countDelta: 3 }), statusOf({ ...base, count: 8, frp: 150 })], ['normal', 'elevated', 'spike', 'persistent', 'spike']);
  assert.equal(firmsTime('2026-10-08', '0535'), Date.parse('2026-10-08T05:35:00Z'));
  assert.ok(Number.isNaN(firmsTime('x', '1')));
});

test('thermal store: nothing is reported until three baseline days were watched; then a cell that burns every day is normal and a new burst is a spike', t => {
  const store = new ThermalStore(tempDir(t), { now: () => NOW });
  const usual = [50, 30], fresh = [48, 36];
  // One sweep a day for seven days: the usual cell has 5 detections a day.
  for (let back = 6; back >= 1; back--) {
    const now = NOW - back * DAY;
    store.ingest(regionOf(burst(usual[0], usual[1], now - 3 * HOUR, 5)), { now });
    if (back === 4) assert.deepEqual(store.assess(regionOf([]), { now }), { ready: false, observedDays: 2, items: [] }, 'too early');
  }
  const detections = [...burst(usual[0], usual[1], NOW - 5 * HOUR, 5), ...burst(fresh[0], fresh[1], NOW - 4 * HOUR, 7, 30)];
  store.ingest(regionOf(detections), { now: NOW });
  const result = store.assess(regionOf(detections), { now: NOW });
  assert.equal(result.ready, true);
  assert.equal(result.items.length, 1, 'the cell that burns every day is not reported');
  const [spike] = result.items;
  assert.deepEqual([spike.status, spike.count, spike.relevance, Math.round(spike.lat)], ['spike', 7, 'high', 48]);
  const elsewhere = store.assess(regionOf(detections, 'South Asia'), { now: NOW });
  assert.equal(elsewhere.items[0].relevance, 'normal', 'South Asia is not a conflict region');
});

test('thermal store: a detection seen in two sweeps counts once; the file survives a round trip; a corrupt file starts empty', t => {
  const dir = tempDir(t);
  const store = new ThermalStore(dir, { now: () => NOW });
  const d = regionOf(burst(50, 30, NOW - 2 * HOUR, 3));
  assert.equal(store.ingest(d, { now: NOW }), 3);
  assert.equal(store.ingest(d, { now: NOW + 15 * 60000 }), 0);
  assert.equal(store.save(quiet), true);
  const again = new ThermalStore(dir, { now: () => NOW });
  assert.equal(again.load(), 'ok');
  assert.equal(again.ingest(d, { now: NOW }), 0, 'the seen keys came back');
  assert.equal(again.cells.size, store.cells.size);
  mkdirSync(join(dir, 'intelligence'), { recursive: true });
  writeFileSync(join(dir, 'intelligence', 'thermal.json'), '{ not json');
  writeFileSync(join(dir, 'intelligence', 'thermal.json.bak'), 'also broken');
  const broken = new ThermalStore(dir, { now: () => NOW });
  assert.notEqual(broken.load(), 'ok');
  assert.equal(broken.cells.size, 0);
});

test('thermal: only well-formed detections of a FIRMS answer with hotspots are taken, at most 300 a region', () => {
  assert.equal(regionsOf(null), null);
  assert.equal(regionsOf({ hotspots: 'x' }), null);
  const regions = regionsOf({ hotspots: [{ region: 'Ukraine', detections: [[50, 30, 20, NOW], [99, 30, 20, NOW], ['x', 1, 1, 1], [50, 30, -1, NOW], ...Array.from({ length: 400 }, (_, i) => [50 + i / 1000, 30, 20, NOW])] }, { region: 'No detections' }, { error: 'x' }] });
  assert.equal(regions.length, 1);
  assert.equal(regions[0].detections.length, THERMAL.maxPerRegion - 3, 'invalid rows dropped, the rest capped at 300 before filtering');
});

test('the risk step carries the thermal result into the summary, and a failing thermal store leaves the rest of the step alone', t => {
  const dir = tempDir(t);
  const entities = new EntityStore(dir, { retentionDays: 35 });
  const thermal = new ThermalStore(dir, { now: () => NOW });
  const raw = { sources: { FIRMS: { hotspots: [{ region: 'Ukraine', detections: burst(50, 30, NOW - HOUR, 3) }] } } };
  const snapshot = { events: [] };
  assert.equal(runRiskStep({ store: entities, thermal, snapshot, raw, now: NOW, log: quiet }).ok, true);
  assert.deepEqual([snapshot.risk.thermal.ready, snapshot.risk.thermal.items], [false, []]);
  const noFirms = { events: [] };
  runRiskStep({ store: entities, thermal, snapshot: noFirms, raw: { sources: {} }, now: NOW, log: quiet });
  assert.equal(noFirms.risk.thermal, undefined, 'without FIRMS data the section is left out');
  const second = { events: [] };
  const broken = { ingest() { throw new Error('disk full at C:\\secret'); } };
  assert.equal(runRiskStep({ store: entities, thermal: broken, snapshot: second, raw, now: NOW, log: quiet }).ok, true);
  assert.ok(second.risk && second.risk.thermal === undefined);
});

const read = path => readFileSync(new URL(`../dashboard/public/${path}`, import.meta.url), 'utf8');
function panel() {
  const window = {};
  vm.runInContext(read('risk.js'), vm.createContext({ window, document: {}, Intl, console }));
  return window.CrucixRisk;
}
const baseRisk = { version: 2, at: new Date(NOW).toISOString(), top: [{ iso3: 'JPN', name: 'Japan', score: 40, change24h: null, coverage: 0.8, convergence: { active: false, kinds: [] } }], counts: { scored: 1, high: 0 }, calibration: null };

test('the country-risk panel lists the heat clusters, escaped and cut; not ready and empty states are explained; an older summary shows nothing', () => {
  const risk = panel();
  const html = risk.panelHtml({ ...baseRisk, thermal: { ready: true, observedDays: 9, items: [
    { region: '<img onerror=x>Ukraine', lat: 48.45, lon: 37.8, count: 7, frp: 210, status: 'spike', relevance: 'high', usual: 0.4, hours: 14, site: 'Test <b>base</b>' },
    { region: 'Bad', lat: 'x', lon: 1, count: 1, frp: 1, status: 'spike' }, { region: 'Odd', lat: 1, lon: 1, count: 1, frp: 1, status: 'weird' }] } }, { replay: false });
  assert.ok(html.includes('Thermal escalation') && html.includes('Spike') && /7 detections, 210 MW, usually 0[.,]4 a day/.test(html) && html.includes('data-level="critical"'));
  assert.ok(!html.includes('<img') && !html.includes('<b>base') && !html.includes('>Bad<') && !html.includes('>Odd<'));
  assert.ok(risk.panelHtml({ ...baseRisk, thermal: { ready: false, observedDays: 2, items: [] } }, { replay: false }).includes('Collecting a baseline: 2 of about 5 days'));
  assert.ok(risk.panelHtml({ ...baseRisk, thermal: { ready: true, observedDays: 9, items: [] } }, { replay: false }).includes('No heat cluster stands out'));
  assert.ok(!risk.panelHtml(baseRisk, { replay: false }).includes('Thermal escalation'));
});
