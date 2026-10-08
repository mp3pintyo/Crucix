import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import vm from 'node:vm';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countryByIso3, countryByName, countryDisplayName } from '../lib/intelligence/countries.mjs';
import { EntityStore } from '../lib/intelligence/entities.mjs';
import { PredictionJournal } from '../lib/intelligence/predictions.mjs';
import { runRiskStep } from '../lib/intelligence/risk-step.mjs';
import { installRiskRoutes } from '../lib/intelligence/risk-routes.mjs';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const HOUR = 3600000;
const quiet = { warn() {}, error() {}, log() {}, info() {} };
const at = ms => new Date(ms).toISOString();
const locale = code => JSON.parse(readFileSync(new URL(`../locales/${code}.json`, import.meta.url), 'utf8'));

// Located events in Japan and Hungary, and a report naming Japan and South Korea (a linked country).
const events = () => [
  { id: 'event-1', kind: 'earthquake', title: 'M6.4 earthquake near Tokyo', summary: '', severity: 'high', observedAt: at(NOW - HOUR), location: { lat: 35.68, lon: 139.69, method: 'provider', label: null } },
  { id: 'event-2', kind: 'news', title: 'Japan and South Korea hold emergency talks', summary: '', severity: 'moderate', observedAt: at(NOW - 2 * HOUR), location: { lat: 0, lon: 0, method: 'headline-keyword', label: 'World' } },
  { id: 'event-3', kind: 'outage', title: 'Internet outage in Hungary', summary: '', severity: 'high', observedAt: at(NOW - 3 * HOUR), location: { lat: 47.5, lon: 19.04, method: 'provider', label: null } },
];

function stores(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-display-names-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new EntityStore(dir, { now: () => NOW });
  const journal = new PredictionJournal(dir, { now: () => NOW });
  store.load(); journal.load();
  return { store, journal };
}

test('countryDisplayName: the CLDR name in the language, the English gazetteer name for English or an unusable language, null for an unknown code', () => {
  assert.equal(countryDisplayName('HUN', 'hu'), 'Magyarország');
  assert.equal(countryDisplayName('HUN', 'hu-HU'), 'Magyarország');
  assert.equal(countryDisplayName('HUN', 'en'), 'Hungary');
  assert.equal(countryDisplayName('HUN', 'fr'), 'Hongrie');
  assert.equal(countryDisplayName('hun', 'hu'), 'Magyarország', 'the code is case-insensitive like countryByIso3');
  assert.equal(countryDisplayName('XKX', 'hu'), 'Koszovó', 'Kosovo (user-assigned XK) resolves in ICU');
  // English keeps the gazetteer spelling, not ICU's ("Palestinian Territories").
  assert.equal(countryDisplayName('PSE', 'en'), countryByIso3('PSE').name);
  for (const odd of ['xx', 'not a tag!', '', null, 42]) assert.equal(countryDisplayName('HUN', odd), 'Hungary', String(odd));
  for (const code of ['QQQ', '', null, undefined]) assert.equal(countryDisplayName(code, 'hu'), null, String(code));
  // Display only: matching still runs on the English names.
  assert.equal(countryByIso3('HUN').name, 'Hungary');
  assert.equal(countryByName('Magyarország'), null);
});

