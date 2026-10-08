import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const root = new URL('../dashboard/public/', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const load = () => { const window = {}; vm.runInContext(read('credits.js'), vm.createContext({ window, Object, Array, JSON, String, URL, Set })); return window.CrucixCredits; };
const plain = value => JSON.parse(JSON.stringify(value)); // objects made inside the vm context have another prototype
const ids = items => plain(items.map(item => item.id));

test('credits follow what is on screen: basemap, layers that are on, datasets that were loaded, live sources with an attribution', () => {
  const C = load();
  const base = C.list({ layers: {}, basemap: 'night', liveSources: [] });
  assert.deepEqual(ids(base), ['basemap-night', 'countries', 'software']);
  const day = ids(C.list({ layers: { milareas: true, pipelines: false, dams: false }, basemap: 'day', liveSources: [] }));
  assert.ok(day.includes('basemap-day') && !day.includes('basemap-night') && day.includes('milareas') && !day.includes('pipelines') && !day.includes('dams'));
  assert.ok(ids(C.list({ layers: {}, basemap: 'night', sitesLoaded: true })).includes('dams'), 'a dataset loaded for the record inspector is credited too');
  assert.ok(ids(C.list({ layers: {}, infrastructureLoaded: true })).includes('bases'));
  const live = C.list({ layers: {}, basemap: 'night', liveSources: [
    { source: 'NOAA-NHC', status: 'ok', attribution: 'NOAA/NWS NHC', license: 'Public domain', licenseUrl: 'https://www.weather.gov/disclaimer' },
    { source: 'NOAA-NHC', status: 'ok', attribution: 'duplicate' },
    { source: 'Broken', status: 'error', attribution: 'not shown' },
    { source: 'NoText', status: 'ok', attribution: '' },
    { source: 'Stale', status: 'stale', attribution: 'still credited', url: 'https://example.org/' }] });
  assert.deepEqual(plain(live.filter(item => item.group === 'live').map(item => item.name)), ['NOAA-NHC', 'Stale']);
  assert.equal(live.find(item => item.name === 'NOAA-NHC').url, 'https://www.weather.gov/disclaimer');
  assert.equal(C.list(null).length, 3, 'a missing context lists the always-on credits only');
});

test('the credits HTML escapes provider text and links only https URLs', () => {
  const C = load();
  const items = C.list({ layers: {}, basemap: 'night', liveSources: [
    { source: 'Evil<img>', status: 'ok', attribution: '<script>alert(1)</script> "quoted"', license: 'CC "BY"', licenseUrl: 'javascript:alert(1)', url: 'http://insecure.example/' },
    { source: 'Good', status: 'ok', attribution: 'Fine', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' }] });
  const html = C.html(items, (key, fallback) => fallback);
  assert.doesNotMatch(html, /<script|<img|javascript:|http:\/\/insecure/);
  assert.match(html, /&quot;quoted&quot;/, 'quotes are escaped; angle brackets were already stripped from the provider text');
  assert.match(html, /href="https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /Live sources/);
});

test('the page wires the credits: script, button, panel, offline shell, translations in three languages', () => {
  const html = read('jarvis.html');
  assert.ok(html.indexOf('<script src="credits.js"></script>') > html.indexOf('<script src="infrastructure.js"></script>'));
  assert.match(html, /id="creditsToggle"[^>]*aria-expanded="false"/);
  assert.match(html, /id="creditsPanel" role="dialog"[^>]*hidden/);
  assert.match(html, /function toggleCredits\(/);
  assert.ok(read('sw.js').includes("'/credits.js'"));
  for (const lang of ['en', 'hu', 'fr']) {
    const credits = JSON.parse(readFileSync(new URL(`../locales/${lang}.json`, import.meta.url), 'utf8')).credits;
    assert.deepEqual(Object.keys(credits), ['title', 'groupMap', 'groupData', 'groupLive', 'groupSoftware', 'source', 'button'], lang);
  }
});
