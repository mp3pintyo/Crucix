import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../dashboard/public/jarvis.html', import.meta.url), 'utf8');

// Extract REGION_DEFINITIONS
const defMatch = html.match(/const REGION_DEFINITIONS = (\[[\s\S]*?\]);/);
assert.ok(defMatch, 'REGION_DEFINITIONS found in jarvis.html');
const REGION_DEFINITIONS = eval(defMatch[1]);

// Extract regionPOV
const povMatch = html.match(/const regionPOV = (\{[\s\S]*?\n\};)/);
assert.ok(povMatch, 'regionPOV found in jarvis.html');
const regionPOV = eval('(' + povMatch[1].replace(/;\s*$/, '') + ')');

// Extract flatRegionBounds
const boundsMatch = html.match(/const flatRegionBounds = (\{[\s\S]*?\n\};)/);
assert.ok(boundsMatch, 'flatRegionBounds found in jarvis.html');
const flatRegionBounds = eval('(' + boundsMatch[1].replace(/;\s*$/, '') + ')');

// Extract REGION_COUNTRY_CODES
const codesMatch = html.match(/const REGION_COUNTRY_CODES = (\{[\s\S]*?\n\};)/);
assert.ok(codesMatch, 'REGION_COUNTRY_CODES found in jarvis.html');
const REGION_COUNTRY_CODES = eval('(' + codesMatch[1].replace(/;\s*$/, '') + ')');

// Extract COUNTRY_TABLE
const tableMatch = html.match(/const COUNTRY_TABLE = (\[[\s\S]*?\]);/);
assert.ok(tableMatch, 'COUNTRY_TABLE found in jarvis.html');
const COUNTRY_TABLE = eval(tableMatch[1]);

test('expanded regions: definitions, camera pov and flat bounds are all defined and consistent', () => {
  const expectedRegions = [
    'world', 'americas', 'northAmerica', 'latinAmerica',
    'europe', 'easternEurope', 'middleEast', 'africa',
    'asiaPacific', 'centralAsia', 'southAsia', 'eastAsia', 'seAsia', 'oceania'
  ];

  const definedIds = REGION_DEFINITIONS.map(r => r.id);
  for (const id of expectedRegions) {
    assert.ok(definedIds.includes(id), `REGION_DEFINITIONS must include ${id}`);
    assert.ok(regionPOV[id], `regionPOV must include ${id}`);
    assert.ok(Number.isFinite(regionPOV[id].lat), `regionPOV[${id}].lat is finite`);
    assert.ok(Number.isFinite(regionPOV[id].lng), `regionPOV[${id}].lng is finite`);
    assert.ok(Number.isFinite(regionPOV[id].altitude), `regionPOV[${id}].altitude is finite`);

    assert.ok(flatRegionBounds[id], `flatRegionBounds must include ${id}`);
    assert.equal(flatRegionBounds[id].length, 2, `flatRegionBounds[${id}] has [min, max]`);
  }
});

test('expanded regions: ISO country codes sets cover subregions accurately', () => {
  // Eastern Europe
  assert.ok(REGION_COUNTRY_CODES.easternEurope.has('UA'), 'Ukraine is in easternEurope');
  assert.ok(REGION_COUNTRY_CODES.easternEurope.has('PL'), 'Poland is in easternEurope');
  assert.ok(REGION_COUNTRY_CODES.europe.has('UA'), 'Ukraine is in europe');
  assert.ok(REGION_COUNTRY_CODES.europe.has('HU'), 'Hungary is in europe');

  // North America & Latin America
  assert.ok(REGION_COUNTRY_CODES.northAmerica.has('US'), 'US is in northAmerica');
  assert.ok(REGION_COUNTRY_CODES.northAmerica.has('CA'), 'Canada is in northAmerica');
  assert.ok(REGION_COUNTRY_CODES.americas.has('US'), 'US is in americas');
  assert.ok(REGION_COUNTRY_CODES.latinAmerica.has('BR'), 'Brazil is in latinAmerica');
  assert.ok(REGION_COUNTRY_CODES.latinAmerica.has('MX'), 'Mexico is in latinAmerica');
  assert.ok(REGION_COUNTRY_CODES.americas.has('BR'), 'Brazil is in americas');

  // East Asia & South Asia & SE Asia & Central Asia & Oceania
  assert.ok(REGION_COUNTRY_CODES.eastAsia.has('TW'), 'Taiwan is in eastAsia');
  assert.ok(REGION_COUNTRY_CODES.eastAsia.has('JP'), 'Japan is in eastAsia');
  assert.ok(REGION_COUNTRY_CODES.southAsia.has('IN'), 'India is in southAsia');
  assert.ok(REGION_COUNTRY_CODES.southAsia.has('PK'), 'Pakistan is in southAsia');
  assert.ok(REGION_COUNTRY_CODES.seAsia.has('VN'), 'Vietnam is in seAsia');
  assert.ok(REGION_COUNTRY_CODES.seAsia.has('SG'), 'Singapore is in seAsia');
  assert.ok(REGION_COUNTRY_CODES.centralAsia.has('KZ'), 'Kazakhstan is in centralAsia');
  assert.ok(REGION_COUNTRY_CODES.oceania.has('AU'), 'Australia is in oceania');
  assert.ok(REGION_COUNTRY_CODES.asiaPacific.has('TW'), 'Taiwan is in asiaPacific');

  // Middle East & Africa
  assert.ok(REGION_COUNTRY_CODES.middleEast.has('IL'), 'Israel is in middleEast');
  assert.ok(REGION_COUNTRY_CODES.middleEast.has('IR'), 'Iran is in middleEast');
  assert.ok(REGION_COUNTRY_CODES.africa.has('ZA'), 'South Africa is in africa');
  assert.ok(REGION_COUNTRY_CODES.africa.has('EG'), 'Egypt is in africa');
});

test('expanded regions: locales en, hu, and fr have identical matching keys', () => {
  const en = JSON.parse(fs.readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
  const hu = JSON.parse(fs.readFileSync(new URL('../locales/hu.json', import.meta.url), 'utf8'));
  const fr = JSON.parse(fs.readFileSync(new URL('../locales/fr.json', import.meta.url), 'utf8'));

  const enKeys = Object.keys(en.regions);
  const huKeys = Object.keys(hu.regions);
  const frKeys = Object.keys(fr.regions);

  assert.deepEqual(enKeys, huKeys, 'hu regions match en regions keys');
  assert.deepEqual(enKeys, frKeys, 'fr regions match en regions keys');

  for (const id of REGION_DEFINITIONS.map(r => r.id)) {
    assert.ok(en.regions[id], `en.json has region ${id}`);
    assert.ok(hu.regions[id], `hu.json has region ${id}`);
    assert.ok(fr.regions[id], `fr.json has region ${id}`);
  }
});

test('country catalog: covers 150+ sovereign states with 2-letter, 3-letter, and English names', () => {
  assert.ok(COUNTRY_TABLE.length >= 150, `Country table has ${COUNTRY_TABLE.length} entries`);
  for (const [iso2, iso3, name] of COUNTRY_TABLE) {
    assert.match(iso2, /^[A-Z]{2}$/, `${iso2} is valid ISO2`);
    assert.match(iso3, /^[A-Z]{3}$/, `${iso3} is valid ISO3`);
    assert.ok(name && name.length > 1, `${name} has valid name`);
  }
});
