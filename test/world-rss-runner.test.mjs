import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorldNews, getWorldNewsByCountry, getWorldRssStats } from '../lib/world-rss-runner.mjs';

test('world-rss-runner exports query functions and default stats', () => {
  const stats = getWorldRssStats();
  assert.ok(Number.isInteger(stats.totalFeeds));
  assert.equal(typeof stats.isFetching, 'boolean');
  assert.ok(Array.isArray(getWorldNews()));
  assert.ok(Array.isArray(getWorldNewsByCountry('HU')));
  assert.deepEqual(getWorldNewsByCountry('NON_EXISTENT_COUNTRY_XYZ'), []);
});
