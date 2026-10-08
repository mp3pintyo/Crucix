import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POLICIES } from '../apis/utils/freshness.mjs';
import { normalizeLiveSources, freshLiveSnapshot, FACT_FIELDS } from '../lib/intelligence/live-sources.mjs';
import { buildEvents, stampLiveEventIds } from '../lib/intelligence/events.mjs';
import { HistoryStore } from '../lib/intelligence/history.mjs';
import { metricValues } from '../lib/alerts/metrics.mjs';
import { parsePortwatch, parsePortwatchPlaces } from '../apis/sources/portwatch.mjs';
import { parseEmsc } from '../apis/sources/emsc.mjs';
import { parseCopernicus } from '../apis/sources/copernicus-ems.mjs';
import { parseSigmet } from '../apis/sources/sigmet.mjs';
import { parseAdsbMilitary } from '../apis/sources/adsb-military.mjs';
import { parseOpensanctionsIndex } from '../apis/sources/opensanctions-index.mjs';
import { parseFederalRegister } from '../apis/sources/federal-register.mjs';
import { parseEnergyCharts } from '../apis/sources/energy-charts.mjs';
import { parseEntsog } from '../apis/sources/entsog.mjs';
import { parsePredictionMarkets, DEFAULT_QUERIES } from '../apis/sources/prediction-markets.mjs';

// The whole live chain for all nineteen sources: the real parsers of the ten new sources (on minimal payloads in the shape of the
// captured fixtures of their own tests, dated relative to one clock) plus adapter-shaped rows of the nine earlier ones, then
// normalizeLiveSources -> stampLiveEventIds -> buildEvents -> freshLiveSnapshot, the history journal and the alert metrics.
const NOW = Date.parse('2026-10-03T00:40:00Z');
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR, MIB = 1024 * 1024;
const iso = ms => new Date(ms).toISOString();
const day = ms => iso(ms).slice(0, 10);
const bare = ms => iso(ms).slice(0, 19);
const sec = ms => Math.round(ms / 1000);

