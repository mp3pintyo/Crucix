import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FACT_FIELDS } from '../lib/intelligence/live-sources.mjs';
import { DEFAULT_RULES, RULE_KINDS } from '../lib/alerts/rules.mjs';
import { METRICS } from '../lib/alerts/metrics.mjs';
import { DOMAIN_IDS } from '../lib/domains.mjs';
import { AREAS, VESSEL_TYPES } from '../apis/sources/ships.mjs';

const LANGS = ['en', 'hu', 'fr'];
const locale = lang => JSON.parse(fs.readFileSync(new URL(`../locales/${lang}.json`, import.meta.url), 'utf8'));
const flatten = (value, prefix) => Object.entries(value || {}).flatMap(([key, item]) => item && typeof item === 'object' ? flatten(item, `${prefix}.${key}`) : [[`${prefix}.${key}`, item]]);
const flat = lang => { const data = locale(lang); return new Map([...flatten(data.liveSources, 'liveSources'), ...flatten(data.inspector, 'inspector'), ...flatten(data.alerts, 'alerts'), ...flatten(data.lenses, 'lenses')]); };
const factKeys = [...new Set(Object.values(FACT_FIELDS).flat())];
const BUILTIN_RULES = DEFAULT_RULES.map(rule => rule.id);
const ALERT_UI_KEYS = ['title', 'threat', 'calm', 'lastEval', 'ack', 'snooze', 'resolve', 'open', 'close', 'ackAll', 'tabActive', 'tabHandled', 'tabResolved', 'tabRules', 'empty',
  'firing', 'acked', 'snoozedUntil', 'resolvedAt', 'count', 'rule', 'evidence', 'drivers', 'snooze1h', 'snooze8h', 'snooze24h', 'more', 'errorLoad', 'errorAction', 'errorOrigin', 'unavailable', 'silent', 'toastNew'];

test('liveSources, inspector, alerts and lenses strings have identical keys, in the same order, in en, hu and fr', () => {
  const [en, ...others] = LANGS.map(lang => [...flat(lang).keys()]);
  assert.ok(en.length > 60, 'the inspector group is present');
  assert.ok(en.includes('alerts.calm') && en.includes('alerts.tiers.flash.label'), 'the alerts group is covered');
  assert.ok(en.includes('lenses.all') && en.includes('lenses.health'), 'the lenses group is covered');
  for (const keys of others) assert.deepEqual(keys, en);
});

test('every liveSources, inspector, alerts and lenses value is a non-empty string', () => {
  for (const lang of LANGS) for (const [key, value] of flat(lang)) assert.ok(typeof value === 'string' && value.trim() !== '', `${lang}: ${key}`);
});

// The live panel's group headers and the lens bar's announcement (live-sources.js, lens.js), after the domain names.
const LENS_UI_KEYS = ['sourceCount', 'sourceCountOne', 'recordCount', 'recordCountOne', 'attention', 'moreSources', 'noLiveSources', 'noSources', 'status'];

test('the lenses group names "all", the lens bar and each domain of the registry, in registry order, then the group-header strings', () => {
  for (const lang of LANGS) assert.deepEqual(Object.keys(locale(lang).lenses), ['all', 'label', ...DOMAIN_IDS, ...LENS_UI_KEYS], `${lang}: lenses keys`);
  assert.deepEqual(['en', 'hu', 'fr'].map(lang => locale(lang).lenses.all), ['All', 'Mind', 'Tous']);
});

// Every string of the AIS vessel popups (jarvis.html aisVesselText): one per type group and chokepoint apis/sources/ships.mjs emits.
const MARITIME_KEYS = ['meta', 'mmsi', 'speed', 'speedUnknown', 'lastSeen', 'typeUnknown', ...VESSEL_TYPES.map(type => 'type_' + type), ...AREAS.map(area => 'area_' + area.id)];

