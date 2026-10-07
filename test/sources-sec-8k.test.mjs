import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSec8k, briefing } from '../apis/sources/sec-8k.mjs';
import { normalizeLiveSources } from '../lib/intelligence/live-sources.mjs';
import { domainOfSource } from '../lib/domains.mjs';

const now = Date.parse('2026-10-08T00:10:00Z');
const DAY = 24 * 3600000;
const RTL = String.fromCharCode(0x202e);
const day = ms => new Date(ms).toISOString().slice(0, 10);
// Shaped like https://efts.sec.gov/LATEST/search-index (captured 2026-10-08): one hit per document, `items` repeated on every document of a filing.
const hit = (adsh, doc, ageMs, more = {}) => ({ _id: `${adsh}:${doc}`, _source: { ciks: ['0000885725'], display_names: ['BOSTON SCIENTIFIC CORP  (BSX)  (CIK 0000885725)'], file_date: day(now - ageMs),
  form: '8-K', adsh, items: ['1.05'], file_type: '8-K', root_forms: ['8-K'], ...more } });
const answer = (...hits) => ({ took: 5, hits: { total: { value: hits.length, relation: 'eq' }, hits } });

test('SEC 8-K: Item 1.05 filings become high rows, newest first, one per filing, linked to the main document', () => {
  const result = parseSec8k([
    answer(hit('0000885725-26-000059', 'bsx-20260907.htm', 30 * DAY), hit('0000885725-26-000059', 'ex99.htm', 30 * DAY, { file_type: 'EX-99.1' }), hit('0001104659-26-109813', 'asth.htm', 14 * DAY, { form: '8-K/A', file_type: '8-K/A', display_names: ['Astrana Health, Inc.  (ASTH)  (CIK 0001083446)'], ciks: ['0001083446'] })),
    answer(hit('0000885725-26-000059', 'bsx-20260907.htm', 30 * DAY), hit('0000111111-26-000001', 'other.htm', 2 * DAY, { items: ['8.01', '9.01'] }), hit('0000222222-26-000001', 'old.htm', 120 * DAY)),
  ], { now });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.observations.map(row => [row.providerId, row.severity, row.formType]), [['0001104659-26-109813', 'high', '8-K/A'], ['0000885725-26-000059', 'high', '8-K']]);
  const [astrana, bsx] = result.observations;
  assert.equal(bsx.title, 'BOSTON SCIENTIFIC CORP (BSX): material cybersecurity incident disclosed (8-K Item 1.05)');
  assert.equal(bsx.url, 'https://www.sec.gov/Archives/edgar/data/885725/000088572526000059/bsx-20260907.htm');
  assert.equal(bsx.cik, '885725'); assert.equal(astrana.company, 'Astrana Health, Inc.'); assert.ok(astrana.title.includes('amended'));
  assert.equal(result.license, 'Public domain (U.S. Government work)');
});

test('SEC 8-K: a quiet quarter is expired, one failed phrase is a partial answer, failures and reshaped answers are errors', () => {
  assert.equal(parseSec8k([answer(hit('0000885725-26-000059', 'a.htm', 100 * DAY))], { now }).status, 'stale');
  const partial = parseSec8k([{ error: 'HTTP 429' }, answer(hit('0000885725-26-000059', 'a.htm', 3 * DAY))], { now });
  assert.equal(partial.status, 'ok'); assert.ok(partial.summary.includes('1 of the 2 search requests failed'));
  assert.equal(parseSec8k([{ error: 'HTTP 500 https://efts.sec.gov/secret' }, { error: 'x' }], { now }).status, 'error');
  assert.equal(parseSec8k([{ error: 'HTTP 500 https://efts.sec.gov/secret' }, { error: 'x' }], { now }).error.includes('https://'), false);
  for (const bad of [null, [], { nope: 1 }, [{ hits: 'x' }], answer({ foo: 1 }, { _source: 3 })]) assert.equal(parseSec8k(bad, { now }).status, 'error');
});

test('SEC 8-K: hostile names, odd links and out-of-range values are dropped; a future filing day is ignored', () => {
  const hostile = parseSec8k([answer(
    hit('0000000001-26-000001', 'a.htm', DAY, { display_names: ['<img onerror=x>Evil Corp' + RTL + '  (EVIL)  (CIK 0000000001)'] }),
    hit('0000000002-26-000001', '../../etc/passwd', DAY, { display_names: ['Path Corp  (PATH)  (CIK 0000000002)'] }),
    hit('bad-accession', 'b.htm', DAY), hit('0000000003-26-000001', 'c.htm', DAY, { ciks: ['not-a-cik'] }), hit('0000000004-26-000001', 'd.htm', -3 * DAY),
  )], { now });
  assert.deepEqual(hostile.observations.map(row => row.company), ['Path Corp', 'Evil Corp']);
  const path = hostile.observations.find(row => row.company === 'Path Corp');
  assert.equal(path.url, 'https://www.sec.gov/Archives/edgar/data/885725/000000000226000001/', 'an odd document name falls back to the filing folder');
  assert.ok(!hostile.observations.some(row => /[<>‮]/.test(row.title)));
});

test('SEC 8-K briefing: two spaced requests, an hour of cache, SEC_USER_AGENT only when well-formed', async () => {
  const calls = [];
  const fetcher = async (url, request) => { calls.push({ url, agent: request.headers?.['User-Agent'] }); return answer(hit('0000885725-26-000059', 'a.htm', 3 * DAY)); };
  const run = options => briefing({ fetcher, useCache: true, pause: 0, now, ...options });
  assert.equal((await run()).observations.length, 1);
  assert.deepEqual(calls.map(call => decodeURIComponent(new URL(call.url).searchParams.get('q'))), ['"Material Cybersecurity Incidents"', '"Item 1.05"']);
  assert.ok(calls.every(call => call.agent === undefined && new URL(call.url).searchParams.get('forms') === '8-K'));
  await run({ now: now + 60000 }); assert.equal(calls.length, 2, 'cached');
  process.env.SEC_USER_AGENT = 'Example Org ops@example.org';
  await run({ now: now + 2 * 3600000 }); assert.equal(calls.at(-1).agent, 'Example Org ops@example.org');
  process.env.SEC_USER_AGENT = 'bad\u0001agent';
  await run({ now: now + 4 * 3600000 }); assert.equal(calls.at(-1).agent, undefined);
  delete process.env.SEC_USER_AGENT;
});

test('SEC 8-K is registered: cyber domain, normalised rows with the company facts', () => {
  assert.equal(domainOfSource('SEC-8K'), 'cyber');
  const live = normalizeLiveSources({ 'SEC-8K': parseSec8k([answer(hit('0000885725-26-000059', 'a.htm', 3 * DAY))], { now }) }, now);
  assert.deepEqual([live[0].source, live[0].status, live[0].observations.length], ['SEC-8K', 'ok', 1]);
  assert.deepEqual(live[0].observations[0].facts.map(fact => [fact.label, fact.value]), [['company', 'BOSTON SCIENTIFIC CORP'], ['ticker', 'BSX'], ['formType', '8-K'], ['cik', '885725']]);
});