// Each payload is dated from `base` (the sweep that fetched it) and parsed at `now`: the same payload parsed later must keep its ids.
function portwatch(now, base = NOW) {
  const last = base - 5 * DAY, features = [];
  for (const [portid, portname, series] of [['chokepoint6', 'Strait of Hormuz', Array(35).fill(4)], ['chokepoint1', 'Suez Canal', [...Array(28).fill(40), ...Array(7).fill(18)]]])
    series.forEach((n_total, i) => features.push({ attributes: { date: day(last - (series.length - 1 - i) * DAY), portid, portname, n_total } }));
  const places = parsePortwatchPlaces({ features: [{ attributes: { portid: 'chokepoint6', portname: 'Strait of Hormuz', lat: 26.29685349, lon: 56.85984844 } }, { attributes: { portid: 'chokepoint1', portname: 'Suez Canal', lat: 30.59334599, lon: 32.43688221 } }] });
  return parsePortwatch({ objectIdFieldName: 'ObjectId', features: features.reverse() }, { now, chokepoints: ['Strait of Hormuz', 'Suez Canal'], locations: places });
}
function emsc(now, base = NOW) {
  const quake = (unid, region, lat, lon, mag, at) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat, -10] }, id: unid,
    properties: { source_id: unid.slice(-7), source_catalog: 'EMSC-RTS', lastupdate: iso(at + 20 * MINUTE), time: iso(at), flynn_region: region, lat, lon, depth: 10, evtype: 'ke', auth: 'EMSC', mag, magtype: 'mb', unid } });
  return parseEmsc({ type: 'FeatureCollection', metadata: { count: 2 }, features: [quake('20261002_0000236', 'OFF EAST COAST OF KAMCHATKA', 51.8043, 159.605, 5.8, base - 8 * HOUR),
    quake('20261002_0000234', 'GULF OF PARIA, VENEZUELA', 10.4644, -62.4526, 5, base - 9 * HOUR)] }, { now });
}
function copernicus(now, base = NOW) {
  return parseCopernicus({ count: 1, next: null, previous: null, results: [{ code: 'EMSR932', countries: ['Spain'], eventTime: bare(base - 4 * DAY), name: 'Wildfire in Huelva Province, Spain',
    centroid: 'POINT (-7.213497 37.789542)', activationTime: bare(base - 3 * DAY), category: 'Wildfire', lastUpdate: bare(base - 2 * DAY), closed: false, gdacsId: null, n_aois: 1, n_products: 1 }] }, { now });
}
function sigmet(now, base = NOW) {
  return parseSigmet([{ icaoId: 'UBBB', firId: 'UBBB', firName: 'UBBA BAKU', receiptTime: iso(base - 30 * MINUTE), validTimeFrom: sec(base - HOUR), validTimeTo: sec(base + 3 * HOUR), seriesId: '2', hazard: 'TS',
    qualifier: 'EMBD', base: null, top: 34000, geom: 'AREA', coords: [{ lon: 45, lat: 39 }, { lon: 46, lat: 39 }, { lon: 46, lat: 40 }, { lon: 45, lat: 40 }, { lon: 45, lat: 39 }], dir: 'NE', spd: '30', chng: 'INTSF' }], { now });
}
function adsb(now, base = NOW) {
  const at = base - 10000, empty = { ac: [], msg: 'No error', now: at, total: 0, ctime: at, ptime: 0 };
  const ac = [{ hex: 'ae63be', type: 'mlat', flight: 'TST001  ', t: 'B762', dbFlags: 1, alt_baro: 30025, squawk: '3262', lat: 24.564209, lon: 54.437932, seen_pos: 1.8, seen: 0.5 },
    { hex: 'ae0427', type: 'mlat', t: 'K35R', dbFlags: 1, alt_baro: 36000, gs: 227, track: 245, squawk: '3254', lat: 37.889678, lon: -123.35869, seen_pos: 1.5, seen: 0.5 }];
  return parseAdsbMilitary({ ac, msg: 'No error', now: at, total: ac.length, ctime: at, ptime: 0 }, [empty, empty, empty], { now, previous: new Map() });
}
function opensanctions(now, base = NOW) {
  const list = (name, title, count, change) => ({ name, title, updated_at: bare(base - HOUR), last_export: bare(base - HOUR), entity_count: count * 2, thing_count: count, version: '1', type: 'source', last_change: bare(change) });
  return parseOpensanctionsIndex({ run_time: bare(base - 30 * MINUTE), datasets: [list('us_ofac_sdn', 'US OFAC Specially Designated Nationals (SDN) List', 38426, base - 6 * HOUR),
    list('eu_fsf', 'EU Financial Sanctions Files (FSF)', 8264, base - 3 * DAY)] }, { now, previous: new Map() });
}
function federalRegister(now, base = NOW) {
  const agencies = [{ raw_name: 'DEPARTMENT OF THE TREASURY', name: 'Treasury Department', id: 497, slug: 'treasury-department' }, { raw_name: 'Office of Foreign Assets Control', name: 'Foreign Assets Control Office', id: 203, slug: 'foreign-assets-control-office' }];
  const bis = [{ raw_name: 'DEPARTMENT OF COMMERCE', name: 'Commerce Department', id: 54, slug: 'commerce-department' }, { raw_name: 'Bureau of Industry and Security', name: 'Industry and Security Bureau', id: 241, slug: 'industry-and-security-bureau' }];
  const doc = (number, title, date, list) => ({ title, document_number: number, publication_date: date, html_url: `https://www.federalregister.gov/documents/${date.replaceAll('-', '/')}/${number}/x`, type: 'Notice', agencies: list });
  const page = results => ({ description: 'Documents', count: results.length, total_pages: 1, results });
  return parseFederalRegister({ OFAC: page([doc('2026-20215', 'Notice of OFAC Sanctions Action', day(base - DAY), agencies)]), BIS: page([doc('2026-19927', 'Order Renewing Temporary Denial of Export Privileges', day(base - 3 * DAY), bis)]) }, { now });
}
function energyCharts(now, base = NOW) {
  const price = { license_info: 'CC BY 4.0 (creativecommons.org/licenses/by/4.0) from Bundesnetzagentur | SMARD.de', unix_seconds: [sec(base - 25 * MINUTE)], price: [194.55], unit: 'EUR / MWh', deprecated: false };
  const frequency = { unix_seconds: [sec(base - MINUTE)], data: [50.0217], deprecated: false };
  const power = { unix_seconds: [sec(base - 90 * MINUTE)], production_types: [{ name: 'Nuclear', data: [1429.4] }, { name: 'Fossil gas', data: [579.1] }, { name: 'Renewable share of generation', data: [11.6] }], deprecated: false };
  return parseEnergyCharts(price, power, frequency, { now });
}
function entsog(now, base = NOW) {
  const gasDay = day(base - 2 * DAY), next = day(Date.parse(gasDay + 'T00:00:00Z') + DAY);
  const points = { 'ITP-00011': 'Dravaszerdahely', 'ITP-00027': 'Balassagyarmat (HU) / Velké Zlievce (SK)', 'ITP-00032': 'Csanadpalota', 'ITP-00043': 'Mosonmagyarovar', 'ITP-00055': 'Kiskundorozsma (HU>RS)', 'ITP-10006': 'VIP Bereg (HU) / VIP Bereg (UA)', 'ITP-10013': 'Kiskundorozsma-2 (HU) / Horgos (RS)' };
  const record = (pointKey, directionKey, value) => ({ id: `1Physical Flowday${gasDay}${next}HU-TSO-0001${pointKey}${directionKey}kWh/d`, indicator: 'Physical Flow', periodType: 'day', periodFrom: `${gasDay}T06:00:00+02:00`, periodTo: `${next}T06:00:00+02:00`,
    operatorKey: 'HU-TSO-0001', pointKey, pointLabel: points[pointKey], directionKey, unit: 'kWh/d', value, lastUpdateDateTime: `${next}T07:01:10+02:00`, flowStatus: 'Provisional' });
  return parseEntsog({ operationaldata: Object.keys(points).flatMap((key, i) => [record(key, 'entry', 1000000 * (i + 1)), record(key, 'exit', 0)]) }, { now });
}
function markets(now, base = NOW) {
  const market = (id, question) => ({ id, creatorId: 'creator-id', creatorUsername: 'trader1', creatorName: 'Trader One', createdTime: base - 90 * DAY, closeTime: base + 30 * DAY, question,
    slug: `slug-${id}`, url: `https://manifold.markets/trader1/slug-${id}`, pool: { NO: 100, YES: 100 }, probability: 0.5, p: 0.5, totalLiquidity: 1000, outcomeType: 'BINARY', mechanism: 'cpmm-1',
    volume: 1000, volume24Hours: 100, isResolved: false, uniqueBettorCount: 10, lastUpdatedTime: base - HOUR, lastBetTime: base - HOUR, token: 'MANA' });
  return parsePredictionMarkets(DEFAULT_QUERIES.map((word, i) => [market('market' + i, `Will ${word} make the news in 2026?`)]), { now });
}
// The nine earlier sources as their adapters hand them over: one current row each (NOAA SWPC: a global scale without coordinates).
function earlier(source, kind, now, extra = {}) {
  return { source, status: 'ok', observedAt: iso(now - 20 * MINUTE), timestamp: iso(now), summary: `${source} summary`, attribution: `${source} attribution`,
    observations: [{ providerId: `${source}:1`, kind, title: `${source} current record`, summary: 'Adapter-shaped row', url: `https://example.org/${encodeURIComponent(source)}/1`, observedAt: iso(now - 20 * MINUTE), ...extra }] };
}
const EARLIER = { 'Open-Meteo-Wind': ['weather', { lat: 47.51, lon: 34.58, locationMethod: 'configured-point', windMs: 2.1 }], 'ADSB-Orbits': ['aviation', { lat: 58, lon: 21, locationMethod: 'orbit-centre', aircraft: 1 }], 'NOAA-NHC': ['disaster', { lat: 23.1, lon: -91.7, locationMethod: 'provider', severity: 'elevated', windKt: 65 }], 'JMA-Typhoon': ['disaster', { lat: 17.9, lon: 158.5, locationMethod: 'provider', severity: 'elevated', windKt: 65 }], 'ECDC-Threats': ['health', { severity: 'high', alertLevel: 'ALERT' }], 'Central-Banks': ['economic', { policyRate: 5.5 }], 'CFTC-COT': ['market', { netPosition: 124418 }], 'FAA-Airports': ['aviation', { lat: 42.37, lon: -71.01, locationMethod: 'airport', severity: 'moderate', avgDelayMin: 43 }], Regulators: ['economic', { agency: 'Fed' }], 'Eurostat-HU': ['economic', { hungaryValue: 1.8, euValue: 3.2 }], 'Launch-Library': ['launch', { lat: 34.6, lon: -120.6, locationMethod: 'provider', rocket: 'Falcon 9' }], Meteoalarm: ['weather'], GDACS: ['disaster', { lat: 14.5, lon: 121, locationMethod: 'provider', severity: 'Orange' }], 'NOAA-SWPC': ['space-weather'], ECB: ['economic', { currency: 'HUF', rate: 369.18 }],
  'NASA-EONET': ['disaster', { lat: -8.3, lon: 115.5, locationMethod: 'provider' }], RIPEstat: ['network'], 'FIRST-EPSS': ['cyber'], OONI: ['network'], ThreatFox: ['cyber'], HIBP: ['cyber'], 'SEC-8K': ['cyber'],
  GPSJam: ['interference', { lat: 56.1, lon: 23.4, locationMethod: 'centroid', severity: 'moderate', highCells: 136 }], 'UNHCR-Arrivals': ['displacement', { lat: 41.9, lon: 12.5, locationMethod: 'country-centroid', severity: 'moderate', yearToDate: 22736 }], 'WMO-SWIC': ['weather', { lat: 35.9, lon: 104.2, locationMethod: 'member-point', severity: 'high' }] };