test('the maritime group has the same keys in the same order in en, hu and fr, each a plain non-empty string with its placeholders', () => {
  for (const lang of LANGS) {
    const group = locale(lang).maritime;
    assert.deepEqual(Object.keys(group || {}), MARITIME_KEYS, `${lang}: maritime keys`);
    for (const key of MARITIME_KEYS) assert.ok(typeof group[key] === 'string' && group[key].trim() !== '' && !/[<>]/.test(group[key]), `${lang}: maritime.${key}`);
    for (const [key, slot] of [['mmsi', '{mmsi}'], ['speed', '{speed}'], ['lastSeen', '{age}']]) assert.ok(group[key].includes(slot), `${lang}: maritime.${key} has ${slot}`);
  }
  assert.deepEqual(LANGS.map(lang => locale(lang).maritime.type_tanker), ['tanker', 'tartályhajó', 'navire-citerne']);
});

// Every string replay.js renders, in locale order (the same order in en, hu and fr).
const REPLAY_KEYS = ['button', 'region', 'banner', 'slider', 'prev', 'next', 'backToLive', 'dismiss', 'loading', 'error', 'notFound', 'newerLive', 'alertsLive', 'historyUnavailable', 'noSweeps', 'position', 'unknownTime'];

test('the replay group has the same keys in the same order in en, hu and fr, each a non-empty string', () => {
  for (const lang of LANGS) {
    const group = locale(lang).replay;
    assert.deepEqual(Object.keys(group || {}), REPLAY_KEYS, `${lang}: replay keys`);
    for (const key of REPLAY_KEYS) assert.ok(typeof group[key] === 'string' && group[key].trim() !== '', `${lang}: replay.${key}`);
    assert.ok(group.newerLive.includes('{count}'), `${lang}: replay.newerLive names the count`);
    assert.ok(group.position.includes('{index}') && group.position.includes('{total}'), `${lang}: replay.position`);
  }
  assert.deepEqual(LANGS.map(lang => locale(lang).replay.button), ['Replay', 'Visszajátszás', 'Relecture']);
});

// Every string health-matrix.js renders (the dialog, the legend, the table words and the messages), in locale order.
const MATRIX_KEYS = ['title', 'trigger', 'caption', 'openHint', 'sweeps', 'source', 'ms', 'stateOk', 'stateStale', 'stateError', 'stateDisabled', 'stateNoData', 'other', 'loading', 'empty', 'noSources', 'error', 'close'];

test('the matrix group has the same keys in the same order in en, hu and fr, each a non-empty string', () => {
  for (const lang of LANGS) {
    const group = locale(lang).matrix;
    assert.deepEqual(Object.keys(group || {}), MATRIX_KEYS, `${lang}: matrix keys`);
    for (const key of MATRIX_KEYS) assert.ok(typeof group[key] === 'string' && group[key].trim() !== '', `${lang}: matrix.${key}`);
    assert.ok(!/[<>]/.test(Object.values(group).join('')), `${lang}: plain text, no markup`);
  }
  assert.deepEqual(LANGS.map(lang => locale(lang).matrix.title), ['Source health matrix', 'Forrásállapot-mátrix', 'Matrice de santé des sources']);
  // The five cell states are told apart in every language (a glyph is never the only signal, and the words must not collapse).
  for (const lang of LANGS) assert.equal(new Set(['stateOk', 'stateStale', 'stateError', 'stateDisabled', 'stateNoData'].map(key => locale(lang).matrix[key])).size, 5, `${lang}: five distinct state words`);
});

// Every string of the command palette (palette.js and the page's action/source items in jarvis.html), in locale order.
const PALETTE_KEYS = ['dialogLabel', 'button', 'inputLabel', 'placeholder', 'resultsLabel', 'groupActions', 'groupSources', 'groupRecords', 'lens', 'lensHint', 'lensActive',
  'openAlerts', 'openSettings', 'openGlossary', 'openMatrix', 'openBrowser', 'startReplay', 'exitReplay', 'openChanges', 'openRecords', 'showHealth',
  'searching', 'empty', 'historyFailed', 'replayNote', 'count', 'countOne', 'countNone', 'keys'];

