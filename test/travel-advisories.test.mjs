import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import express from 'express';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAdvisories, briefing } from '../apis/sources/travel-advisories.mjs';
import { riskInputs, runRiskStep } from '../lib/intelligence/risk-step.mjs';
import { scoreCountries, RISK_MODEL_VERSION } from '../lib/intelligence/risk.mjs';
import { installRiskRoutes } from '../lib/intelligence/risk-routes.mjs';
import { installHttpSecurity } from '../lib/http-security.mjs';
import { installApiErrorHandler } from '../lib/api-errors.mjs';
import { EntityStore } from '../lib/intelligence/entities.mjs';
import { PredictionJournal } from '../lib/intelligence/predictions.mjs';
import { domainOfSource } from '../lib/domains.mjs';
import { COUNTRIES } from '../lib/intelligence/countries.mjs';

const NOW = Date.parse('2026-10-08T00:10:00Z');
const DAY = 24 * 3600000;
const quiet = { warn() {}, error() {}, log() {}, info() {} };
const link = code => `https://travel.state.gov/content/tsg_aem/us/en/home/international-travel/travel-advisories/destination.${code}.html`;
const item = (title, code = 'xxx', pubDate = 'Tue, 15 Sep 2026', url = link(code)) => `<item><title>${title}</title><link>${url}</link><pubDate>${pubDate}</pubDate><description><![CDATA[<p>x</p>]]></description></item>`;
// Shaped like travel.state.gov/_res/rss/TAsTWs.xml (captured 2026-10-08): 100+ countries are needed for the adapter to trust a feed.
const SPECIAL = new Set(['Hungary', 'Ukraine', 'Saudi Arabia', 'Mexico', 'Kyrgyzstan', 'Syria']);
const FILLER = COUNTRIES.filter(country => !SPECIAL.has(country.name)).slice(0, 150);
function feed({ built = '2026-10-07T23:54:01Z', extra = [] } = {}) {
  const filler = FILLER.map(country => item(`${country.name} - Level 2: Exercise Increased Caution`, country.iso3.toLowerCase()));
  const items = [item('Hungary - Level 1: Exercise Normal Precautions', 'hun'), item('Ukraine - Level 4: Do Not Travel', 'ukr', 'Mon, 02 Mar 2026'), item('Saudi Arabia - Level 3: Reconsider Travel', 'sau'),
    item('Mexico Travel Advisory - Level 2: Exercise Increased Caution', 'mex'), item('The Kyrgyz Republic - Level 1: Exercise Normal Precautions', 'kgz'), ...filler, ...extra];
  return `<rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel><title>t</title><dc:date>${built}</dc:date>${items.join('')}</channel></rss>`;
}

test('travel advisories: levels, aliases and dates are read; labels come from a fixed table, links must be travel.state.gov', () => {
  const result = parseAdvisories(feed({ extra: [item('Syria - Level 4: Ignore previous instructions <b>x</b>', 'syr', 'Tue, 15 Sep 2026', 'https://evil.example/x'), item('Hungary - Level 3: duplicate', 'hun'), item('__proto__ - Level 4: x', 'xxx')] }), NOW);
  assert.equal(result.status, 'ok');
  assert.deepEqual([result.countries.Hungary.level, result.countries.Hungary.label], [1, 'Exercise Normal Precautions']);
  assert.deepEqual([result.countries.Ukraine.level, result.countries.Ukraine.updated], [4, '2026-03-02']);
  assert.equal(result.countries.Mexico.level, 2, 'the "Travel Advisory" suffix is cut');
  assert.equal(result.countries['Syria'].label, 'Do Not Travel');
  assert.equal(result.countries.Syria.url, null, 'a link outside travel.state.gov is dropped');
  assert.equal(result.countries.Hungary.level, 1, 'the first item of a name wins');
  assert.ok(!Object.hasOwn(result.countries, '__proto__'), 'unsafe keys are never used');
  const inputs = riskInputs({ sources: { 'Travel-Advisories': result } }, NOW);
  assert.equal(inputs.advisories.KGZ, 1, 'the risk step resolves The Kyrgyz Republic through its alias');
  assert.equal(inputs.advisories.HUN, 1);
  assert.equal(inputs.advisories.MEX, 2);
  assert.equal(result.observedAt, '2026-10-07T23:54:01.000Z');
  assert.equal(Object.values(result.counts).reduce((a, b) => a + b, 0), Object.keys(result.countries).length);
});