function collect(now = NOW) {
  const sources = { 'IMF-PortWatch': portwatch(now), EMSC: emsc(now), 'Copernicus-EMS': copernicus(now), 'Aviation-SIGMET': sigmet(now), 'ADSB-Military': adsb(now),
    'OpenSanctions-Index': opensanctions(now), 'Federal-Register': federalRegister(now), 'Energy-Charts-HU': energyCharts(now), 'ENTSOG-HU': entsog(now), 'Prediction-Markets': markets(now) };
  for (const [source, [kind, extra]] of Object.entries(EARLIER)) sources[source] = earlier(source, kind, now, extra);
  sources['MET-Norway'] = earlier('MET-Norway', 'forecast', now, { forecastAt: iso(now + 20 * MINUTE), validUntil: iso(now + 80 * MINUTE), lat: 47.4979, lon: 19.0402, locationMethod: 'configured-point' });
  return sources;
}
// As dashboard/inject.mjs: normalize, stamp the event ids on the rows, build the events.
function chain(now = NOW) {
  const liveSources = stampLiveEventIds(normalizeLiveSources(collect(now), now));
  const snapshot = { meta: { timestamp: iso(now) }, liveSources };
  snapshot.events = buildEvents(snapshot, { now });
  return snapshot;
}
const live = snapshot => snapshot.events.filter(event => Object.hasOwn(POLICIES, event.source.name));
const countBy = (list, key) => list.reduce((out, item) => ({ ...out, [key(item)]: (out[key(item)] || 0) + 1 }), {});

