import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNhc, parseGeometry, parseStorms, severityOf, briefing as nhc } from '../apis/sources/nhc.mjs';
import { launchRow, parseLaunches, briefing as launches } from '../apis/sources/launches.mjs';
import { normalizeLiveSources } from '../lib/intelligence/live-sources.mjs';
import { synthesize } from '../dashboard/inject.mjs';

const NOW = Date.parse('2026-10-08T08:00:00Z');
const storm = (id, name, cls, kt, extra = {}) => ({ id, name, classification: cls, intensity: String(kt), pressure: '981', latitudeNumeric: 23.1, longitudeNumeric: -91.7, movementDir: 70, movementSpeed: 9, lastUpdate: '2026-10-08T06:00:00.000Z', publicAdvisory: { url: 'https://www.nhc.noaa.gov/text/MIATCPAT4.shtml' }, ...extra });
const status = { activeStorms: [storm('al092026', 'Isaias', 'HU', 65), storm('ep202026', 'Simon', 'TS', 45, { latitudeNumeric: 22, longitudeNumeric: -106 })] };
const line = coordinates => ({ type: 'Feature', properties: { basin: 'AL', stormnum: 9 }, geometry: { type: 'LineString', coordinates } });
const layers = {
  points: { features: [{ properties: { basin: 'AL', stormnum: 9, tau: 24, maxwind: 70 }, geometry: { type: 'Point', coordinates: [-92.1, 24.2] } }, { properties: { basin: 'AL', stormnum: 9, tau: 0, maxwind: 65 }, geometry: { type: 'Point', coordinates: [-91.7, 23.1] } }, { properties: { basin: 'ZZ', stormnum: 1, tau: 0 }, geometry: { type: 'Point', coordinates: [0, 0] } }] },
  track: { features: [line([[-91.7, 23.1], [-92.1, 24.2]])] },
  cone: { features: [{ properties: { basin: 'AL', stormnum: 9 }, geometry: { type: 'Polygon', coordinates: [Array.from({ length: 400 }, (_, i) => [-92 + i / 100, 23 + (i % 7) / 10])] } }] },
};

test('NHC: one row per active storm with severity by wind, facts and a position; unusable storms are dropped', () => {
  assert.deepEqual([34, 64, 96, 113].map(severityOf), ['moderate', 'elevated', 'high', 'critical']);
  assert.equal(severityOf(20), 'low');
  const bad = { activeStorms: [storm('al092026', 'Isaias', 'HU', 65), storm('xx', 'Bad', 'HU', 50), storm('al102026', '', 'TS', 40), storm('al112026', 'Far', 'TS', 40, { latitudeNumeric: 99 }), storm('al122026', 'Future', 'TS', 40, { lastUpdate: '2026-10-09T06:00:00.000Z' })] };
  assert.deepEqual(parseStorms(bad, NOW).map(s => s.name), ['Isaias']);
  const result = parseNhc(status, null, NOW);
  assert.equal(result.status, 'ok');
  assert.equal(result.observations.length, 2);
  assert.deepEqual([result.observations[0].severity, result.observations[0].windKt, result.observations[0].movement], ['elevated', 65, '70° at 9 kt']);
  assert.equal(result.observations[0].region, 'Atlantic');
  assert.equal(parseNhc({}, null, NOW).status, 'error');
  const none = parseNhc({ activeStorms: [] }, null, NOW);
  assert.deepEqual([none.status, none.observations.length, none.activeStorms], ['ok', 0, 0]);
});

test('NHC geometry joins track, points and cone to the storm by basin and number, rounds, thins and ignores other storms', () => {
  const geometry = parseGeometry(parseStorms(status, NOW), layers.points, layers.track, layers.cone);
  assert.equal(geometry.length, 1, 'Simon has no geometry, so no entry');
  const [g] = geometry;
  assert.deepEqual([g.id, g.track.length, g.points.map(p => p.hours)], ['al092026', 2, [0, 24]]);
  assert.deepEqual(g.track[0], [23.1, -91.7]);
  assert.ok(g.cone.length <= 121 && g.cone.length > 50, 'a 400-point ring is thinned to about 120');
  assert.ok(g.cone.every(([lat, lon]) => Math.abs(lat) <= 90 && Math.abs(lon) <= 180));
});

test('NHC briefing: a failed geometry layer keeps the storms; a failed status request is an error; the answer is cached 5 minutes', async () => {
  let calls = 0;
  const fetcher = async url => { calls++; if (url.includes('CurrentStorms')) return status; if (url.includes('/7/query')) throw new Error('layer down'); return layers.points; };
  const result = await nhc({ fetcher, now: NOW, useCache: true });
  assert.equal(result.observations.length, 2);
  assert.deepEqual(result.geometry, []);
  assert.equal(result.geometryAvailable, false);
  const before = calls;
  await nhc({ fetcher, now: NOW + 60000, useCache: true });
  assert.equal(calls, before, 'second call within 5 minutes is served from the cache');
  const down = await nhc({ fetcher: async () => ({ error: 'HTTP 503' }), now: NOW + 3600000, useCache: false });
  assert.equal(down.status, 'error');
});