test('the palette group has the same keys in the same order in en, hu and fr, each a plain non-empty string', () => {
  for (const lang of LANGS) {
    const group = locale(lang).palette;
    assert.deepEqual(Object.keys(group || {}), PALETTE_KEYS, `${lang}: palette keys`);
    for (const key of PALETTE_KEYS) assert.ok(typeof group[key] === 'string' && group[key].trim() !== '', `${lang}: palette.${key}`);
    assert.ok(!/[<>]/.test(Object.values(group).join('')), `${lang}: plain text, no markup`);
    for (const [key, name] of [['lens', 'name'], ['openRecords', 'source'], ['showHealth', 'source'], ['count', 'count'], ['countOne', 'count']]) assert.ok(group[key].includes(`{${name}}`), `${lang}: palette.${key} names {${name}}`);
    for (const key of ['Enter', 'Esc']) assert.ok(group.keys.includes(key) || (lang === 'fr' && group.keys.includes(key === 'Enter' ? 'Entrée' : 'Échap')), `${lang}: palette.keys names ${key}`);
  }
  assert.deepEqual(LANGS.map(lang => locale(lang).palette.dialogLabel), ['Command palette', 'Parancspaletta', 'Palette de commandes']);
});

test('the alert UI has every string it renders, a name for each built-in rule and the inspector level words', () => {
  assert.equal(BUILTIN_RULES.length, 8, 'the built-in rule pack');
  for (const lang of LANGS) {
    const strings = flat(lang);
    for (const key of ALERT_UI_KEYS) assert.ok(strings.has(`alerts.${key}`), `${lang}: alerts.${key}`);
    for (const id of BUILTIN_RULES) assert.ok(strings.has(`alerts.ruleNames.${id}`), `${lang}: alerts.ruleNames.${id}`);
    for (const level of ['critical', 'high', 'watch', 'info']) assert.equal(strings.get(`alerts.level.${level}`), strings.get(`inspector.level.${level}`), `${lang}: alerts.level.${level}`);
  }
  assert.equal(flat('en').get('alerts.calm'), 'No active alerts');
});

test('liveSources.showRecords is retired and the new record labels exist', () => {
  for (const lang of LANGS) {
    const strings = flat(lang);
    assert.ok(!strings.has('liveSources.showRecords'), `${lang}: showRecords`);
    for (const key of ['liveSources.openRecords', 'liveSources.topRecords']) assert.ok(strings.has(key), `${lang}: ${key}`);
  }
});

test('inspector.fact has a label for every fact key a live source can emit', () => {
  assert.ok(factKeys.length >= 20, 'FACT_FIELDS yields its keys');
  for (const lang of LANGS) {
    const strings = flat(lang);
    for (const key of factKeys) assert.ok(strings.has(`inspector.fact.${key}`), `${lang}: inspector.fact.${key}`);
  }
});

test('the French outdated badge reads as a negation, not as "more up to date"', () => {
  assert.equal(flat('fr').get('inspector.outdated'), 'N’est plus à jour');
});

test('the browser key hint lists only keys the browser has (no e, Esc goes back)', () => {
  for (const lang of LANGS) {
    const strings = flat(lang), panel = strings.get('inspector.keys'), browser = strings.get('inspector.keysBrowser');
    assert.ok(browser && browser !== panel, `${lang}: inspector.keysBrowser`);
    for (const key of ['j/k', 'Enter', '/', 'Esc']) assert.ok(browser.includes(key), `${lang}: ${key}`);
    assert.ok(!/(^| )e /.test(browser), `${lang}: the browser has no e key`);
  }
  assert.ok(/(^| )e /.test(flat('en').get('inspector.keys')), 'the panel keeps e expand');
});

