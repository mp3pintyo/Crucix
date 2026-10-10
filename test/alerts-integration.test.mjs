import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlertEngine } from '../lib/alerts/engine.mjs';
import { attachAlertSummary, runAlertStep } from '../lib/alerts/sweep.mjs';

const T0 = Date.parse('2026-10-02T12:00:00Z');
const SWEEP = 15 * 60000;

let counter = 0;
function ev(severity) {
  counter += 1;
  return {
    id: `event-${String(counter).padStart(32, '0')}`, kind: 'conflict', title: `Event ${counter}`, summary: '',
    source: { name: 'ACLED', url: null, hostname: null, status: 'ok' },
    observedAt: new Date(T0).toISOString(), publishedAt: null,
    location: { lat: null, lon: null, method: 'unknown', label: null, precision: 'unknown' },
    severity,
  };
}

function recorder() {
  const lines = [];
  const push = (...parts) => lines.push(parts.join(' '));
  return { lines, warn: push, error: push, log: push, info: push };
}

function engineIn(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-alert-sweep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { now: T0 };
  const engine = new AlertEngine(dir, { now: () => clock.now, logger: recorder() });
  engine.load();
  return { engine, clock };
}

// A notifier that records every batch and answers with `reply(batch)`.
function notifierStub(reply = () => ({ sent: [], digest: null, skipped: 0 })) {
  const batches = [];
  return { batches, dispatch: async batch => { batches.push(batch); return reply(batch); } };
}

const EMPTY_BATCH = { created: [], escalated: [], resolved: [], silent: false };

test('the sweep step puts the summary on the snapshot, dispatches every sweep and marks only sent alerts', async t => {
  const { engine, clock } = engineIn(t);
  const logger = recorder();
  const first = ev('critical');
  let reply = () => ({ sent: [], digest: null, skipped: 0 });
  const notifier = notifierStub(batch => reply(batch));

  const bootstrap = { events: [first] };
  await runAlertStep(bootstrap, { engine, notifier, logger });
  assert.equal(bootstrap.alerts.threat.level, 5);
  assert.equal(bootstrap.alerts.counts.critical, 1);
  assert.equal(notifier.batches.length, 1);
  assert.equal(notifier.batches[0].silent, true, 'the bootstrap batch is silent');

  clock.now += SWEEP;
  const loud = ev('critical');
  const folded = ev('high');
  reply = batch => {
    const byEvent = id => batch.created.find(alert => alert.evidence.some(item => item.id === id)).id;
    // The high alert went into a digest: it is not in `sent` and must not be marked.
    return { sent: [{ alertId: byEvent(loud.id), channels: ['ntfy', 'telegram'] }], digest: { count: 1, channels: ['ntfy'] }, skipped: 0 };
  };
  const second = { events: [first, loud, folded] };
  await runAlertStep(second, { engine, notifier, logger });
  assert.equal(notifier.batches.length, 2);
  assert.equal(notifier.batches[1].silent, false);
  assert.equal(notifier.batches[1].created.length, 2);
  const created = engine.list().filter(alert => !alert.silent);
  const loudAlert = created.find(alert => alert.severity === 'critical');
  const foldedAlert = created.find(alert => alert.severity === 'high');
  assert.deepEqual(engine.get(loudAlert.id).notified.channels, ['ntfy', 'telegram']);
  assert.equal(engine.get(foldedAlert.id).notified, undefined);
  assert.equal(second.alerts.counts.total, 3);

  clock.now += SWEEP;
  reply = () => ({ sent: [], digest: null, skipped: 0 });
  const third = { events: [first, loud, folded] };
  await runAlertStep(third, { engine, notifier, logger });
  assert.equal(notifier.batches.length, 3, 'an empty batch is dispatched too (quiet-hours digests depend on it)');
  assert.equal(notifier.batches[2].created.length, 0);
  assert.deepEqual(logger.lines, []);
});

test('the sweep step hands the delta to the engine without touching the snapshot', async () => {
  const calls = [];
  const summary = { threat: { level: 1 } };
  const engine = { evaluate: (snapshot, options) => { calls.push({ snapshot, options }); return { summary, ...EMPTY_BATCH }; } };
  const delta = { summary: { totalChanges: 0 } };
  const snapshot = { events: [] };
  await runAlertStep(snapshot, { engine, notifier: notifierStub(), delta, logger: recorder() });
  assert.equal(calls[0].snapshot, snapshot);
  assert.equal(calls[0].options.delta, delta);
  assert.equal(snapshot.alerts, summary);
  assert.equal(Object.hasOwn(snapshot, 'delta'), false);
});