const launch = (over = {}) => ({ id: 'abc', name: 'Falcon 9 Block 5 | Test', net: '2026-10-10T07:29:00Z', last_updated: '2026-10-08T05:00:00Z', status: { id: 1, name: 'Go for Launch' }, mission: { type: 'Communications', orbit: { abbrev: 'LEO' } },
  rocket: { configuration: { full_name: 'Falcon 9 Block 5' } }, launch_service_provider: { name: 'SpaceX' }, pad: { name: 'SLC-4E', latitude: 34.632, longitude: -120.611, country: { alpha_3_code: 'USA' }, location: { name: 'Vandenberg SFB' } }, ...over });

test('Launch Library rows: window, pad position, severity (government payload moderate, failure elevated) and located facts', () => {
  const row = launchRow(launch(), NOW);
  assert.deepEqual([row.kind, row.severity, row.lat, row.lon, row.country, row.rocket, row.provider], ['launch', 'info', 34.632, -120.611, 'USA', 'Falcon 9 Block 5', 'SpaceX']);
  assert.equal(launchRow(launch({ mission: { type: 'Government/Top Secret' } }), NOW).severity, 'moderate');
  assert.equal(launchRow(launch({ status: { id: 4, name: 'Launch Failure' }, net: '2026-10-05T07:29:00Z' }), NOW).severity, 'elevated');
  assert.equal(launchRow(launch({ net: '2026-11-30T00:00:00Z' }), NOW), null, 'beyond 14 days');
  assert.equal(launchRow(launch({ net: '2026-09-20T00:00:00Z' }), NOW), null, 'older than 7 days');
  assert.equal(launchRow(launch({ pad: { name: 'x' } }), NOW), null, 'no pad position');
  assert.equal(parseLaunches({ results: [launch()] }, null, NOW).status, 'error');
  const ok = parseLaunches({ results: [launch(), launch()] }, { results: [] }, NOW);
  assert.equal(ok.observations.length, 1, 'the same launch id is one row');
});

test('Launch Library briefing: two requests, a 15-minute cache, and the last good answer when the API throttles', async () => {
  let calls = 0, fail = false;
  const fetcher = async () => { calls++; if (fail) return { error: 'HTTP 429' }; return { results: [launch()] }; };
  const first = await launches({ fetcher, now: NOW, useCache: true });
  assert.equal(first.observations.length, 1);
  assert.equal(calls, 2);
  await launches({ fetcher, now: NOW + 60000, useCache: true });
  assert.equal(calls, 2, 'cached');
  fail = true;
  const throttled = await launches({ fetcher, now: NOW + 20 * 60000, useCache: true });
  assert.equal(throttled.observations.length, 1, 'throttled: last good answer within the hour');
  assert.equal((await launches({ fetcher, now: NOW + 3 * 3600000, useCache: true })).status, 'error');
});

test('both sources pass the live-row normalisation with their facts, and the synthesised snapshot carries the cyclone geometry', async t => {
  const nhcResult = parseNhc(status, { points: layers.points, track: layers.track, cone: layers.cone }, NOW);
  const rows = normalizeLiveSources({ 'NOAA-NHC': nhcResult, 'Launch-Library': parseLaunches({ results: [launch()] }, { results: [] }, NOW) }, NOW);
  const storm0 = rows.find(r => r.source === 'NOAA-NHC').observations[0];
  assert.deepEqual(storm0.facts.map(f => f.label), ['stormClass', 'windKt', 'pressureMb', 'movement']);
  const l0 = rows.find(r => r.source === 'Launch-Library').observations[0];
  assert.equal(l0.kind, 'launch');
  assert.ok(l0.facts.some(f => f.label === 'rocket'));
  const dir = mkdtempSync(join(tmpdir(), 'crucix-nhc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = await synthesize({ crucix: { timestamp: '2026-10-08T08:00:00Z' }, sources: { 'NOAA-NHC': nhcResult } }, { news: [], runsDir: dir });
  assert.equal(data.cyclones.length, 1);
  assert.equal(data.cyclones[0].name, 'Isaias');
});

test('a cone ring is wound clockwise for d3-geo whichever way the provider sent it (a counter-clockwise ring would fill the whole flat map)', async () => {
  const { default: vm } = await import('node:vm');
  const { readFileSync } = await import('node:fs');
  const window = {};
  vm.runInContext(readFileSync(new URL('../dashboard/public/infrastructure.js', import.meta.url), 'utf8'), vm.createContext({ window, Math, Number, Object, Array, JSON, Promise, String }));
  const clockwise = [[25, -95], [25, -91], [22, -91], [22, -95]];
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(window.CrucixInfrastructure.windClockwise(clockwise)), clockwise);
  assert.deepEqual(plain(window.CrucixInfrastructure.windClockwise([...clockwise].reverse())), clockwise);
  assert.deepEqual(plain(window.CrucixInfrastructure.windClockwise([[1, 2]])), [[1, 2]]);
});