test('every parser hands over a current result and every source survives normalization, in policy order', () => {
  const raw = collect();
  for (const [source, result] of Object.entries(raw)) assert.equal(result.status, 'ok', `${source}: ${result.error || result.freshness?.reason || ''}`);
  const snapshot = chain();
  assert.deepEqual(snapshot.liveSources.map(row => [row.source, row.status]), Object.keys(POLICIES).map(source => [source, 'ok']));
  assert.equal(snapshot.liveSources.length, Object.keys(POLICIES).length);
});

test('the chain yields the expected events per kind and source, and nothing is lost on the way', () => {
  const snapshot = chain(), events = live(snapshot);
  const rows = snapshot.liveSources.flatMap(source => source.observations);
  assert.equal(events.length, rows.length, 'one event per normalized row');
  assert.deepEqual(new Set(events.map(event => event.id)), new Set(rows.map(row => row.eventId)), 'the stamped ids are the event ids');
  assert.deepEqual(countBy(events, event => event.source.name), {
    Meteoalarm: 1, GDACS: 1, 'NOAA-SWPC': 1, ECB: 1, 'NASA-EONET': 1, RIPEstat: 1, 'FIRST-EPSS': 1, 'MET-Norway': 1, OONI: 1,
    'IMF-PortWatch': 2, EMSC: 2, 'Copernicus-EMS': 1, 'Aviation-SIGMET': 1, 'ADSB-Military': 1, 'OpenSanctions-Index': 2, 'Federal-Register': 2, 'Energy-Charts-HU': 3, 'ENTSOG-HU': 7, 'Prediction-Markets': 5, ThreatFox: 1, HIBP: 1, 'SEC-8K': 1, GPSJam: 1, 'WMO-SWIC': 1, 'UNHCR-Arrivals': 1, 'NOAA-NHC': 1, 'JMA-Typhoon': 1, 'ECDC-Threats': 1, 'Central-Banks': 1, 'CFTC-COT': 1, 'FAA-Airports': 1, Regulators: 1, 'Eurostat-HU': 1, 'Launch-Library': 1, 'ADSB-Orbits': 1, 'Open-Meteo-Wind': 1 });
  assert.deepEqual(countBy(events, event => event.kind), { weather: 4, disaster: 5, health: 1, 'space-weather': 1, economic: 4, network: 2, cyber: 4, forecast: 1,
    maritime: 2, earthquake: 2, aviation: 3, sanctions: 4, energy: 10, market: 6, interference: 1, displacement: 1, launch: 1 });
  // Located kinds keep their coordinates and the location method the adapter named.
  const methods = Object.fromEntries(events.filter(event => event.location.lat !== null).map(event => [event.source.name, event.location.method]));
  assert.deepEqual(methods, { GDACS: 'provider', 'NASA-EONET': 'provider', 'MET-Norway': 'configured-point', 'IMF-PortWatch': 'provider', EMSC: 'provider', 'Copernicus-EMS': 'provider',
    'Aviation-SIGMET': 'polygon-centroid', 'ADSB-Military': 'theater-centre', GPSJam: 'centroid', 'WMO-SWIC': 'member-point', 'UNHCR-Arrivals': 'country-centroid', 'NOAA-NHC': 'provider', 'JMA-Typhoon': 'provider', 'FAA-Airports': 'airport', 'Launch-Library': 'provider', 'ADSB-Orbits': 'orbit-centre', 'Open-Meteo-Wind': 'configured-point' });
  // Every live row has a deep link of its own (history merges rows with the same kind and URL).
  const urls = events.map(event => `${event.kind}|${event.source.url}`);
  assert.equal(new Set(urls).size, urls.length, 'no two live rows share a kind and URL');
  for (const event of events) assert.equal(event.source.status, 'ok', event.title);
});

