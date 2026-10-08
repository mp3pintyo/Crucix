import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWind, briefing as wind, sites } from '../apis/sources/openmeteo-wind.mjs';
import { createDailyBasemap, snapshotUrl, dayOffset } from '../lib/basemap.mjs';
import { synthesize } from '../dashboard/inject.mjs';

const NOW = Date.parse('2026-10-08T08:00:00Z');
const answer = (over = {}) => sites().map((_, i) => ({ current: { time: '2026-10-08T07:45', interval: 900, wind_speed_10m: 2 + i, wind_direction_10m: 225, wind_gusts_10m: 4 + i, ...over } }));

test('wind rows: one per site, the direction it blows toward, the time read as UTC; bad readings are dropped; a wrong shape is an error', () => {
  const result = parseWind(answer(), sites(), NOW);
  assert.equal(result.status, 'ok');
  assert.equal(result.observations.length, 6);
  const first = result.observations[0];
  assert.deepEqual([first.kind, first.windMs, first.windFromDeg, first.windTowardDeg, first.windToward, first.observedAt, first.place], ['weather', 2, 225, 45, 'NE', '2026-10-08T07:45:00.000Z', 'Zaporizhzhia NPP (Ukraine)']);
  assert.match(first.summary, /not a dispersion forecast/);
  const mixed = answer(); mixed[1].current.wind_speed_10m = 'x'; mixed[2].current.time = 'yesterday';
  assert.equal(parseWind(mixed, sites(), NOW).observations.length, 4);
  assert.equal(parseWind(answer().slice(0, 3), sites(), NOW).status, 'error');
  assert.equal(parseWind({ error: true }, sites(), NOW).status, 'error');
  assert.equal(parseWind(answer({ time: '2026-10-08T03:00' }), sites(), NOW).status, 'stale', 'a reading from five hours ago is stale');
});

test('wind briefing: one request for all six points, a 10-minute cache, an error on failure', async () => {
  let calls = 0, url = '';
  const fetcher = async u => { calls++; url = u; return answer(); };
  const result = await wind({ fetcher, now: NOW, useCache: true });
  assert.equal(result.observations.length, 6);
  assert.equal(new URL(url).searchParams.get('latitude').split(',').length, 6);
  await wind({ fetcher, now: NOW + 60000, useCache: true });
  assert.equal(calls, 1);
  assert.equal((await wind({ fetcher: async () => ({ error: 'HTTP 500' }), now: NOW + 3600000, useCache: false })).status, 'error');
});

test('the nuclear rows of the snapshot carry the wind of their site; without the wind source they carry none', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-wind-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const safecast = { sites: [{ site: 'Zaporizhzhia NPP (Ukraine)', anomaly: false, avgCPM: 28, recentReadings: 3, status: 'cached', lastReading: '2026-10-08T07:00:00.000Z' }] };
  const base = { crucix: { timestamp: '2026-10-08T08:00:00Z' } };
  const withWind = await synthesize({ ...base, sources: { Safecast: safecast, 'Open-Meteo-Wind': parseWind(answer(), sites(), NOW) } }, { news: [], runsDir: dir });
  assert.deepEqual([withWind.nuke[0].wind.ms, withWind.nuke[0].wind.dir, withWind.nuke[0].wind.toward], [2, 'NE', 45]);
  const without = await synthesize({ ...base, sources: { Safecast: safecast } }, { news: [], runsDir: dir });
  assert.equal(Object.hasOwn(without.nuke[0], 'wind'), false);
});

const jpeg = bytes => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(bytes)]);
const reply = (body, status = 200) => ({ ok: status === 200, status, body: new Response(body).body });

test('daily basemap: yesterday\'s image, one shared download, cached for the day, the day before as a fallback, a stale image on failure, a non-JPEG refused', async () => {
  let now = NOW, urls = [];
  const good = async url => { urls.push(url); return reply(jpeg(80 * 1024)); };
  const basemap = createDailyBasemap({ fetchImpl: good, now: () => now });
  const [a, b] = await Promise.all([basemap.get(), basemap.get()]);
  assert.equal(urls.length, 1, 'concurrent callers share one download');
  assert.deepEqual([a.day, a.stale, b.buffer === a.buffer], ['2026-10-07', false, true]);
  assert.match(urls[0], /TIME=2026-10-07/);
  assert.match(snapshotUrl('2026-10-07'), /WIDTH=4096/);
  await basemap.get();
  assert.equal(urls.length, 1, 'cached for the rest of the day');
  now += 26 * 3600000;                                                       // the next UTC day: the refresh fails, the old image serves as stale
  const failingCold = createDailyBasemap({ fetchImpl: async () => reply('x', 500), now: () => now });
  await assert.rejects(failingCold.get(), /HTTP 500/);
  let clock = NOW, ok = true;
  const aging = createDailyBasemap({ fetchImpl: async url => (ok ? good(url) : reply('x', 500)), now: () => clock });
  await aging.get(); clock += 26 * 3600000; ok = false;
  const staleImage = await aging.get();
  assert.deepEqual([staleImage.stale, staleImage.day], [true, '2026-10-07']);
  const fallback = createDailyBasemap({ fetchImpl: async url => (url.includes('TIME=2026-10-08') ? reply('x', 404) : good(url)), now: () => now });
  assert.equal((await fallback.get()).day, '2026-10-07', 'yesterday is not published yet: the day before');
  const junk = createDailyBasemap({ fetchImpl: async () => reply(Buffer.from('<html>error</html>')), now: () => NOW });
  await assert.rejects(junk.get(), /JPEG/);
});