test('a failing evaluation keeps the sweep going with the stored summary and an empty dispatch', async () => {
  const logger = recorder();
  const stored = { threat: { level: 3 } };
  const notifier = notifierStub();
  const engine = { evaluate: () => { throw new Error('rule pack exploded'); }, summary: () => stored };
  const snapshot = { events: [] };
  const pending = runAlertStep(snapshot, { engine, notifier, logger });
  assert.equal(snapshot.alerts, stored, 'the summary is on the snapshot before the step returns');
  await pending;
  assert.deepEqual(notifier.batches, [EMPTY_BATCH]);
  assert.ok(logger.lines.some(line => line.includes('rule pack exploded')));

  const broken = { evaluate: () => { throw new Error('first'); }, summary: () => { throw new Error('second'); } };
  const bare = { events: [] };
  await runAlertStep(bare, { engine: broken, notifier: notifierStub(), logger });
  assert.equal(Object.hasOwn(bare, 'alerts'), false);
});

test('a failing notifier or markNotified never escapes the sweep step', async () => {
  const summary = { threat: { level: 5 } };
  const created = [{ id: `alert-${'a'.repeat(32)}` }];
  const engine = { evaluate: () => ({ summary, ...EMPTY_BATCH, created }), markNotified: () => { throw new Error('disk full'); } };
  for (const dispatch of [
    async () => { throw new Error('channel down'); },
    () => { throw new Error('sync failure'); },
    async () => ({ sent: [{ alertId: created[0].id, channels: ['webhook'] }] }),
    async () => null,
  ]) {
    const logger = recorder();
    const snapshot = {};
    await runAlertStep(snapshot, { engine, notifier: { dispatch }, logger });
    assert.equal(snapshot.alerts, summary);
  }
  const logger = recorder();
  await runAlertStep({}, { engine, notifier: { dispatch: async () => ({ sent: [{ alertId: created[0].id, channels: ['webhook'] }] }) }, logger });
  assert.ok(logger.lines.some(line => line.includes('disk full')));
});

test('attachAlertSummary puts the stored summary on a snapshot without evaluating', t => {
  const { engine } = engineIn(t);
  engine.evaluate({ events: [ev('critical')] });
  const evaluated = engine.summary().lastEvaluatedAt;
  const snapshot = { events: [ev('critical'), ev('critical')] };
  attachAlertSummary(snapshot, engine, recorder());
  assert.equal(snapshot.alerts.counts.critical, 1, 'the new events were not evaluated');
  assert.equal(snapshot.alerts.lastEvaluatedAt, evaluated);

  const logger = recorder();
  const bare = {};
  attachAlertSummary(bare, { summary: () => { throw new Error('unreadable'); } }, logger);
  assert.equal(Object.hasOwn(bare, 'alerts'), false);
  assert.ok(logger.lines.some(line => line.includes('unreadable')));
});

test('the offline snapshot keeps the alert summary', () => {
  const pwa = readFileSync(new URL('../dashboard/public/pwa.js', import.meta.url), 'utf8');
  const keys = pwa.match(/const KEYS = (\[[^\]]*\]);/);
  assert.ok(keys, 'pwa.js declares KEYS');
  assert.ok(JSON.parse(keys[1].replaceAll("'", '"')).includes('alerts'));
});

// ─── the real server ─────────────────────────────────────────────────────────

