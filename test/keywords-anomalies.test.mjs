import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeywordStore, termsOf, headlinesOf, KEYWORDS } from '../lib/intelligence/keywords.mjs';
import { computeAnomalies, welford, anomalyLevel } from '../lib/intelligence/anomalies.mjs';
import { EntityStore } from '../lib/intelligence/entities.mjs';
import { runRiskStep } from '../lib/intelligence/risk-step.mjs';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-08T12:30:00Z');
const quiet = { warn() {}, error() {}, log() {}, info() {} };
const iso = ms => new Date(ms).toISOString();
const tempDir = t => { const dir = mkdtempSync(join(tmpdir(), 'crucix-kw-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('termsOf: lower-case distinct words of 4 to 30 letters, stop words and numbers dropped, hyphens and CVE ids kept, Hungarian accents intact', () => {
  assert.deepEqual(termsOf('Strait of Hormuz: tankers reroute after Hormuz drone strike, 2026'), ['strait', 'hormuz', 'tankers', 'reroute', 'drone', 'strike']);
  assert.deepEqual(termsOf('CVE-2026-4242 exploited in the wild; BREAKING news update'), ['cve-2026-4242', 'exploited', 'wild']);
  assert.deepEqual(termsOf('A magyar kormány szerint nincs válság, a költségvetés hiánya nő'), ['magyar', 'kormány', 'válság', 'költségvetés', 'hiánya']);
  assert.deepEqual(termsOf(null), []);
  assert.ok(termsOf('x'.repeat(40) + ' ' + 'word '.repeat(100)).length <= 24);
});

// Hourly headlines for `hours` hours back from `end`: each hour one routine headline per source.
function warm(store, hours, end = NOW - 3 * HOUR) {
  for (let h = hours; h >= 1; h--) {
    const now = end - h * HOUR;
    store.ingest([{ title: `Routine budget talks continue in parliament ${h}`, source: 'BBC' }, { title: `Markets quiet ahead of data release ${h}`, source: 'DW' }], { now });
  }
}

test('keyword spikes: not ready before 24 observed hours, then a burst from two sources stands out; one source, a low count or a usual term do not', () => {
  const store = new KeywordStore(tempDir({ after() {} }), { now: () => NOW });
  warm(store, 20);
  assert.deepEqual(store.detect({ now: NOW }), { ready: false, observedHours: 20, items: [] }, 'twenty hours is not a baseline');
  warm(store, 30);
  const burst = (title, source, n = 1) => Array.from({ length: n }, (_, index) => ({ title: `${title} ${source} ${index}`, source }));
  store.ingest([...burst('Hormuz tanker attack', 'BBC', 3), ...burst('Hormuz tanker attack', 'DW', 3), ...burst('Lonely word solo', 'BBC', 6), ...burst('Budget talks update', 'BBC', 2)], { now: NOW });
  const result = store.detect({ now: NOW });
  assert.equal(result.ready, true);
  const terms = result.items.map(item => item.term);
  assert.ok(terms.includes('hormuz') && terms.includes('tanker'), terms.join());
  assert.ok(!terms.includes('lonely'), 'six headlines from one source are not a spike');
  assert.ok(!terms.includes('budget'), 'a term in its usual range is not a spike');
  const hormuz = result.items.find(item => item.term === 'hormuz');
  assert.deepEqual([hormuz.count, hormuz.sources.sort(), hormuz.level], [6, ['BBC', 'DW'], 'moderate']);
  assert.ok(hormuz.ratio > KEYWORDS.multiple);
  store.ingest(burst('Hormuz tanker attack', 'FT', 4), { now: NOW });
  assert.equal(store.detect({ now: NOW }).items.find(item => item.term === 'hormuz').level, 'high', 'ratio 8+, count 8+, three sources');
});

test('keyword store: a headline counts once however often a feed repeats it, the file round-trips, old buckets expire, a corrupt file starts empty', t => {
  const dir = tempDir(t);
  const store = new KeywordStore(dir, { now: () => NOW });
  const items = [{ title: 'Hormuz tanker attack', source: 'BBC' }];
  assert.equal(store.ingest(items, { now: NOW }), 1);
  assert.equal(store.ingest(items, { now: NOW + 15 * 60000 }), 0, 'the same headline in the next sweep');
  assert.equal(store.ingest([{ title: '', source: 'BBC' }, { title: 'x', source: '' }, null, 5], { now: NOW }), 0);
  assert.equal(store.save(quiet), true);
  const again = new KeywordStore(dir, { now: () => NOW });
  assert.equal(again.load(), 'ok');
  assert.equal(again.ingest(items, { now: NOW }), 0, 'the seen set survives');
  assert.equal([...again.buckets.values()][0].terms.get('hormuz').n, 1);
  const later = NOW + 9 * DAY;
  again.ingest([{ title: 'Fresh headline words', source: 'BBC' }], { now: later });
  assert.equal(again.buckets.size, 1, 'a bucket older than 8 days is dropped');
  const bad = tempDir(t);
  mkdirSync(join(bad, 'intelligence'), { recursive: true });
  writeFileSync(join(bad, 'intelligence', 'keywords.json'), '{not json');
  const fresh = new KeywordStore(bad, { now: () => NOW });
  assert.notEqual(fresh.load(), 'ok');
  assert.equal(fresh.buckets.size, 0);
  assert.deepEqual(headlinesOf({ newsFeed: [{ headline: 'A headline here', source: 'BBC' }, { nope: 1 }, null] }), [{ title: 'A headline here', source: 'BBC' }]);
});

// Located events in one country, `perDay[k]` events in the 24-hour window k back from NOW (k = 0 is the last day).
function located(store, perDay, point = [49, 32]) {
  const events = [];
  let n = 0;
  perDay.forEach((count, k) => { for (let i = 0; i < count; i++) {
    const time = NOW - k * DAY - (i + 1) * 20 * 60000;
    events.push({ id: `event-${(++n).toString(16).padStart(32, '0')}`, kind: 'conflict', title: `strike ${k}-${i}`, summary: '', severity: 'high', observedAt: iso(time),
      location: { lat: point[0], lon: point[1], method: 'provider', label: '', precision: 'exact' } });
  } });
  store.ingest(events, { now: NOW });
}

test('anomalies: Welford mean and spread, a z-score of the last day against the previous windows, nothing while history is short or the excess small', t => {
  const stats = welford([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.deepEqual([stats.n, stats.mean, stats.std], [8, 5, 2]);
  assert.deepEqual([anomalyLevel(1.4), anomalyLevel(1.5), anomalyLevel(2), anomalyLevel(3.2), anomalyLevel(NaN)], [null, 'moderate', 'high', 'critical', null]);
  const store = new EntityStore(tempDir(t), { now: () => NOW });
  store.load();
  store.since = NOW - 14 * DAY;                                        // fourteen days of observation: 13 full windows before today
  located(store, [14, 3, 4, 3, 5, 4, 3, 4, 5, 3, 4, 3, 4, 5]);        // today 14 against about 4 a day (Ukraine)
  const [top] = computeAnomalies(store, NOW);
  assert.equal(top.iso3, 'UKR');
  assert.equal(top.current, 14);
  assert.ok(top.z >= 3 && top.level === 'critical' && top.samples === 13, JSON.stringify(top));
  const quietStore = new EntityStore(tempDir(t), { now: () => NOW });
  quietStore.load(); quietStore.since = NOW - 14 * DAY;
  located(quietStore, [5, 4, 5, 4, 5, 4, 5, 4, 5, 4, 5, 4, 5]);
  assert.deepEqual(computeAnomalies(quietStore, NOW), [], 'five against four a day is not unusual');
  const young = new EntityStore(tempDir(t), { now: () => NOW });
  young.load(); young.since = NOW - 5 * DAY;
  located(young, [14, 3, 4, 3, 5]);
  assert.deepEqual(computeAnomalies(young, NOW), [], 'five days of history are not a baseline');
});

test('the risk step adds the unusual-activity list and the trending terms to snapshot.risk, and a failing store never stops it', t => {
  const store = new EntityStore(tempDir(t), { now: () => NOW });
  store.load(); store.since = NOW - 30 * DAY;
  located(store, [14, 3, 4, 3, 5, 4, 3, 4, 5, 3, 4, 3, 4, 5]);
  const keywords = new KeywordStore(tempDir(t), { now: () => NOW });
  warm(keywords, 40);
  const snapshot = { events: [], newsFeed: Array.from({ length: 8 }, (_, index) => ({ headline: `Hormuz tanker attack report ${index}`, source: index % 2 ? 'BBC' : 'DW' })) };
  const result = runRiskStep({ store, keywords, snapshot, raw: null, now: NOW, log: quiet });
  assert.equal(result.ok, true);
  assert.equal(snapshot.risk.anomalies[0].iso3, 'UKR');
  assert.equal(snapshot.risk.spikes.ready, true);
  assert.ok(snapshot.risk.spikes.items.some(item => item.term === 'hormuz'));
  const broken = { ingest() { throw new Error('disk full at C:\\secret'); } };
  const second = { events: [] };
  assert.equal(runRiskStep({ store, keywords: broken, snapshot: second, raw: null, now: NOW, log: quiet }).ok, true);
  assert.ok(Array.isArray(second.risk.anomalies) && second.risk.spikes === undefined, 'the spikes are left out, the rest stays');
});

const read = path => readFileSync(new URL(`../dashboard/public/${path}`, import.meta.url), 'utf8');
function panel() {
  const window = {};
  vm.runInContext(read('risk.js'), vm.createContext({ window, document: {}, Intl, console }));
  return window.CrucixRisk;
}
const baseRisk = { version: 2, at: iso(NOW), top: [{ iso3: 'JPN', name: 'Japan', score: 40, change24h: null, coverage: 0.8, convergence: { active: false, kinds: [] } }], counts: { scored: 1, high: 0 }, calibration: null };

test('the country-risk panel shows the unusual-activity list and the trending terms, escaped; an older summary and a short baseline are handled', () => {
  const risk = panel();
  const html = risk.panelHtml({ ...baseRisk,
    anomalies: [{ iso3: 'UKR', name: '<img onerror=x>Ukraine', current: 14, mean: 4.1, std: 0.8, z: 12.4, level: 'critical' }, { iso3: 'bad', current: 1, mean: 1, z: 1 }],
    spikes: { ready: true, observedHours: 48, items: [{ term: 'hormuz', count: 9, baseline: 1.2, ratio: 7.5, level: 'high', sources: ['BBC', 'DW', '<b>x</b>'] }, { term: '<script>', count: 5, ratio: 5 }] } }, { replay: false });
  assert.ok(html.includes('Unusual activity') && /14 events, usually 4[.,]1 \(z 12[.,]4\)/.test(html) /* the decimal sign follows the machine's locale */ && html.includes('data-level="critical"'));
  assert.ok(html.includes('Trending terms') && html.includes('>hormuz<') && /9 headlines, usually 1[.,]2/.test(html) && html.includes('3 sources'));
  assert.ok(!html.includes('<img') && !html.includes('<script') && !html.includes('<b>x'));
  const notReady = risk.panelHtml({ ...baseRisk, anomalies: [], spikes: { ready: false, observedHours: 12, items: [] } }, { replay: false });
  assert.ok(notReady.includes('Collecting a baseline: 12 of the 24 hours') && notReady.includes('Nothing unusual against'));
  const older = risk.panelHtml(baseRisk, { replay: false });
  assert.ok(!older.includes('Unusual activity') && !older.includes('Trending terms'), 'a summary without the fields shows neither');
  assert.ok(older.includes('Japan'));
});