test('event ids are stable across two runs, and the history journal does not grow on the second', t => {
  const first = chain(), second = chain(NOW + 5 * MINUTE);
  assert.deepEqual(live(second).map(event => event.id).sort(), live(first).map(event => event.id).sort(), 'the same rows five minutes later keep their ids');
  assert.deepEqual(chain().events.map(event => event.id), first.events.map(event => event.id), 'deterministic');
  const dir = mkdtempSync(join(tmpdir(), 'crucix-live-chain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = NOW;
  const history = new HistoryStore(dir, { now: () => clock });
  const count = live(first).length;
  assert.deepEqual(history.add(live(first)), { added: count, updated: 0, ignored: 0, total: count });
  clock = NOW + 5 * MINUTE;
  assert.deepEqual(history.add(live(second)), { added: 0, updated: count, ignored: 0, total: count }, 'a second sweep updates, it adds nothing');
  assert.equal(history.query({ kind: 'energy' }).total, 10);
});

test('freshLiveSnapshot keeps a current snapshot whole and drops only what expired on a later read', () => {
  const snapshot = chain();
  const read = freshLiveSnapshot(snapshot, NOW);
  assert.deepEqual(read.events.map(event => event.id), snapshot.events.map(event => event.id), 'a current snapshot loses nothing on read');
  // 40 minutes later the two ADS-B feeds (25 minutes) have expired, everything else is still current.
  const later = freshLiveSnapshot(snapshot, NOW + 40 * MINUTE);
  assert.deepEqual(later.liveSources.filter(row => row.status !== 'ok').map(row => [row.source, row.status]), [['ADSB-Military', 'stale'], ['ADSB-Orbits', 'stale']]);
  assert.deepEqual(live(snapshot).length - live(later).length, 2, 'only the two ADS-B events (theater count and orbits) are withdrawn');
  assert.equal(metricValues(later).mil_aircraft_total, null, 'its metric is gone with it');
  assert.equal(metricValues(later).hu_power_price, 194.55);
});

test('the alert metrics of the new sources resolve from the chain', () => {
  const values = metricValues(chain());
  assert.deepEqual({ hormuz: values.hormuz_transits, suez: values.suez_transits, bab: values.bab_el_mandeb_transits, price: values.hu_power_price, hz: values.grid_frequency_hz, mil: values.mil_aircraft_total },
    { hormuz: 4, suez: 18, bab: null, price: 194.55, hz: 50.0217, mil: 2 }, 'PortWatch 7-day means of the watched chokepoints only; aircraft worldwide (one inside a theater, one outside)');
});

// Every source at its row cap (the adapters' own caps; the earlier nine at the framework cap of 100, NOAA SWPC at its three scales) with rows
// as large as the adapters make them: 250-character titles (the longest in a stored sweep, 2026-10-07: 223), summaries at the adapter cut where it has one (GDACS and EONET 1500, Meteoalarm
// 1000) and 600 characters otherwise (the longest template summary seen in a live sweep was 525), a long value for every fact, coordinates.
// The browser keeps at most 5 MiB of snapshot for offline use (dashboard/public/pwa.js).
// MET-Norway keeps one row per sweep (apis/sources/met-norway.mjs: near.slice(0, 1)); the default of 100 left the stress test with no room for a new source.
const CAPS = { 'MET-Norway': 1, 'NOAA-SWPC': 3, 'IMF-PortWatch': 12, EMSC: 100, 'Copernicus-EMS': 20, 'Aviation-SIGMET': 100, 'ADSB-Military': 32, 'OpenSanctions-Index': 12, 'Federal-Register': 30, 'Energy-Charts-HU': 3, 'ENTSOG-HU': 7, 'Prediction-Markets': 20, ThreatFox: 10, HIBP: 20, 'SEC-8K': 20, GPSJam: 27, 'WMO-SWIC': 25, 'UNHCR-Arrivals': 12, 'NOAA-NHC': 12, 'JMA-Typhoon': 6, 'ECDC-Threats': 15, 'Central-Banks': 16, 'CFTC-COT': 6, 'FAA-Airports': 40, Regulators: 20, 'Eurostat-HU': 3, 'Launch-Library': 24, 'ADSB-Orbits': 12, 'Open-Meteo-Wind': 6 };
// The summaries of the template-written sources added later are shorter than the generic 600 (measured on 2026-10-08: NHC 218, wind 212, launches 274 characters; the cuts below leave room).
const SUMMARY_CUT = { Meteoalarm: 1000, GDACS: 1500, 'NASA-EONET': 1500, 'NOAA-NHC': 400, 'JMA-Typhoon': 400, 'ECDC-Threats': 700, 'Central-Banks': 400, 'CFTC-COT': 400, 'FAA-Airports': 300, Regulators: 300, 'Eurostat-HU': 300, 'Open-Meteo-Wind': 400, 'Launch-Library': 500 };
test('with every source at its row cap the live part of the snapshot stays under the 5 MiB offline limit and no row is lost', () => {
  const raw = Object.fromEntries(Object.keys(POLICIES).map(source => [source, { source, status: 'ok', observedAt: iso(NOW - MINUTE), timestamp: iso(NOW), summary: 'S'.repeat(2000),
    attribution: 'A'.repeat(600), rights: 'R'.repeat(1000), license: 'L'.repeat(200), licenseUrl: 'https://example.org/licence', metrics: { value: 1 },
    observations: Array.from({ length: CAPS[source] ?? 100 }, (_, i) => ({ kind: 'disaster', providerId: `${source}:${i}`, title: `${i} `.padEnd(250, 'x'), summary: 's'.repeat(SUMMARY_CUT[source] ?? 600),
      url: `https://example.org/${encodeURIComponent(source)}/${i}?q=${'q'.repeat(100)}`, observedAt: iso(NOW - MINUTE), ...(source === 'MET-Norway' ? { forecastAt: iso(NOW + 30 * MINUTE) } : {}),
      validUntil: iso(NOW + 2 * HOUR), lat: 47.123456789, lon: 19.123456789, locationMethod: 'polygon-vertex-mean', locationPrecision: 'approximate', region: 'r'.repeat(60), severity: 'moderate',
      ...Object.fromEntries((FACT_FIELDS[source] || []).map(key => [key, 'f'.repeat(120)])) })) }]));
  const liveSources = stampLiveEventIds(normalizeLiveSources(raw, NOW));
  const snapshot = { meta: { timestamp: iso(NOW) }, liveSources };
  snapshot.events = buildEvents(snapshot, { now: NOW });
  const rows = liveSources.reduce((sum, source) => sum + source.observations.length, 0);
  assert.equal(rows, Object.keys(POLICIES).reduce((sum, source) => sum + (CAPS[source] ?? 100), 0), 'every source keeps its capped rows');
  assert.equal(snapshot.events.length, rows, 'every row becomes an event: no source or event limit bites');
  const bytes = new TextEncoder().encode(JSON.stringify(freshLiveSnapshot(snapshot, NOW))).byteLength;
  assert.ok(bytes <= 5 * MIB, `${(bytes / MIB).toFixed(2)} MiB`);
});
