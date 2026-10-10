import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, formatAge, loadFromDisk, loadLiveFromDisk } from '../scripts/cli.mjs';
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

test('cli formatAge: formats timestamps correctly', () => {
  const now = Date.now();
  assert.equal(formatAge(new Date(now - 10 * 1000).toISOString()), '10s ago');
  assert.equal(formatAge(new Date(now - 120 * 1000).toISOString()), '2m ago');
  assert.equal(formatAge(new Date(now - 7200 * 1000).toISOString()), '2h ago');
  assert.equal(formatAge(new Date(now - 2 * 86400 * 1000).toISOString()), '2d ago');
  assert.equal(formatAge(null), '');
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
