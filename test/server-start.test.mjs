import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('real server starts on a five-digit port with isolated runtime data', { timeout: 15000 }, async t => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  assert.ok(port >= 10000);
  const directory = mkdtempSync(join(tmpdir(), 'crucix-server-'));
  const envFile = join(directory, 'empty.env');
  writeFileSync(envFile, '');
  const child = spawn(process.execPath, ['--import', new URL('./fixtures/block-network.mjs', import.meta.url).href, 'server.mjs'], {
    cwd: new URL('..', import.meta.url), windowsHide: true,
    env: { ...process.env, CRUCIX_ENV_FILE: envFile, RUNS_DIR: join(directory, 'runs'), PORT: String(port), HOST: '127.0.0.1',
      NO_AUTO_OPEN: '1', AUTH_USER: '', AUTH_PASSWORD: '', LLM_PROVIDER: '', TELEGRAM_BOT_TOKEN: '',
      DISCORD_BOT_TOKEN: '', DISCORD_WEBHOOK_URL: '', TELEGRAM_OSINT_ENABLED: 'false', SWEEP_ARCHIVE_COUNT: '', SWEEP_ARCHIVE_MAX_MB: '', AISSTREAM_API_KEY: '' },
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
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(response.status, 200);
      const health = await response.json();
      assert.equal(health.status, 'ok');
      assert.equal(health.archiveStatus, 'ok');
      assert.ok(Number.isSafeInteger(health.archivedSweeps) && health.archivedSweeps >= 0);
      const sweeps = await fetch(`http://127.0.0.1:${port}/api/sweeps`);
      assert.equal(sweeps.status, 200);
      assert.deepEqual((await sweeps.json()).retention, { count: 96, maxMb: 64 });
      const shell=await fetch(`http://127.0.0.1:${port}/offline-shell`);
      assert.equal(shell.status,200);assert.equal(shell.headers.get('cache-control'),'no-store');
      const html=await shell.text();const empty=JSON.parse(html.match(/^(?:let|const) D = (.*);\s*$/m)[1]);
      assert.equal(empty.meta.timestamp,null);assert.deepEqual(empty.events,[]);assert.deepEqual(empty.newsFeed,[]);
      const manifest=await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);assert.equal(manifest.status,200);assert.equal((await manifest.json()).display,'standalone');
      assert.ok(!logs.includes('Invalid count value'));
      return;
    } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.fail(`Server failed to become ready: ${logs}`);
});

test('CRUCIX_LANG from the .env file sets the server language', { timeout: 15000 }, async t => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const directory = mkdtempSync(join(tmpdir(), 'crucix-server-'));
  const envFile = join(directory, 'lang.env');
  writeFileSync(envFile, 'CRUCIX_LANG=hu\n');
  const env = { ...process.env, CRUCIX_ENV_FILE: envFile, RUNS_DIR: join(directory, 'runs'), PORT: String(port), HOST: '127.0.0.1',
    NO_AUTO_OPEN: '1', AUTH_USER: '', AUTH_PASSWORD: '', LLM_PROVIDER: '', TELEGRAM_BOT_TOKEN: '',
    DISCORD_BOT_TOKEN: '', DISCORD_WEBHOOK_URL: '', TELEGRAM_OSINT_ENABLED: 'false', LANGUAGE: 'en', LANG: 'en_US.UTF-8' };
  delete env.CRUCIX_LANG;
  const child = spawn(process.execPath, ['--import', new URL('./fixtures/block-network.mjs', import.meta.url).href, 'server.mjs'], {
    cwd: new URL('..', import.meta.url), windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => logs += chunk);
  child.stderr.on('data', chunk => logs += chunk);
  t.after(async () => {
    const stopped = new Promise(resolve => child.once('exit', resolve));
    if (child.exitCode === null) { child.kill(); await stopped; }
    rmSync(directory, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i++) {
    let locales;
    try { locales = await (await fetch(`http://127.0.0.1:${port}/api/locales`)).json(); }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); continue; }
    assert.equal(locales.current, 'hu');
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).language, 'hu');
    return;
  }
  assert.fail(`Server failed to become ready: ${logs}`);
});