test('the rule editor names every rule kind, every metric of the registry and every unit in en, hu and fr', () => {
  for (const lang of LANGS) {
    const strings = flat(lang), rules = locale(lang).alerts.rules;
    assert.deepEqual(Object.keys(rules.kind), [...RULE_KINDS], `${lang}: alerts.rules.kind`);
    assert.deepEqual(Object.keys(rules.metric), METRICS.map(metric => metric.key), `${lang}: alerts.rules.metric`);
    for (const unit of new Set(METRICS.map(metric => metric.unit))) if (/^[a-z]+(?:\/[a-z]+)?$/.test(unit)) assert.ok(strings.has(`alerts.rules.unit.${unit}`), `${lang}: alerts.rules.unit.${unit}`);
    for (const source of ['builtin', 'override', 'user']) assert.ok(strings.has(`alerts.rules.source.${source}`), `${lang}: source.${source}`);
  }
  assert.equal(flat('en').get('alerts.rules.metric.vix'), 'VIX');
  assert.equal(flat('en').get('alerts.rules.title'), 'Rules');
});

// Every string changes.js renders (the panel, the window labels, the notes and the chip phrases), in locale order.
const CHANGES_KEYS = ['title', 'windowLabel', 'windowLast', 'window1h', 'window6h', 'window24h', 'since', 'byDomain', 'newRecords', 'sourceChanges', 'signals', 'typeNew', 'typeEscalated', 'typeDeescalated', 'to', 'upTo',
  'baseline', 'baselineWindow', 'waiting', 'nothing', 'nothingWindow', 'nothingLens', 'loading', 'error', 'errorStale', 'replayNote', 'cappedRecords', 'cappedRecordsAbout', 'cappedList', 'showAll', 'showFewer', 'chipLabel', 'chipLabelOne', 'chipLabelAtLeast'];

test('the changes group has the same keys in the same order in en, hu and fr, each a plain non-empty string, and panels.changes names the panel', () => {
  for (const lang of LANGS) {
    const data = locale(lang), group = data.changes;
    assert.deepEqual(Object.keys(group || {}), CHANGES_KEYS, `${lang}: changes keys`);
    for (const key of CHANGES_KEYS) assert.ok(typeof group[key] === 'string' && group[key].trim() !== '', `${lang}: changes.${key}`);
    assert.ok(!/[<>]/.test(Object.values(group).join('')), `${lang}: plain text, no markup`);
    for (const [key, name] of [['since', 'time'], ['upTo', 'count'], ['error', 'window'], ['error', 'shown'], ['errorStale', 'window'], ['showAll', 'count'], ['cappedRecords', 'shown'], ['cappedRecords', 'total'], ['cappedRecordsAbout', 'total'], ['cappedList', 'shown'], ['chipLabel', 'count'], ['chipLabelOne', 'count'], ['chipLabelAtLeast', 'count']]) assert.ok(group[key].includes(`{${name}}`), `${lang}: changes.${key} names {${name}}`);
    assert.equal(typeof data.panels.changes, 'string', `${lang}: panels.changes`);
    assert.equal(data.panels.changes, group.title, `${lang}: the settings label and the panel heading agree`);
    assert.equal(new Set(['windowLast', 'window1h', 'window6h', 'window24h'].map(key => group[key])).size, 4, `${lang}: four distinct window labels`);
  }
  assert.deepEqual(LANGS.map(lang => locale(lang).changes.title), ['What changed', 'Mi változott', 'Ce qui a changé']);
  // "Mind megjelenítése" reads as "show them" in Hungarian; "Összes megjelenítése" is the natural "Show all".
  assert.deepEqual(LANGS.map(lang => locale(lang).changes.showAll), ['Show all {count}', 'Összes megjelenítése ({count})', 'Tout afficher ({count})']);
  const panelKeys = lang => Object.keys(locale(lang).panels);
  assert.deepEqual(panelKeys('hu'), panelKeys('en'));
  assert.deepEqual(panelKeys('fr'), panelKeys('en'));
});
