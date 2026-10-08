import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSystem, parseJma, briefing as jma } from '../apis/sources/jma-typhoon.mjs';
import { levelOf, parseEcdc, parseEcdcFeed, briefing as ecdc } from '../apis/sources/ecdc-threats.mjs';
import { synthesize } from '../dashboard/inject.mjs';

const NOW = Date.parse('2026-10-08T17:00:00Z');
const part = (hours, lat, lon, kt) => ({ part: { en: hours ? `Forecast for ${hours} hours ahead` : 'Analysis' }, advancedHours: hours, maximumWind: { sustained: { kt: String(kt) } }, position: { deg: [lat, lon] }, pressure: '980', speed: { kt: '11' }, validtime: { UTC: '2026-10-08T15:00:00Z' } });
const doc = (extra = []) => [{ part: 'title', typhoonNumber: '2629', name: { en: 'Koguma' }, category: { en: 'TY' } }, part(0, 17.9, 158.5, 65), part(12, 18.7, 155.9, 70), part(24, 19.8, 153.6, 75), ...extra];

test('JMA: one row per system with severity by wind, a position, facts and a forecast track; unusable systems are dropped', () => {
  const system = parseSystem('TC2634', doc(), NOW);
  assert.deepEqual([system.name, system.cls, system.kt, system.points.length], ['Koguma', 'Typhoon', 65, 2]);
  assert.equal(parseSystem('bad', doc(), NOW), null);
  assert.equal(parseSystem('TC2634', [{ part: 'title' }], NOW), null);
  assert.equal(parseSystem('TC2634', [doc()[0], part(0, 99, 158.5, 65)], NOW), null);
  const result = parseJma([{ tropicalCyclone: 'TC2634' }, { tropicalCyclone: 'TC2635' }], { TC2634: doc(), TC2635: [{ part: 'title' }] }, NOW);
  assert.equal(result.status, 'ok');
  assert.equal(result.observations.length, 1);
  const [row] = result.observations;
  assert.deepEqual([row.severity, row.windKt, row.pressureMb, row.movement, row.region, row.locationMethod], ['elevated', 65, 980, 'at 11 kt', 'Western Pacific', 'provider']);
  assert.deepEqual(result.geometry[0].track[0], [17.9, 158.5]);
  assert.equal(result.geometry[0].track.length, 3);
  assert.deepEqual(result.geometry[0].cone, []);
});

test('JMA: no active system is a valid empty answer; an unreadable list or a failed request is an error; the answer is cached 5 minutes', async () => {
  assert.equal(parseJma([], {}, NOW).status, 'ok');
  assert.equal(parseJma({ x: 1 }, {}, NOW).status, 'error');
  assert.equal(parseJma([{ tropicalCyclone: 'TC2634' }], {}, NOW).status, 'error');
  assert.equal((await jma({ now: NOW, fetcher: async () => ({ error: 'HTTP 503' }) })).status, 'error');
  let calls = 0;
  const fetcher = async url => { calls++; return url.endsWith('targetTc.json') ? [{ tropicalCyclone: 'TC2634' }] : doc(); };
  const first = await jma({ now: NOW, fetcher, useCache: true });
  assert.equal(first.observations.length, 1);
  const before = calls;
  await jma({ now: NOW + 60000, fetcher, useCache: true });
  assert.equal(calls, before);
});

const rss = items => `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>${items.map(i => `<item><title>${i.title}</title><link>${i.link}</link><description>${i.description || ''}</description><pubDate>${i.date}</pubDate></item>`).join('')}</channel></rss>`;
const item = (title, slug, date = 'Tue, 06 Oct 2026 14:31:22 +0200', description = '&lt;p&gt;Some text.&amp;nbsp;&lt;/p&gt;') => ({ title, link: `https://www.ecdc.europa.eu/en/${slug}`, date, description });

test('ECDC: level from the headline words; markup and entities are stripped; links stay on ecdc.europa.eu; dates in the future are dropped', () => {
  assert.deepEqual(['Ebola outbreak in DRC', 'Local transmission of dengue', 'Weekly threat report'].map(levelOf), ['ALERT', 'WARNING', 'WATCH']);
  const items = parseEcdcFeed(rss([item('Ebola outbreak', 'a'), { ...item('Evil', 'b'), link: 'https://evil.example/x' }, item('Future', 'c', 'Tue, 06 Oct 2027 14:31:22 +0200'), item('No date', 'd', 'soon')]), NOW);
  assert.deepEqual(items.map(i => i.title), ['Ebola outbreak']);
  assert.equal(items[0].summary, 'Some text.');
  assert.equal(parseEcdcFeed('<html>not a feed</html>', NOW), null);
});

test('ECDC: rows are newest first, duplicates across feeds collapse, old items drop, one failed feed is named, all failed is an error', async () => {
  const news = rss([item('Ebola outbreak', 'ebola'), item('Old item', 'old', 'Mon, 01 Jun 2026 10:00:00 +0200')]);
  const updates = rss([item('Ebola outbreak', 'ebola'), item('Measles cluster', 'measles', 'Wed, 07 Oct 2026 10:00:00 +0200')]);
  const result = parseEcdc({ News: news, 'Epidemiological update': updates }, NOW);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.observations.map(row => [row.title, row.alertLevel, row.severity]), [['Measles cluster', 'WARNING', 'moderate'], ['Ebola outbreak', 'ALERT', 'high']]);
  assert.match(parseEcdc({ News: news, 'Epidemiological update': null }, NOW).summary, /Warning: the Epidemiological update feed failed/);
  assert.equal(parseEcdc({ News: null, 'Epidemiological update': 'nope' }, NOW).status, 'error');
  assert.equal((await ecdc({ now: NOW, fetcher: async () => ({ error: 'HTTP 500' }) })).status, 'error');
});

test('Cyclone geometry of NOAA-NHC and JMA-Typhoon both reach the map payload, only from fresh sources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-jma-'));
  try {
    const geometry = id => [{ id, name: id, track: [[1, 2], [3, 4]], points: [], cone: [] }];
    const sources = { 'NOAA-NHC': { status: 'ok', geometry: geometry('al09') }, 'JMA-Typhoon': { status: 'ok', geometry: geometry('TC2634') } };
    const both = await synthesize({ crucix: { timestamp: '2026-10-08T08:00:00Z' }, sources }, { news: [], runsDir: dir });
    assert.deepEqual(both.cyclones.map(c => c.id), ['al09', 'TC2634']);
    const stale = await synthesize({ crucix: { timestamp: '2026-10-08T08:00:00Z' }, sources: { ...sources, 'JMA-Typhoon': { status: 'stale', geometry: geometry('TC2634') } } }, { news: [], runsDir: dir });
    assert.deepEqual(stale.cyclones.map(c => c.id), ['al09']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
