import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import express from 'express';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMispGalaxy, briefing } from '../apis/sources/misp-galaxy.mjs';
import { riskInputs, runRiskStep } from '../lib/intelligence/risk-step.mjs';
import { installRiskRoutes } from '../lib/intelligence/risk-routes.mjs';
import { installHttpSecurity } from '../lib/http-security.mjs';
import { installApiErrorHandler } from '../lib/api-errors.mjs';
import { EntityStore } from '../lib/intelligence/entities.mjs';
import { PredictionJournal } from '../lib/intelligence/predictions.mjs';
import { domainOfSource } from '../lib/domains.mjs';

const NOW = Date.parse('2026-10-08T00:10:00Z');
const DAY = 24 * 3600000;
const RTL = String.fromCharCode(0x202e);
const quiet = { warn() {}, error() {}, log() {}, info() {} };
// Shaped like MISP/misp-galaxy clusters/threat-actor.json (captured 2026-10-08): { version, values: [{ value, uuid, meta: { country, synonyms } }] }.
const actor = (value, country, synonyms = []) => ({ value, uuid: 'u-' + value, description: 'x', meta: { ...(country ? { country } : {}), synonyms, refs: ['https://example.org'] } });
const GALAXY = { version: 352, values: [actor('APT28', 'RU', ['Fancy Bear', 'Sofacy', 'Pawn Storm', 'Strontium', 'Sednit']), actor('Turla', 'RU', ['Snake']), actor('Sandworm', 'RU'),
  actor('Lazarus Group', 'KP', ['Hidden Cobra']), actor('NoCountry', null, ['A']), actor('Odd', 'XX', ['b'])] };

test('MISP Galaxy: groups are counted per attributed country, the best-known first, and capped; unattributed actors are not placed', () => {
  const result = parseMispGalaxy({ version: 352, values: [...GALAXY.values, ...Array.from({ length: 20 }, (_, i) => actor('Group' + i, 'CN', ['alias' + i]))] }, NOW);
  assert.equal(result.status, 'ok');
  assert.equal(result.attributed, 25);
  assert.deepEqual(Object.keys(result.countries), ['CN', 'KP', 'RU', 'XX']);
  assert.deepEqual(result.countries.RU.groups.map(group => group.name), ['APT28', 'Turla', 'Sandworm']);
  assert.deepEqual(result.countries.RU.groups[0].aliases, ['Fancy Bear', 'Sofacy', 'Pawn Storm', 'Strontium']);
  assert.equal(result.countries.CN.count, 20); assert.equal(result.countries.CN.groups.length, 12);
  assert.equal(result.license, 'CC0 1.0 / BSD');
});

test('MISP Galaxy: hostile or reshaped input is dropped or an error, never shown as written', () => {
  const hostile = parseMispGalaxy({ version: 1, values: [actor('Evil' + RTL, 'RU', ['<img onerror=x>', 'ok']), actor('<script>alert(1)</script>', 'RU'), actor('Fine', 'RU', ['Fine', 'Fine', 'Alias'])] }, NOW);
  assert.deepEqual(hostile.countries.RU.groups, [{ name: 'Evil', aliases: ['ok'] }, { name: 'scriptalert(1)/script', aliases: [] }, { name: 'Fine', aliases: ['Alias'] }].sort((a, b) => b.aliases.length - a.aliases.length || (a.name < b.name ? -1 : 1)));
  for (const bad of [null, [], { values: 'x' }, { values: [{ nope: 1 }, { nope: 2 }, 3] }, { values: [actor('Only', null)] }, { error: 'HTTP 500', status: 500 }]) assert.equal(parseMispGalaxy(bad, NOW).status, 'error');
  assert.ok(!parseMispGalaxy({ error: 'boom https://secret.example/x' }, NOW).error.includes('https://'));
});

test('MISP Galaxy: cached for 7 days, the last good result outlives a failure for 45 days as stale, then it is an error', async () => {
  let calls = 0, fail = false;
  const fetcher = async () => { calls++; if (fail) throw new Error('down'); return GALAXY; };
  const opts = (offset, extra = {}) => ({ fetcher, useCache: true, now: NOW + offset, ...extra });
  assert.equal((await briefing(opts(0))).status, 'ok');
  await briefing(opts(3 * DAY)); assert.equal(calls, 1, 'inside the 7 day cache');
  fail = true;
  const stale = await briefing(opts(10 * DAY));
  assert.deepEqual([stale.status, stale.stale, calls], ['ok', true, 2]);
  assert.equal((await briefing(opts(50 * DAY))).status, 'error');
});

test('risk inputs: the groups are keyed by the gazetteer alpha-3 code, unknown codes dropped, a failed source gives none', () => {
  const ok = riskInputs({ sources: { 'MISP-Galaxy': parseMispGalaxy(GALAXY, NOW) } }, NOW);
  assert.deepEqual(Object.keys(ok.sources.actors.countries).sort(), ['PRK', 'RUS']);
  assert.equal(ok.sources.actors.license, 'CC0 1.0 / BSD');
  assert.equal(riskInputs({ sources: { 'MISP-Galaxy': { status: 'error', error: 'x' } } }, NOW).sources.actors, null);
  assert.equal(riskInputs({ sources: {} }, NOW).sources.actors, null);
  assert.equal(domainOfSource('MISP-Galaxy'), 'cyber');
});

test('GET /api/countries/:iso3 carries the actors of a country (12 at most), null for a country without; the sheet renders them escaped', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-actors-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new EntityStore(dir, { now: () => NOW }), journal = new PredictionJournal(dir, { now: () => NOW });
  store.load(); journal.load();
  const galaxy = parseMispGalaxy({ version: 352, values: [...GALAXY.values, actor('<img onerror=x>Bad', 'RU', ['x'])] }, NOW);
  const state = runRiskStep({ store, journal, snapshot: { events: [] }, raw: { sources: { 'MISP-Galaxy': galaxy } }, now: NOW, log: quiet });
  const app = express();
  installHttpSecurity(app, {});
  installRiskRoutes(app, { store, journal, getSnapshot: () => ({ events: [] }), getState: () => state, history: null, briefing: null, security: {} });
  installApiErrorHandler(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const russia = await (await fetch(`${url}/api/countries/RUS`)).json();
  assert.equal(russia.actors.count, 3);
  assert.deepEqual(russia.actors.groups.slice(0, 2).map(group => group.name), ['APT28', 'Turla']);
  assert.equal((await (await fetch(`${url}/api/countries/JPN`)).json()).actors, null);

  const window = {};
  vm.runInContext(readFileSync(new URL('../dashboard/public/country.js', import.meta.url), 'utf8'), vm.createContext({ window, document: {}, Intl }));
  const html = window.CrucixCountry.render({ ...russia, score: null, events: [], linked: [], forecast: null, baseline: null });
  assert.ok(html.includes('Threat actor groups') && html.includes('<strong>APT28</strong>') && html.includes('also known as Fancy Bear, Sofacy'));
  assert.ok(html.includes('not a proven finding') && !html.includes('<img'));
  assert.ok(window.CrucixCountry.render({ ...russia, actors: null }).includes('No threat actor group is attributed'));
});
