import test from 'node:test';
import assert from 'node:assert/strict';
import { parseThreatFox, briefing as threatfoxBriefing } from '../apis/sources/threatfox.mjs';
import { parseHibp, briefing as hibpBriefing } from '../apis/sources/hibp.mjs';
import { normalizeLiveSources } from '../lib/intelligence/live-sources.mjs';
import { domainOfSource } from '../lib/domains.mjs';

const now = Date.parse('2026-10-08T00:10:00Z');
const HOUR = 3600000, DAY = 24 * HOUR;
const RTL = String.fromCharCode(0x202e);
const stamp = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
// Shaped like https://threatfox.abuse.ch/export/json/recent/ (captured 2026-10-08): { "<id>": [ioc] }.
const ioc = (family, key, ageMs, type = 'domain', threat = 'payload_delivery') => [{ ioc_value: 'x.example', ioc_type: type, threat_type: threat, malware: key, malware_alias: null,
  malware_printable: family, first_seen_utc: stamp(now - ageMs), last_seen_utc: null, confidence_level: 90, is_compromised: true, reference: null, tags: 'a', anonymous: 1, reporter: 'anon' }];
const feed = (...groups) => Object.fromEntries(groups.flatMap(([family, key, count, ageMs, threat]) => Array.from({ length: count }, (_, i) => [`${key}-${i}`, ioc(family, key, ageMs + i * 1000, 'ip:port', threat)])));

test('ThreatFox: one row per family over the last 24 hours, rated by count; older indicators only count for the feed time', () => {
  const result = parseThreatFox(feed(['Cobalt Strike', 'win.cobalt_strike', 100, HOUR, 'botnet_cc'], ['ClearFake', 'js.clearfake', 3, 2 * HOUR], ['Mirai', 'elf.mirai', 5, 3 * DAY]), { now });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.observations.map(row => [row.family, row.iocCount, row.c2Count, row.severity]), [['Cobalt Strike', 100, 100, 'moderate'], ['ClearFake', 3, 0, 'info']]);
  assert.equal(result.observations[0].url, 'https://threatfox.abuse.ch/browse/malware/win.cobalt_strike/');
  assert.equal(result.observations[0].kind, 'cyber');
  assert.equal(result.license, 'CC0 1.0');
});

test('ThreatFox: an old export is stale, a reshaped one is an error, and hostile text never reaches a row', () => {
  assert.equal(parseThreatFox(feed(['Mirai', 'elf.mirai', 2, 20 * HOUR]), { now: now + 8 * HOUR }).status, 'stale');
  assert.equal(parseThreatFox({ a: [{ foo: 1 }], b: 'x' }, { now }).status, 'error');
  assert.equal(parseThreatFox([1, 2], { now }).status, 'error');
  assert.equal(parseThreatFox({ error: 'HTTP 503 https://threatfox.abuse.ch/secret' }, { now }).error.includes('https://'), false);
  const hostile = parseThreatFox({ 1: ioc('<img onerror=x>', 'win.x', HOUR), 2: ioc('Evil' + RTL, '../../etc', HOUR), 3: ioc('Fine', '../../etc', HOUR) }, { now });
  assert.deepEqual(hostile.observations.map(row => row.family), ['Fine']);
  assert.equal(hostile.observations[0].url, 'https://threatfox.abuse.ch/browse/');
});

test('ThreatFox: a future timestamp is ignored, and briefing() caches an answer but not a failure', async () => {
  const future = parseThreatFox({ 1: ioc('Mirai', 'elf.mirai', -HOUR), 2: ioc('Vidar', 'win.vidar', HOUR) }, { now });
  assert.deepEqual(future.observations.map(row => row.family), ['Vidar']);
  let calls = 0;
  const good = async () => { calls++; return feed(['Vidar', 'win.vidar', 2, HOUR]); };
  assert.equal((await threatfoxBriefing({ fetcher: good, useCache: true, now })).status, 'ok');
  await threatfoxBriefing({ fetcher: good, useCache: true, now: now + 60000 });
  assert.equal(calls, 1, 'second call inside the cache window');
  assert.equal((await threatfoxBriefing({ fetcher: async () => { throw new Error('boom'); }, now })).status, 'error');
});

