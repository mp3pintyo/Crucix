import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  formatAge,
  formatNumber,
  formatPct,
  loadFromDisk,
  loadLiveFromDisk,
  loadLatestRaw,
  getSynthesizedData,
  getAlertsData,
  getCountryRiskData,
} from '../scripts/cli.mjs';
import { loadWorldRssCache, getWorldNewsByCountry } from '../lib/world-rss-runner.mjs';

test('cli parseArgs: recognizes standalone / no-server flags', () => {
  const flags = ['--no-server', '--standalone', '--offline', '--direct', '-S'];
  for (const flag of flags) {
    const opts = parseArgs([flag]);
    assert.equal(opts.noServer, true, `${flag} should set noServer to true`);
  }
});

test('cli parseArgs: default noServer is false', () => {
  const opts = parseArgs(['-c', 'news', '-l', '5']);
  assert.equal(opts.noServer, false);
  assert.equal(opts.category, 'news');
  assert.equal(opts.limit, 5);
});

test('cli parseArgs: recognizes sweep flags', () => {
  assert.equal(parseArgs(['--sweep']).sweep, true);
  assert.equal(parseArgs(['--run-sweep']).sweep, true);
  assert.equal(parseArgs(['--no-server', '--sweep']).noServer, true);
  assert.equal(parseArgs(['--no-server', '--sweep']).sweep, true);
});

test('cli parseArgs: recognizes collector and daemon flags', () => {
  assert.equal(parseArgs(['--collector']).collector, true);
  assert.equal(parseArgs(['--daemon']).collector, true);
  assert.equal(parseArgs(['--watch']).collector, true);
  assert.equal(parseArgs(['--collector', '-i', '30']).interval, 30);
  assert.equal(parseArgs(['--collector', '--interval', '45']).interval, 45);
});

test('cli parseArgs: recognizes serve / headless server flags', () => {
  assert.equal(parseArgs(['--serve']).serve, true);
  assert.equal(parseArgs(['--server']).serve, true);
  assert.equal(parseArgs(['--start-server']).serve, true);
});

test('cli parseArgs: recognizes data flags', () => {
  assert.equal(parseArgs(['-b']).brief, true);
  assert.equal(parseArgs(['--brief']).brief, true);
  assert.equal(parseArgs(['-m']).markets, true);
  assert.equal(parseArgs(['--markets']).markets, true);
  assert.equal(parseArgs(['--finance']).markets, true);
  assert.equal(parseArgs(['--energy']).energy, true);
  assert.equal(parseArgs(['--metals']).metals, true);
  assert.equal(parseArgs(['--commodities']).commodities, true);
  assert.equal(parseArgs(['-A']).alerts, true);
  assert.equal(parseArgs(['--alerts']).alerts, true);
  assert.equal(parseArgs(['--all-alerts']).allAlerts, true);
  assert.equal(parseArgs(['--risk']).risk, true);
  assert.equal(parseArgs(['--risk', 'UA']).countryRisk, 'UA');
  assert.equal(parseArgs(['--country-risk', 'PAN']).countryRisk, 'PAN');
  assert.equal(parseArgs(['--earthquakes']).earthquakes, true);
  assert.equal(parseArgs(['--thermal']).thermal, true);
  assert.equal(parseArgs(['--chokepoints']).chokepoints, true);
  assert.equal(parseArgs(['--air']).air, true);
  assert.equal(parseArgs(['--cyber']).cyber, true);
  assert.equal(parseArgs(['--outages']).outages, true);
  assert.equal(parseArgs(['--predictions']).predictions, true);
  assert.equal(parseArgs(['--health']).health, true);
  assert.equal(parseArgs(['--status']).health, true);
  assert.equal(parseArgs(['--sources']).sources, true);
  assert.equal(parseArgs(['--source-data', 'USGS']).sourceData, 'USGS');
  assert.equal(parseArgs(['--sweeps']).sweeps, true);
  assert.equal(parseArgs(['--delta']).delta, true);
  assert.equal(parseArgs(['-a']).all, true);
  assert.equal(parseArgs(['--all']).all, true);
});

test('cli formatters: formatAge, formatNumber, formatPct', () => {
  const now = Date.now();
  assert.equal(formatAge(new Date(now - 10 * 1000).toISOString()), '10s ago');
  assert.equal(formatAge(new Date(now - 120 * 1000).toISOString()), '2m ago');
  assert.equal(formatAge(new Date(now - 7200 * 1000).toISOString()), '2h ago');
  assert.equal(formatAge(new Date(now - 2 * 86400 * 1000).toISOString()), '2d ago');
  assert.equal(formatAge(null), '');

  assert.equal(formatNumber(1234.56), '1,234.56');
  assert.equal(formatNumber(null), '--');

  assert.equal(formatPct(2.5), '+2.50%');
  assert.equal(formatPct(-1.75), '-1.75%');
  assert.equal(formatPct(null), '--');
});

test('cli loadFromDisk: reads history records without requiring web server', () => {
  const records = loadFromDisk();
  assert.ok(Array.isArray(records), 'records must be an array');
  if (records.length > 0) {
    const first = records[0];
    assert.ok(first.id, 'record has id');
    assert.ok(first.title, 'record has title');
    assert.ok(first.kind, 'record has kind');
  }
});

test('cli world rss cache: can be queried in standalone/no-server mode', () => {
  const loaded = loadWorldRssCache();
  if (loaded) {
    const brNews = getWorldNewsByCountry('BR');
    assert.ok(Array.isArray(brNews), 'br news must be an array');
    if (brNews.length > 0) {
      assert.equal(brNews[0].country, 'BR');
    }
  }
});

test('cli getSynthesizedData: loads markets and indicators from disk', async () => {
  const syn = await getSynthesizedData({ noServer: true });
  assert.ok(syn.data, 'syn.data exists');
  assert.ok(syn.data.markets, 'markets data exists');
  assert.ok(syn.data.energy, 'energy data exists');
  assert.ok(syn.data.metals, 'metals data exists');
  assert.ok(syn.data.earthquakes, 'earthquakes data exists');
  assert.ok(syn.data.chokepoints, 'chokepoints data exists');
});

test('cli getAlertsData: loads alerts from disk', async () => {
  const alertsData = await getAlertsData({ noServer: true });
  assert.ok(Array.isArray(alertsData.alerts), 'alerts is an array');
});

test('cli getCountryRiskData: loads risk list and country details from disk', async () => {
  const listData = await getCountryRiskData({ noServer: true });
  assert.ok(Array.isArray(listData.list), 'country risk list is an array');

  const detailData = await getCountryRiskData({ noServer: true, countryRisk: 'USA' });
  assert.ok(detailData.detail, 'country detail exists');
  assert.equal(detailData.detail.iso3, 'USA');
});