test('the risk summary and the risk routes carry displayName in the server language next to the English name', async t => {
  const { store, journal } = stores(t);
  const snapshot = { events: events() };
  const state = runRiskStep({ store, journal, snapshot, raw: null, now: NOW, log: quiet, language: 'hu' });
  assert.equal(state.ok, true);
  const japan = snapshot.risk.top.find(row => row.iso3 === 'JPN');
  assert.deepEqual([japan.name, japan.displayName], ['Japan', 'Japán']);
  assert.equal(snapshot.risk.top.find(row => row.iso3 === 'HUN').displayName, 'Magyarország');
  assert.equal(state.scores.find(row => row.iso3 === 'JPN').name, 'Japan', 'the score rows keep the English name');
  const english = { events: events() };
  runRiskStep({ store, snapshot: english, raw: null, now: NOW, log: quiet });
  assert.equal(english.risk.top.find(row => row.iso3 === 'JPN').displayName, 'Japan', 'English by default');

  const app = express();
  installRiskRoutes(app, { store, journal, getSnapshot: () => snapshot, getState: () => state, security: {}, language: 'hu' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const list = await (await fetch(`${url}/api/countries`)).json();
  const row = list.countries.find(item => item.iso3 === 'HUN');
  assert.deepEqual([row.name, row.displayName], ['Hungary', 'Magyarország']);
  const profile = await (await fetch(`${url}/api/countries/JPN`)).json();
  assert.deepEqual([profile.name, profile.displayName], ['Japan', 'Japán']);
  assert.deepEqual(profile.linked.map(item => [item.name, item.displayName]), [['South Korea', 'Dél-Korea']]);
  const predictions = await (await fetch(`${url}/api/predictions`)).json();
  assert.ok(predictions.recent.length > 0 && predictions.recent.every(item => typeof item.name === 'string' && typeof item.displayName === 'string'));
  assert.equal(predictions.recent.find(item => item.iso3 === 'JPN').displayName, 'Japán');
});

test('the idea enum labels exist in every locale at the same place; English shows the enum itself', () => {
  const keys = ['type_LONG', 'type_SHORT', 'type_HEDGE', 'type_WATCH', 'type_AVOID', 'confidence_HIGH', 'confidence_MEDIUM', 'confidence_LOW',
    'confidenceBadge', 'horizon_Intraday', 'horizon_Days', 'horizon_Weeks', 'horizon_Months'];
  const english = locale('en').ideas;
  for (const code of ['en', 'fr', 'hu']) {
    const ideas = locale(code).ideas;
    assert.deepEqual(Object.keys(ideas).filter(key => keys.includes(key)), keys, code);
    for (const key of keys) assert.ok(typeof ideas[key] === 'string' && ideas[key].trim(), `${code}: ideas.${key}`);
    assert.ok(ideas.confidenceBadge.includes('{level}'), `${code}: the badge places the level`);
  }
  for (const key of keys.filter(key => key !== 'confidenceBadge')) assert.equal(english[key], key.slice(key.indexOf('_') + 1), key);
  assert.equal(english.confidenceBadge, '{level} confidence');
});

test('the trade ideas panel shows translated enum labels and keeps the enum as the CSS class', () => {
  const html = readFileSync(new URL('../dashboard/public/jarvis.html', import.meta.url), 'utf8');
  const start = html.indexOf('function buildTradeIdeasPanel(');
  const source = html.slice(start, html.indexOf('\nfunction ', start + 1));
  const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const translator = messages => (path, fallback) => { let value = messages; for (const key of path.split('.')) value = value && typeof value === 'object' && key in value ? value[key] : undefined; return typeof value === 'string' ? value : fallback || path; };
  const ideas = [{ type: 'HEDGE', title: 'Gold hedge', ticker: 'GLD', confidence: 'HIGH', horizon: 'Weeks', rationale: 'r' }];
  const render = messages => vm.runInNewContext(`${source}\nbuildTradeIdeasPanel`, {
    D: { ideas, ideasSource: 'llm' }, t: translator(messages), esc, getAge: () => '', ideaTypeClass: value => String(value).toLowerCase(),
  })();
  const hu = render(locale('hu'));
  assert.match(hu, /<span class="idea-type hedge">FEDEZÉS<\/span>/);
  assert.match(hu, /<span class="idea-horizon">Hetek<\/span>/);
  assert.match(hu, /<span class="idea-conf">MAGAS bizonyosság<\/span>/);
  const en = render(locale('en'));
  assert.match(en, /<span class="idea-type hedge">HEDGE<\/span>/);
  assert.match(en, /<span class="idea-horizon">Weeks<\/span>/);
  assert.match(en, /<span class="idea-conf">HIGH confidence<\/span>/);
  assert.equal(ideas[0].type, 'HEDGE', 'the stored idea is not changed');
});