// Shaped like https://haveibeenpwned.com/api/v3/breaches (captured 2026-10-08).
const breach = (name, count, addedAgoMs, more = {}) => ({ Name: name, Title: name + ' Inc', Domain: name.toLowerCase() + '.com', BreachDate: '2026-09-07', AddedDate: new Date(now - addedAgoMs).toISOString().replace(/\.\d+Z$/, 'Z'),
  PwnCount: count, Description: '<a href="x">html</a>', DataClasses: ['Email addresses', 'Names'], IsVerified: true, IsFabricated: false, IsSensitive: false, IsRetired: false, IsSpamList: false, ...more });

test('HIBP: rows are the recent real breaches, newest first, rated by size; flagged ones are left out', () => {
  const result = parseHibp([breach('Small', 274922, 30 * HOUR), breach('Big', 17838396, 2 * HOUR), breach('Mid', 3155792, 5 * DAY), breach('Old', 5e6, 60 * DAY),
    breach('Adult', 9e6, HOUR, { IsSensitive: true }), breach('Fake', 9e6, HOUR, { IsFabricated: true }), breach('Spam', 9e6, HOUR, { IsSpamList: true }), breach('Gone', 9e6, HOUR, { IsRetired: true })], { now });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.observations.map(row => [row.providerId, row.severity]), [['Big', 'high'], ['Small', 'info'], ['Mid', 'moderate']]);
  const first = result.observations[0];
  assert.equal(first.title, 'Big Inc: 17,838,396 accounts exposed');
  assert.equal(first.domain, 'big.com');
  assert.equal(first.url, 'https://haveibeenpwned.com/PwnedWebsites#Big');
  assert(!first.summary.includes('<a'), 'the provider HTML description is never used');
});

test('HIBP: the catalogue feed time decides freshness; a reshaped or failed answer is an error; hostile fields are dropped', () => {
  assert.equal(parseHibp([breach('Late', 1e6, 16 * DAY)], { now }).status, 'stale');
  assert.equal(parseHibp([{ nope: 1 }], { now }).status, 'error');
  assert.equal(parseHibp({ error: 'HTTP 500' }, { now }).status, 'error');
  assert.equal(parseHibp({ not: 'a list' }, { now }).status, 'error');
  const hostile = parseHibp([breach('Ok', 5e6, HOUR, { Title: '<img onerror=x>Evil' + RTL, Domain: 'javascript:alert(1)' }), breach('bad name!', 5e6, HOUR)], { now });
  assert.equal(hostile.observations.length, 1);
  assert.equal(hostile.observations[0].title, 'Evil: 5,000,000 accounts exposed');
  assert.equal(hostile.observations[0].domain, undefined);
});

test('both sources are registered: cyber domain, normalised live rows with facts, and a briefing', async () => {
  assert.equal(domainOfSource('ThreatFox'), 'cyber'); assert.equal(domainOfSource('HIBP'), 'cyber');
  const live = normalizeLiveSources({ ThreatFox: parseThreatFox(feed(['Vidar', 'win.vidar', 4, HOUR]), { now }), HIBP: parseHibp([breach('Big', 2e6, HOUR)], { now }) }, now);
  assert.deepEqual(live.map(row => [row.source, row.status, row.observations.length]), [['ThreatFox', 'ok', 1], ['HIBP', 'ok', 1]]);
  assert.deepEqual(live[0].observations[0].facts.map(fact => fact.label), ['family', 'iocCount', 'c2Count']);
  assert.deepEqual(live[1].observations[0].facts.map(fact => fact.label), ['domain', 'pwnCount', 'breachDate']);
  assert.equal((await hibpBriefing({ fetcher: async () => [breach('Big', 2e6, HOUR)], now })).observations.length, 1);
});
