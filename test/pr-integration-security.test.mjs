import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { AnthropicProvider } from '../lib/llm/anthropic.mjs';
import { freshLiveSnapshot } from '../lib/intelligence/live-sources.mjs';

test('Anthropic does not forward a synthetic API key through a cross-origin redirect', async t => {
  let leaked = false;
  const target = createServer((req, res) => { leaked = true; res.end('{}'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const gateway = createServer((req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/messages` }); res.end();
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => { gateway.closeAllConnections(); gateway.close(); target.closeAllConnections(); target.close(); });
  await assert.rejects(new AnthropicProvider({ apiKey: 'synthetic-key', baseUrl: `http://127.0.0.1:${gateway.address().port}` }).complete('system', 'fixture'), /fetch failed/);
  assert.equal(leaked, false);
});

test('Anthropic cancels error bodies without echoing secrets and caps successful responses', async t => {
  const provider = new AnthropicProvider({ apiKey: 'synthetic-key' });
  t.mock.method(globalThis, 'fetch', async () => new Response('synthetic-key private prompt', { status: 401 }));
  await assert.rejects(provider.complete('system', 'fixture'), error => error.message === 'Anthropic API 401');
  globalThis.fetch = async () => new Response('x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(provider.complete('system', 'fixture'), /byte limit/);
});

test('server and browser withdraw expired AIS markers, including restored offline snapshots', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const iso = age => new Date(now - age).toISOString();
  const snapshot = { liveSources: [{ source: 'Maritime', status: 'ok', observedAt: iso(0), observations: [] }],
    aisVessels: [{ mmsi: 1, lastSeen: iso(60000) }, { mmsi: 2, lastSeen: iso(26 * 60000) }, { mmsi: 3, lastSeen: null }, { mmsi: 4, lastSeen: iso(-360000) }] };
  const window = {};
  runInNewContext(readFileSync(new URL('../dashboard/public/live-sources.js', import.meta.url), 'utf8'), { window });
  for (const filter of [() => freshLiveSnapshot(snapshot, now).aisVessels, () => window.CrucixLiveSources.aisVessels(snapshot, now)]) {
    assert.deepEqual(Array.from(filter(), v => v.mmsi), [1]);
  }
  assert.equal(freshLiveSnapshot(snapshot, now + 26 * 60000).aisVessels.length, 0);
  assert.equal(window.CrucixLiveSources.aisVessels(snapshot, now + 26 * 60000).length, 0);
});
