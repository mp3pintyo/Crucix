import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWatchlist, check } from '../scripts/watchlist.mjs';

test('the shipped watchlist is valid and holds the three starting projects', () => {
  const doc = loadWatchlist();
  assert.deepEqual(doc.projects.map(project => project.id), ['awesome-osint-arsenal', 'worldmonitor', 'gods-eye-view']);
  for (const project of doc.projects) assert.equal(project.url, `https://github.com/${project.repo}`);
  assert.equal(doc.projects.find(project => project.id === 'gods-eye-view').lastReviewed, null);
});

test('check reports the commits and releases since the last review, newest first, and says "not analysed" without a review', async () => {
  const commit = (sha, date, message) => ({ sha: sha.padEnd(40, '0'), commit: { committer: { date: `${date}T10:00:00Z` }, message } });
  const fetcher = async url => {
    const body = url.endsWith('/repos/o/r') ? { default_branch: 'main', pushed_at: '2026-10-09T00:00:00Z' }
      : url.includes('/commits?') ? [commit('ccccccc', '2026-10-09', 'third\n\nbody')]
      : url.includes('/compare/') ? { ahead_by: 3, commits: [commit('aaaaaaa', '2026-10-07', 'first'), commit('bbbbbbb', '2026-10-08', 'second'), commit('ccccccc', '2026-10-09', 'third')] }
      : [{ tag_name: 'v2', published_at: '2026-10-09T00:00:00Z' }, { tag_name: 'v1', published_at: '2026-09-01T00:00:00Z' }];
    return { ok: true, status: 200, json: async () => body };
  };
  const project = { repo: 'o/r', lastReviewed: { sha: '1234567', date: '2026-10-01' } };
  const state = await check(project, { fetcher });
  assert.equal(state.ahead, 3);
  assert.deepEqual(state.commits.map(line => line.split(' ').slice(2).join(' ')), ['third', 'second', 'first']);
  assert.deepEqual(state.releases, ['v2 (2026-10-09)']);
  assert.equal((await check({ repo: 'o/r', lastReviewed: null }, { fetcher })).ahead, null);
  await assert.rejects(check(project, { fetcher: async () => ({ ok: false, status: 403 }) }), /rate limit/);
});
