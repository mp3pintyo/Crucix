import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, statSync } from 'node:fs';

const root = new URL('../dashboard/public/', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const realDocument = () => JSON.parse(read('data/infrastructure.json'));
const plain = value => JSON.parse(JSON.stringify(value)); // objects made inside the vm context have another prototype
const load = () => { const window = {}; vm.runInContext(read('infrastructure.js'), vm.createContext({ window, Math, Number, Object, Array, JSON, Promise, String })); return window.CrucixInfrastructure; };

test('the shipped dataset parses whole: pipelines and bases with valid points, states, attribution and a modest size', () => {
  const api = load();
  const doc = realDocument();
  const data = api.parse(doc);
  assert.equal(data.pipelines.length, doc.pipelines.length, 'no pipeline is dropped');
  assert.equal(data.bases.length, doc.bases.length, 'no base is dropped');
  assert.ok(data.pipelines.length > 600 && data.bases.length > 200);
  assert.ok(data.pipelines.every(pipe => ['flowing', 'reduced', 'offline', 'unknown'].includes(pipe.state) && ['o', 'g'].includes(pipe.kind)));
  assert.ok(data.pipelines.some(pipe => pipe.state === 'offline' && pipe.statement), 'an offline pipeline carries its statement');
  assert.match(data.sources.pipelines, /Global Energy Monitor/);
  assert.match(data.sources.bases, /World Monitor/);
  assert.ok(statSync(new URL('data/infrastructure.json', root)).size < 300 * 1024);
});

test('geometry: great circle ends, haversine distance, and distance to a segment (inside, beyond an end, the nearer end)', () => {
  const api = load();
  const line = api.greatCircle([47.5, 19], [48.2, 16.4], 8);
  assert.equal(line.length, 9);
  assert.deepEqual([line[0][0], line[0][1]], [47.5, 19]);
  assert.ok(Math.abs(line[8][0] - 48.2) < 1e-9 && Math.abs(line[8][1] - 16.4) < 1e-9);
  assert.ok(Math.abs(api.distanceKm(0, 0, 1, 0) - 111.19) < 0.05, 'one degree of latitude');
  assert.ok(Math.abs(api.distanceKm(0, 0, 0, 180) - 20015.1) < 1, 'half a great circle');
  const segment = [0, 0, 0, 10];                                        // along the equator
  assert.ok(Math.abs(api.distanceToLineKm(1, 5, segment) - 111.2) < 1.5, 'one degree north of the middle');
  assert.ok(Math.abs(api.distanceToLineKm(0, 12, segment) - api.distanceKm(0, 10, 0, 12)) < 0.5, 'beyond the end: the distance to the end point');
  assert.ok(Math.abs(api.distanceToLineKm(0, -3, segment) - api.distanceKm(0, 0, 0, -3)) < 0.5, 'before the start');
  assert.equal(Math.round(api.distanceToLineKm(0, 5, segment)), 0);
});

test('nearby: the closest pipelines and bases around the Strait of Hormuz, nearest first, capped, empty for bad input', async () => {
  const api = load();
  await api.load(async () => realDocument());
  const near = api.nearby(26.5, 56.3, 600, 3);
  assert.equal(near.pipelines.length, 3);
  assert.ok(near.pipelines[0].km <= near.pipelines[1].km && near.pipelines[1].km <= near.pipelines[2].km);
  assert.ok(near.pipelines[0].km < 40, near.pipelines[0].item.name);
  assert.ok(near.bases.length >= 1 && near.bases.every(entry => entry.km <= 600));
  assert.deepEqual(plain(api.nearby(95, 0, 100)), { pipelines: [], bases: [] });
  assert.deepEqual(plain(api.nearby(10, 10, -5)), { pipelines: [], bases: [] });
  assert.ok(api.nearby(0, 0, 100000, 500).pipelines.length <= 50, 'the cap is 50');
});

test('load: a failed request is remembered, a damaged file draws nothing, hostile fields are cleaned', async () => {
  let calls = 0;
  const failing = load();
  assert.equal(await failing.load(async () => { calls++; throw new Error('HTTP 404'); }), null);
  assert.equal(await failing.load(async () => { calls++; return realDocument(); }), null, 'a failure is not retried in the page');
  assert.equal(calls, 1);
  const api = load();
  assert.equal(api.parse(null), null);
  assert.equal(api.parse({ pipelines: 'x', bases: [] }), null);
  const cleaned = api.parse({ sources: {}, pipelines: [
    { id: 'a', n: '<img onerror=x>Pipe', c: 'o', a: 'RUS', b: 'DEU', v: ['BLR', 'x', '<b>'], ps: 'weird', p: [1, 2, 3, 4], s: 'text <script>' },
    { id: 'b', n: 'No points', c: 'g', p: [99, 0, 0, 0] }, { id: 'c', n: 'Bad kind', c: 'z', p: [1, 2, 3, 4] }, null, 5,
  ], bases: [{ id: 'x', n: 'Base', lat: 10, lon: 20, f: 'uk' }, { id: 'y', n: 'Off map', lat: 100, lon: 0 }] });
  assert.equal(cleaned.pipelines.length, 1);
  const pipe = cleaned.pipelines[0];
  assert.deepEqual(plain([pipe.name, pipe.state, pipe.via, pipe.statement]), ['img onerror=x Pipe', 'unknown', ['BLR'], 'text script']);
  assert.equal(cleaned.bases.length, 1);
});

test('popup text is plain, translated through the page function, and states the line is not the route', async () => {
  const api = load();
  await api.load(async () => realDocument());
  const data = api.get();
  const offline = data.pipelines.find(pipe => pipe.state === 'offline' && pipe.capacity !== null);
  const english = api.pipelineText(offline, (key, fallback) => fallback);
  assert.match(english, /From [A-Z]{2,3} to [A-Z]{2,3}/);
  assert.match(english, /Capacity .* (million barrels a day|billion cubic metres a year)/);
  assert.match(english, /not the physical route/);
  assert.ok(!/[<>]/.test(english) && !english.includes('{'));
  const hungarian = api.pipelineText(offline, (key, fallback) => ({ 'infra.lineNote': 'főkör' })[key] ?? fallback);
  assert.match(hungarian, /főkör/);
  assert.match(api.baseText(data.bases[0], (key, fallback) => fallback), /not a statement about the current garrison/);
});

test('the page, the service worker and the workspace profiles know the layers; both start switched off', () => {
  const html = read('jarvis.html');
  assert.ok(html.indexOf('<script src="infrastructure.js"></script>') > 0);
  assert.ok(read('sw.js').includes("'/infrastructure.js'"));
  const registry = html.slice(html.indexOf('const mapLayerRegistry'), html.indexOf('let mapLayers'));
  assert.match(registry, /\{id:'pipelines',[^}]*types:\['pipeline'\],off:true\}/);
  assert.match(registry, /\{id:'bases',[^}]*types:\['base'\],off:true\}/);
  assert.match(html, /layer\.off!==true\]/);
  const profiles = read('intelligence.js');
  assert.match(profiles, /LAYERS = \[[^\]]*'interference', 'pipelines', 'bases'\]/);
  assert.match(profiles, /LAYERS_OFF = \['pipelines', 'bases'\]/);
});