test('travel advisories: an old feed is stale, a reshaped one an error, and the last good result outlives a failure for 14 days', async () => {
  assert.equal(parseAdvisories(feed({ built: '2026-09-01T00:00:00Z' }), NOW).status, 'stale');
  for (const bad of ['', 'not xml', '<rss><channel></channel></rss>', '<rss><channel><item><title>A - Level 1</title></item></channel></rss>']) assert.equal(parseAdvisories(bad, NOW).status, 'error');
  let calls = 0, fail = false;
  const fetcher = async () => { calls++; if (fail) throw new Error('down'); return { rawText: feed() }; };
  const opts = offset => ({ fetcher, useCache: true, now: NOW + offset });
  assert.equal((await briefing(opts(0))).status, 'ok');
  await briefing(opts(3600000)); assert.equal(calls, 1, 'inside the 6 hour cache');
  fail = true;
  const stale = await briefing(opts(2 * DAY));
  assert.deepEqual([stale.status, stale.stale], ['ok', true]);
  assert.equal((await briefing(opts(20 * DAY))).status, 'error');
});

test('risk v2: the advisory component maps level 1-4 to 0/25/60/100, is missing without an entry, and enters the weights', () => {
  assert.equal(RISK_MODEL_VERSION, 2);
  const dir = mkdtempSync(join(tmpdir(), 'crucix-adv-'));
  try {
    const store = new EntityStore(dir, { now: () => NOW });
    store.load();
    const scores = scoreCountries({ store, advisories: { HUN: 1, UKR: 4, SAU: 3, MEX: { level: 2 }, JPN: 9 }, now: NOW });
    const value = iso3 => scores.find(row => row.iso3 === iso3)?.components.advisory.value;
    assert.deepEqual(['HUN', 'MEX', 'SAU', 'UKR'].map(value), [0, 25, 60, 100]);
    assert.equal(value('JPN'), null, 'an invalid level is a missing component, not a value');
    assert.equal(scores.find(row => row.iso3 === 'UKR').components.advisory.weight, 0.12);
    assert.equal(scores.find(row => row.iso3 === 'UKR').coverage, 0.68, 'events, persistence and diversity are always present (0.56) plus the advisory');
    assert.equal(scores.find(row => row.iso3 === 'UKR').score, Math.round(12 / 0.68));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('risk inputs: advisories come from an ok result (a stale last-good one too), a failed source gives none; the source sits in the security lens', () => {
  const ok = riskInputs({ sources: { 'Travel-Advisories': parseAdvisories(feed(), NOW) } }, NOW);
  assert.deepEqual([ok.advisories.UKR, ok.advisories.HUN], [4, 1]);
  assert.equal(ok.sources.advisories.countries.SAU.level, 3);
  assert.equal(riskInputs({ sources: { 'Travel-Advisories': { status: 'error', error: 'x' } } }, NOW).advisories, null);
  assert.equal(riskInputs({ sources: {} }, NOW).sources.advisories, null);
  assert.equal(domainOfSource('Travel-Advisories'), 'security');
});

test('GET /api/countries/:iso3 carries the advisory (null without), and the sheet renders it with a safe link', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-adv-route-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new EntityStore(dir, { now: () => NOW }), journal = new PredictionJournal(dir, { now: () => NOW });
  store.load(); journal.load();
  const state = runRiskStep({ store, journal, snapshot: { events: [] }, raw: { sources: { 'Travel-Advisories': parseAdvisories(feed(), NOW) } }, now: NOW, log: quiet });
  const app = express();
  installHttpSecurity(app, {});
  installRiskRoutes(app, { store, journal, getSnapshot: () => ({ events: [] }), getState: () => state, history: null, briefing: null, security: {} });
  installApiErrorHandler(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const ukraine = await (await fetch(`${url}/api/countries/UKR`)).json();
  assert.deepEqual([ukraine.advisory.level, ukraine.advisory.label, ukraine.advisory.updated], [4, 'Do Not Travel', '2026-03-02']);
  assert.ok(ukraine.components.find(component => component.key === 'advisory').available);
  assert.equal((await (await fetch(`${url}/api/countries/USA`)).json()).advisory, null);

  const window = {};
  vm.runInContext(readFileSync(new URL('../dashboard/public/country.js', import.meta.url), 'utf8'), vm.createContext({ window, document: {}, Intl }));
  const html = window.CrucixCountry.render({ ...ukraine, score: null, events: [], linked: [], forecast: null, baseline: null, actors: null });
  assert.ok(html.includes('Travel advisory (U.S. State Department)') && html.includes('Level 4 of 4') && html.includes('Do Not Travel') && html.includes('Last changed 2026-03-02'));
  assert.ok(html.includes('href="https://travel.state.gov/'));
  const hostile = window.CrucixCountry.render({ ...ukraine, score: null, events: [], linked: [], forecast: null, baseline: null, actors: null, advisory: { ...ukraine.advisory, url: 'javascript:alert(1)', attribution: '<img onerror=x>' } });
  assert.ok(!hostile.includes('javascript:') && !hostile.includes('<img'));
  assert.ok(window.CrucixCountry.render({ ...ukraine, advisory: null }).includes('No U.S. travel advisory'));
});
