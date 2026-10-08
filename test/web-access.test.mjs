import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { installHttpSecurity } from '../lib/http-security.mjs';

async function serve(t, auth, web) {
  const app = express();
  installHttpSecurity(app, auth, web);
  app.get('/', (_req, res) => res.send('page'));
  app.get('/embed.html', (_req, res) => res.send('widget'));
  app.get('/other.html', (_req, res) => res.send('other'));
  app.get('/api/data', (_req, res) => res.json({ ok: true }));
  app.post('/api/alerts/x/ack', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('default: no CORS headers and every page is frame-denied', async t => {
  const base = await serve(t, {}, undefined);
  const res = await fetch(`${base}/api/data`, { headers: { Origin: 'https://a.example' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(`${base}/`)).headers.get('x-frame-options'), 'DENY');
});

test('CORS_ORIGINS: listed origin may read GET /api, others and writes get nothing', async t => {
  const base = await serve(t, {}, { corsOrigins: ['https://a.example'] });
  const read = await fetch(`${base}/api/data`, { headers: { Origin: 'https://a.example' } });
  assert.equal(read.headers.get('access-control-allow-origin'), 'https://a.example');
  assert.match(read.headers.get('vary'), /Origin/);
  assert.equal((await fetch(`${base}/api/data`, { headers: { Origin: 'https://evil.example' } })).headers.get('access-control-allow-origin'), null);
  const preflightGet = await fetch(`${base}/api/data`, { method: 'OPTIONS', headers: { Origin: 'https://a.example', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(preflightGet.status, 204);
  assert.equal(preflightGet.headers.get('access-control-allow-methods'), 'GET, HEAD');
  const preflightPost = await fetch(`${base}/api/alerts/x/ack`, { method: 'OPTIONS', headers: { Origin: 'https://a.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflightPost.headers.get('access-control-allow-origin'), null);
  const post = await fetch(`${base}/api/alerts/x/ack`, { method: 'POST', headers: { Origin: 'https://a.example' } });
  assert.equal(post.headers.get('access-control-allow-origin'), null);
});

test('CORS preflight is answered before Basic auth, the data still needs credentials', async t => {
  const base = await serve(t, { user: 'owner', password: 'long-test-password' }, { corsOrigins: ['*'] });
  const pre = await fetch(`${base}/api/data`, { method: 'OPTIONS', headers: { Origin: 'https://a.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.equal(pre.headers.get('access-control-allow-headers'), 'Authorization');
  assert.equal((await fetch(`${base}/api/data`, { headers: { Origin: 'https://a.example' } })).status, 401);
});

test('EMBED_ORIGINS: only / and /embed.html may be framed, by the listed origins', async t => {
  const base = await serve(t, {}, { embedOrigins: ['https://site.example'] });
  for (const path of ['/', '/embed.html']) {
    const res = await fetch(base + path);
    assert.equal(res.headers.get('x-frame-options'), null);
    assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'self' https://site.example");
  }
  const other = await fetch(`${base}/other.html`);
  assert.equal(other.headers.get('x-frame-options'), 'DENY');
  assert.equal(other.headers.get('content-security-policy'), null);
});

test('the widget is a static file that reads only the public GET routes', () => {
  const html = readFileSync(new URL('../dashboard/public/embed.html', import.meta.url), 'utf8');
  assert.deepEqual([...html.matchAll(/fetch\('([^']+)'/g)].map(m => m[1]).sort(), ['/api/alerts/summary', '/api/countries']);
  assert.ok(!/innerHTML|document\.write|eval\(/.test(html), 'the widget must only write text nodes');
});
