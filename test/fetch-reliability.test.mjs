import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { safeFetch, retryAfterMs } from '../apis/utils/fetch.mjs';

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('deadline aborts a body stalled after successful headers', async t => {
  const url = await fixture(t, (_req, res) => { res.writeHead(200); res.write('{'); });
  const start = Date.now();
  const result = await safeFetch(url, { timeout: 50, retries: 0 });
  assert.match(result.error, /timed out/);
  assert.ok(Date.now() - start < 1000);
});
test('response limit applies when server omits Content-Length', async t => {
  const url = await fixture(t, (_req, res) => res.end('a'.repeat(10000)));
  assert.match((await safeFetch(url, { maxBytes: 64, retries: 0 })).error, /byte limit/);
});
test('429 honors Retry-After while ordinary 4xx is never retried', async t => {
  let hits = 0;
  const url = await fixture(t, (_req, res) => {
    hits++;
    if (hits === 1) { res.writeHead(429, { 'Retry-After': '0' }); res.end('private'); }
    else res.end('{"ok":true}');
  });
  assert.deepEqual(await safeFetch(url), { ok: true });
  assert.equal(hits, 2);
  hits = 0;
  const denied = await fixture(t, (_req, res) => { hits++; res.writeHead(401); res.end('secret token'); });
  assert.deepEqual(await safeFetch(denied), { error: 'HTTP 401', status: 401 });
  assert.equal(hits, 1);
});
test('a provider-specific retry header is read and its wait is returned with the failure', async t => {
  const url = await fixture(t, (_req, res) => { res.writeHead(429, { 'X-Rate-Limit-Retry-After-Seconds': '90' }); res.end(); });
  assert.deepEqual(await safeFetch(url, { retries: 0, retryAfterHeader: 'x-rate-limit-retry-after-seconds' }), { error: 'HTTP 429', status: 429, retryAfterMs: 90000 });
  assert.deepEqual(await safeFetch(url, { retries: 0 }), { error: 'HTTP 429', status: 429 }, 'the default header is still Retry-After');
});
test('numeric and HTTP-date Retry-After have explicit units', () => {
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs('Thu, 01 Oct 2026 12:00:05 GMT', Date.parse('2026-10-01T12:00:00Z')), 5000);
  assert.equal(retryAfterMs('bad'), null);
});
test('malformed JSON is an error, text endpoints preserve full bounded text', async t => {
  const url = await fixture(t, (_req, res) => res.end('x'.repeat(600)));
  assert.match((await safeFetch(url)).error, /Invalid JSON/);
  assert.equal((await safeFetch(url, { format: 'text' })).rawText.length, 600);
});
test('binary endpoints return the exact bytes and honor the response limit', async t => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const url = await fixture(t, (_req, res) => res.end(bytes));
  const result = await safeFetch(url, { format: 'buffer', retries: 0 });
  assert.ok(Buffer.isBuffer(result.rawBuffer));
  assert.deepEqual(result.rawBuffer, bytes, 'Bytes that are invalid UTF-8 must not be altered');
  assert.match((await safeFetch(url, { format: 'buffer', maxBytes: 64, retries: 0 })).error, /byte limit/);
});
