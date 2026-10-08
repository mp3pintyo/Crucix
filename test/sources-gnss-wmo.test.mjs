import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell } from 'h3-js';
import { parseGpsJam, latestDay, briefing as gpsBriefing } from '../apis/sources/gpsjam.mjs';
import { parseWmo, parseMembers, briefing as wmoBriefing } from '../apis/sources/wmo-swic.mjs';
import { normalizeLiveSources } from '../lib/intelligence/live-sources.mjs';
import { domainOfSource } from '../lib/domains.mjs';

const NOW = Date.parse('2026-10-08T00:10:00Z');
const cell = (lat, lon) => latLngToCell(lat, lon, 4);
const csv = lines => ['hex,count_good_aircraft,count_bad_aircraft', ...lines].join('\n');

test('GPSJam: the 3-aircraft rule, high above 10%, medium to 10%, regions at the mean of their high hexagons, worst hexagons by share', () => {
  const baltic = [[55, 21], [56, 22], [57, 23]].map(([lat, lon]) => cell(lat, lon));
  const result = parseGpsJam(csv([
    `${baltic[0]},2,8`, `${baltic[1]},10,10`, `${baltic[2]},95,5`,   // 80% / 50% high, 5% medium
    `${cell(40, -100)},1,1`,                                          // two aircraft: ignored
    `${cell(41, -101)},100,1`,                                        // 1%: ignored
    `${cell(-30, 20)},4,6`,                                           // high, outside every region
  ]), '2026-10-06', { now: NOW });
  assert.equal(result.status, 'ok');
  assert.deepEqual([result.highHexagons, result.mediumHexagons], [3, 1]);
  const region = result.observations.find(row => row.providerId === 'region:baltic');
  assert.deepEqual([region.highCells, region.mediumCells, region.worstPct, region.severity], [2, 1, 80, 'low'], 'two high hexagons stay below the 5 needed for moderate');
  assert.ok(region.lat > 54 && region.lat < 57 && region.lon > 20 && region.lon < 24);
  assert.equal(region.kind, 'interference');
  const cells = result.observations.filter(row => row.providerId.startsWith('cell:'));
  assert.equal(cells.length, 3, 'only high hexagons are listed, the one outside the regions too');
  assert.equal(cells[0].sharePct, 80);
  assert.equal(result.observedAt, '2026-10-06T23:59:59.000Z');
  assert.ok(result.observations.every(row => row.severity !== 'high' && row.severity !== 'critical'), 'chronic interference is never rated above moderate');
});

test('GPSJam: a stale day, a reshaped or hostile file and the manifest are handled; the cache holds a day for 3 hours', async () => {
  const good = csv([`${cell(55, 21)},2,8`]);
  assert.equal(parseGpsJam(good, '2026-09-20', { now: NOW }).status, 'stale', 'a day older than 96 hours after its end is expired');
  for (const bad of [null, '', 'a,b,c\n1,2,3', csv(['nothex,1,1', 'zzz,x,y', '8400c8dffffffff,-1,5', '<script>,1,1'])]) assert.equal(parseGpsJam(bad, '2026-10-06', { now: NOW }).status, 'error');
  assert.equal(parseGpsJam(good, 'not a day', { now: NOW }).status, 'error');
  assert.equal(latestDay('date,suspect,num_bad_hexes,merged\n2026-10-04,false,540,merged\n2026-10-06,true,9,merged\n2026-10-05,false,549,merged\nnonsense'), '2026-10-05', 'the newest day that is not suspect');
  assert.equal(latestDay('2026-02-30,false,1'), null);
  let calls = 0;
  const fetcher = async url => { calls++; return { rawText: url.endsWith('manifest.csv') ? 'date,suspect,num_bad_hexes,merged\n2026-10-06,false,5,merged' : good }; };
  assert.equal((await gpsBriefing({ fetcher, useCache: true, now: NOW })).status, 'ok');
  await gpsBriefing({ fetcher, useCache: true, now: NOW + 3600000 });
  assert.equal(calls, 3, 'the manifest is read every time, the day file once');
  assert.equal((await gpsBriefing({ fetcher: async () => ({ error: 'HTTP 503 https://x.example/secret' }), useCache: false, now: NOW })).error.includes('https://'), false);
});