async function startServer(t, { env = {}, prepare } = {}) {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const directory = mkdtempSync(join(tmpdir(), 'crucix-alert-server-'));
  const runs = join(directory, 'runs');
  prepare?.(runs);
  const envFile = join(directory, 'empty.env');
  writeFileSync(envFile, '');
  const child = spawn(process.execPath, ['--import', new URL('./fixtures/block-network.mjs', import.meta.url).href, 'server.mjs'], {
    cwd: new URL('..', import.meta.url), windowsHide: true,
    env: { ...process.env, CRUCIX_ENV_FILE: envFile, RUNS_DIR: runs, PORT: String(port), HOST: '127.0.0.1',
      NO_AUTO_OPEN: '1', AUTH_USER: '', AUTH_PASSWORD: '', LLM_PROVIDER: '', TELEGRAM_BOT_TOKEN: '',
      DISCORD_BOT_TOKEN: '', DISCORD_WEBHOOK_URL: '', TELEGRAM_OSINT_ENABLED: 'false',
      ALERT_NTFY_URL: '', ALERT_WEBHOOK_URL: '', AISSTREAM_API_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => logs += chunk);
  child.stderr.on('data', chunk => logs += chunk);
  t.after(async () => {
    const stopped = new Promise(resolve => child.once('exit', resolve));
    if (child.exitCode === null) { child.kill(); await stopped; }
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { base, child, logs: () => logs };
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Server failed to become ready: ${logs}`);
}

test('the real server serves the alert API behind its authentication', { timeout: 20000 }, async t => {
  const { base } = await startServer(t, { env: { AUTH_USER: 'reader', AUTH_PASSWORD: 'test-password' } });
  const authorization = `Basic ${Buffer.from('reader:test-password').toString('base64')}`;
  assert.equal((await fetch(`${base}/api/alerts/summary`)).status, 401);
  const response = await fetch(`${base}/api/alerts/summary`, { headers: { Authorization: authorization } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const summary = await response.json();
  assert.equal(summary.threat.level, 1);
  assert.equal(summary.status.alerts, 'empty');

  const ackAll = origin => fetch(`${base}/api/alerts/ack-all`, { method: 'POST', body: '{}', headers: { Authorization: authorization, 'Content-Type': 'application/json', Origin: origin } });
  const refused = await ackAll('http://evil.example');
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, 'CROSS_ORIGIN');
  const accepted = await ackAll(base);
  assert.equal(accepted.status, 200);
  assert.deepEqual((await accepted.json()).alerts, []);
});

test('the real server without credentials takes changes only through allowed host names and answers bad paths in JSON', { timeout: 20000 }, async t => {
  const { base, logs } = await startServer(t, { env: { ALERT_ALLOWED_HOSTS: 'crucix.lan', ALERT_PUBLIC_URL: 'https://crucix.example.com' } });
  const port = new URL(base).port;
  // fetch always sends the real Host header; a DNS-rebinding page sends its own name.
  const post = (path, headers) => new Promise((resolve, reject) => {
    const request = httpRequest(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, type: response.headers['content-type'], body: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.end('{}');
  });
  const rebound = await post('/api/alerts/ack-all', { Host: `attacker.example:${port}`, Origin: `http://attacker.example:${port}` });
  assert.deepEqual([rebound.status, rebound.body.code], [403, 'HOST_NOT_ALLOWED']);
  for (const host of [`crucix.lan:${port}`, `127.0.0.1:${port}`, 'crucix.example.com']) assert.equal((await post('/api/alerts/ack-all', { Host: host })).status, 200, host);
  assert.equal((await post('/api/alerts/ack-all', { Host: `127.0.0.1:${port}`, Origin: 'https://crucix.example.com' })).status, 200, 'the ALERT_PUBLIC_URL origin');

  const malformed = await post('/api/alerts/%E0%A4%A/ack', {});
  assert.equal(malformed.status, 400);
  assert.match(malformed.type, /^application\/json/);
  assert.deepEqual(malformed.body, { error: 'Invalid request', code: 'INVALID_REQUEST', field: null });
  assert.ok(!/URIError: |\n\s+at /.test(logs()), 'no stack in the log');
});

test('the real server starts with a corrupt alerts file and an empty alert state', { timeout: 20000 }, async t => {
  const { base, child, logs } = await startServer(t, {
    prepare: runs => {
      mkdirSync(join(runs, 'alerts'), { recursive: true });
      writeFileSync(join(runs, 'alerts', 'alerts.json'), '{"version": 1, "alerts": [garbage');
      writeFileSync(join(runs, 'alerts', 'rules.json'), '\u0000\u0001 not json');
    },
  });
  const response = await fetch(`${base}/api/alerts/summary`);
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.equal(summary.threat.level, 1);
  assert.equal(summary.status.alerts, 'corrupt');
  assert.equal(summary.status.rules, 'corrupt');
  assert.equal(summary.rules.total, 8);
  assert.equal((await fetch(`${base}/api/alerts/rules`)).status, 200);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal(child.exitCode, null);
  assert.ok(!logs().includes('Uncaught exception'), logs());
});