const MEMBERS = [{ ra: 2, members: [{ mid: '001', name: 'China', lat: 35.9, lng: 104.2, code: 'CHN' }] }, { ra: 6, members: [{ mid: '069', name: 'Germany', lat: 51, lng: 10, code: 'DEU' }] },
  { ra: 4, members: [{ mid: '093', name: 'United States of America', lat: 38, lng: -97, code: 'USA' }, { mid: '056', name: 'Canada', lat: 56, lng: -106, code: 'CAN' }] }];
const alert = (mid, event, s, extra = {}) => ({ id: `urn:${mid}:${event}:${Math.random()}`, event, headline: 'h', sent: '2026-10-07 23:50:00', expires: '2026-10-08 06:00:00', areaDesc: 'a', mid, s, ...extra });

test('WMO SWIC: severe and extreme warnings of non-European, non-US members are grouped per member and event, rated high at most, expired ones dropped', () => {
  const members = parseMembers(MEMBERS);
  assert.equal(members.size, 4);
  const result = parseWmo({ itemCount: 9, lastUpdated: '2026-10-08 00:00:09', items: [
    alert('001', 'Rainstorm', 3), alert('001', 'Rainstorm', 4), alert('001', 'Rainstorm', 3), alert('001', 'Fog', 2),
    alert('069', 'Storm', 4), alert('093', 'Flood Warning', 3), alert('056', 'Squall', 3),
    alert('001', 'Old', 3, { expires: '2026-10-07 20:00:00' }), alert('001', 'Future', 3, { sent: '2026-10-09 00:00:00' }),
  ] }, members, { now: NOW });
  assert.equal(result.status, 'ok');
  const titles = result.observations.map(row => row.title).sort();
  assert.deepEqual(titles, ['Rainstorm: China (3 areas)', 'Squall: Canada']);
  const rain = result.observations.find(row => row.title.startsWith('Rainstorm'));
  assert.deepEqual([rain.severity, rain.kind, rain.locationMethod, rain.lat, rain.lon], ['high', 'weather', 'member-point', 35.9, 104.2]);
  assert.match(rain.summary, /extreme/);
  assert.equal(rain.validUntil, '2026-10-08T06:00:00.000Z');
});

test('WMO SWIC: a reshaped answer is an error, members are cached for a week, an old feed is stale', async () => {
  const members = parseMembers(MEMBERS);
  for (const bad of [null, {}, { items: 'x' }, { items: [{ nope: 1 }, { nope: 2 }, 3] }, { error: 'HTTP 500 https://secret.example' }]) assert.equal(parseWmo(bad, members, { now: NOW }).status, 'error');
  assert.equal(parseWmo({ lastUpdated: '2026-10-07 10:00:00', items: [alert('001', 'Rainstorm', 3)] }, members, { now: NOW }).status, 'stale');
  assert.equal(parseMembers([{ ra: 1, members: [{ mid: 'x', name: '<b>', lat: 99, lng: 0 }] }]), null);
  let memberCalls = 0;
  const fetcher = async url => { if (url.endsWith('wmo_member.json')) { memberCalls++; return MEMBERS; } return { lastUpdated: '2026-10-08 00:00:00', items: [alert('001', 'Rainstorm', 3)] }; };
  assert.equal((await wmoBriefing({ fetcher, useCache: true, now: NOW })).observations.length, 1);
  await wmoBriefing({ fetcher, useCache: true, now: NOW + 600000 });
  assert.equal(memberCalls, 1);
});

test('the new rows pass the live-source normalizer with their kind and fact whitelist; the sources sit in their lenses', () => {
  const gps = parseGpsJam(csv([`${cell(55, 21)},2,8`]), '2026-10-06', { now: NOW });
  const normalized = normalizeLiveSources([gps], NOW);
  const rows = normalized.find(item => item.source === 'GPSJam').observations;
  const row = rows.find(item => item.providerId.startsWith('cell:'));
  assert.equal(row.kind, 'interference');
  assert.ok(row.facts.some(fact => fact.label === 'badAircraft' && fact.value === 8));
  assert.ok(rows.find(item => item.providerId.startsWith('region:')).facts.some(fact => fact.label === 'highCells'));
  assert.equal(row.lat > 50, true);
  assert.equal(domainOfSource('GPSJam'), 'security');
  assert.equal(domainOfSource('WMO-SWIC'), 'hazards');
});
