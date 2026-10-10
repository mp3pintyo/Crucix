import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnvLine, getEnvSearchPaths } from '../apis/utils/env.mjs';
import { envInteger } from '../crucix.config.mjs';

test('env quotes, comments and export syntax preserve embedded hashes', () => {
  assert.deepEqual(parseEnvLine(' export TEST_KEY="secret # literal" # comment'), { key: 'TEST_KEY', value: 'secret # literal' });
  assert.deepEqual(parseEnvLine("TEST_KEY='quoted value'"), { key: 'TEST_KEY', value: 'quoted value' });
  assert.deepEqual(parseEnvLine('TEST_KEY=plain # comment'), { key: 'TEST_KEY', value: 'plain' });
  assert.equal(parseEnvLine('# comment'), null);
});

test('port accepts five digits and rejects malformed/out-of-range values', () => {
  const key = 'CRUCIX_TEST_PORT';
  process.env[key] = '10000';
  assert.equal(envInteger(key, 3117, 1, 65535), 10000);
  for (const value of ['0', '65536', '3117;evil', '-1', '1.5']) {
    process.env[key] = value;
    assert.throws(() => envInteger(key, 3117, 1, 65535));
  }
  delete process.env[key];
});

// The config module reads process.env when it is evaluated, so each case imports a fresh copy (own query string).
const ALERT_KEYS = ['ALERT_NOTIFY_CHANNELS', 'ALERT_NOTIFY_MIN_SEVERITY', 'ALERT_QUIET_HOURS', 'ALERT_MAX_NOTIFICATIONS_PER_SWEEP', 'ALERT_PUBLIC_URL', 'ALERT_ALLOWED_HOSTS', 'ALERT_NTFY_URL', 'ALERT_NTFY_TOKEN', 'ALERT_WEBHOOK_URL', 'ALERT_MAX_ACTIVE_PER_RULE'];
const SWEEP_KEYS = ['SWEEP_ARCHIVE_COUNT', 'SWEEP_ARCHIVE_MAX_MB'];
const CONFIG_KEYS = [...ALERT_KEYS, ...SWEEP_KEYS];
let freshConfigs = 0;
async function loadConfig(env = {}, section = 'alerts') {
  const saved = Object.fromEntries(CONFIG_KEYS.map(key => [key, process.env[key]]));
  for (const key of CONFIG_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const warnings = [];
  const warn = console.warn;
  console.warn = (...parts) => warnings.push(parts.join(' '));
  try {
    const module = await import(`../crucix.config.mjs?alerts=${++freshConfigs}`);
    return { config: module.default[section], warnings };
  } finally {
    console.warn = warn;
    for (const key of CONFIG_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}

test('alerts config defaults', async () => {
  const { config, warnings } = await loadConfig();
  assert.deepEqual(JSON.parse(JSON.stringify(config)), {
    notifyChannels: [], notifyMinSeverity: 'high', quietHours: null, maxNotificationsPerSweep: 5, publicUrl: null, allowedHosts: [],
    ntfy: { url: null, token: null }, webhook: { url: null }, maxActivePerRule: 50,
  });
  assert.deepEqual(warnings, []);
  // Empty values (as in .env.example) mean "unset".
  const empty = await loadConfig(Object.fromEntries(ALERT_KEYS.map(key => [key, ''])));
  assert.deepEqual(JSON.parse(JSON.stringify(empty.config)), JSON.parse(JSON.stringify(config)));
});

test('alerts config reads every ALERT_* variable', async () => {
  const { config, warnings } = await loadConfig({
    ALERT_NOTIFY_CHANNELS: 'telegram,discord', ALERT_NOTIFY_MIN_SEVERITY: ' Watch ', ALERT_QUIET_HOURS: '22:00-07:00', ALERT_MAX_NOTIFICATIONS_PER_SWEEP: '12',
    ALERT_PUBLIC_URL: 'https://dash.example.test/crucix/', ALERT_ALLOWED_HOSTS: 'crucix.lan', ALERT_NTFY_URL: 'https://ntfy.example.test/topic', ALERT_NTFY_TOKEN: 'tk_example',
    ALERT_WEBHOOK_URL: 'http://hooks.example.test:8080/in', ALERT_MAX_ACTIVE_PER_RULE: '200',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(config)), {
    notifyChannels: ['telegram', 'discord'], notifyMinSeverity: 'watch', quietHours: '22:00-07:00', maxNotificationsPerSweep: 12, publicUrl: 'https://dash.example.test/crucix',
    allowedHosts: ['crucix.lan'], ntfy: { url: 'https://ntfy.example.test/topic', token: 'tk_example' }, webhook: { url: 'http://hooks.example.test:8080/in' }, maxActivePerRule: 200,
  });
  assert.deepEqual(warnings, []);
});

test('alert URLs with credentials, other schemes or garbage are treated as unset with a warning that does not echo them', async () => {
  const bad = ['https://user:hunter2@ntfy.example.test/topic', 'ftp://ntfy.example.test/topic', 'javascript:alert(1)', 'not a url', '//ntfy.example.test/topic'];
  for (const value of bad) {
    const { config, warnings } = await loadConfig({ ALERT_NTFY_URL: value, ALERT_WEBHOOK_URL: value, ALERT_PUBLIC_URL: value, ALERT_NTFY_TOKEN: 'tk_example' });
    assert.equal(config.ntfy.url, null, value);
    assert.equal(config.webhook.url, null, value);
    assert.equal(config.publicUrl, null, value);
    assert.equal(config.ntfy.token, 'tk_example');
    assert.equal(warnings.length, 3, value);
    for (const line of warnings) {
      assert.match(line, /ALERT_(NTFY|WEBHOOK|PUBLIC)_URL/);
      assert.ok(!line.includes('hunter2') && !line.includes(value), line);
    }
  }
});

test('ALERT_NOTIFY_CHANNELS: telegram and discord in any case and order, once each; other tokens are ignored with a warning that does not echo them', async () => {
  const { config, warnings } = await loadConfig({ ALERT_NOTIFY_CHANNELS: ' Discord , telegram,,TELEGRAM, ntfy, s3cr3t-token ' });
  assert.deepEqual(config.notifyChannels, ['discord', 'telegram']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ALERT_NOTIFY_CHANNELS/);
  assert.ok(!warnings[0].includes('s3cr3t') && !warnings[0].includes('ntfy'), warnings[0]);
  assert.deepEqual((await loadConfig({ ALERT_NOTIFY_CHANNELS: 'telegram' })).config.notifyChannels, ['telegram']);
  assert.deepEqual((await loadConfig({ ALERT_NOTIFY_CHANNELS: ' , ' })).warnings, [], 'separators alone are no channel and no warning');
});

test('ALERT_ALLOWED_HOSTS: lower-cased host names, once each; anything else is ignored with a warning that does not echo it', async () => {
  const { config, warnings } = await loadConfig({ ALERT_ALLOWED_HOSTS: ' Crucix.LAN ,nas-01.home.arpa,crucix.lan,, bad host,http://x.example,x.example:3117,s3cr3t_value,-lead.example ' });
  assert.deepEqual(config.allowedHosts, ['crucix.lan', 'nas-01.home.arpa']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ALERT_ALLOWED_HOSTS/);
  for (const value of ['bad host', 'x.example', 's3cr3t', 'lead']) assert.ok(!warnings[0].includes(value), warnings[0]);
});

test('alert integer settings accept their bounds and reject everything else', async () => {
  for (const [key, field, min, max] of [['ALERT_MAX_NOTIFICATIONS_PER_SWEEP', 'maxNotificationsPerSweep', 1, 50], ['ALERT_MAX_ACTIVE_PER_RULE', 'maxActivePerRule', 1, 500]]) {
    for (const ok of [min, max]) assert.equal((await loadConfig({ [key]: String(ok) })).config[field], ok, `${key}=${ok}`);
    for (const bad of [String(min - 1), String(max + 1), '-1', '1.5', '5;evil', 'ten', ' 5']) {
      await assert.rejects(loadConfig({ [key]: bad }), new RegExp(`${key} must be an integer between ${min} and ${max}`), `${key}=${bad}`);
    }
  }
});

test('.env.example documents every ALERT_* key: comment line above, empty value, no inline comment', () => {
  const lines = readFileSync(new URL('../.env.example', import.meta.url), 'utf8').split(/\r?\n/);
  for (const key of ALERT_KEYS) {
    const index = lines.findIndex(line => line.startsWith(`${key}=`));
    assert.ok(index > 0, `${key} is missing`);
    assert.equal(lines[index], `${key}=`, `${key} must have an empty value and no inline comment`);
    assert.match(lines[index - 1], /^# \S/, `${key} needs a comment line above`);
  }
});

test('sweep archive settings: defaults 96 sweeps and 64 MB, bounds 2-672 and 4-512, anything else is refused', async () => {
  assert.deepEqual((await loadConfig({}, 'sweeps')).config, { count: 96, maxMb: 64 });
  assert.deepEqual((await loadConfig({ SWEEP_ARCHIVE_COUNT: '', SWEEP_ARCHIVE_MAX_MB: '' }, 'sweeps')).config, { count: 96, maxMb: 64 }, 'empty means unset');
  assert.deepEqual((await loadConfig({ SWEEP_ARCHIVE_COUNT: '192', SWEEP_ARCHIVE_MAX_MB: '128' }, 'sweeps')).config, { count: 192, maxMb: 128 });
  for (const [key, field, min, max] of [['SWEEP_ARCHIVE_COUNT', 'count', 2, 672], ['SWEEP_ARCHIVE_MAX_MB', 'maxMb', 4, 512]]) {
    for (const ok of [min, max]) assert.equal((await loadConfig({ [key]: String(ok) }, 'sweeps')).config[field], ok, `${key}=${ok}`);
    for (const bad of [String(min - 1), String(max + 1), '-1', '1.5', '5;evil', 'ten', ' 5', '64MB']) {
      await assert.rejects(loadConfig({ [key]: bad }, 'sweeps'), new RegExp(`${key} must be an integer between ${min} and ${max}`), `${key}=${bad}`);
    }
  }
});

test('.env.example documents the sweep archive keys: comment line above, empty value, no inline comment', () => {
  const lines = readFileSync(new URL('../.env.example', import.meta.url), 'utf8').split(/\r?\n/);
  for (const key of SWEEP_KEYS) {
    const index = lines.findIndex(line => line.startsWith(`${key}=`));
    assert.ok(index > 0, `${key} is missing`);
    assert.equal(lines[index], `${key}=`, `${key} must have an empty value and no inline comment`);
    assert.match(lines[index - 1], /^# \S/, `${key} needs a comment line above`);
  }
});

test('getEnvSearchPaths: resolves explicit CRUCIX_ENV_FILE or falls back to user profile ~/.crucix/.env', () => {
  const explicit = getEnvSearchPaths({ envFile: '/custom/path/.env' });
  assert.deepEqual(explicit, [resolve('/custom/path/.env')]);

  const testHome = resolve('/test-home');
  const testCwd = resolve('/test-cwd');
  const paths = getEnvSearchPaths({ envFile: null, cwd: testCwd, home: testHome });
  assert.ok(paths.includes(resolve(testCwd, '.env')), 'Includes cwd .env');
  assert.ok(paths.includes(resolve(testHome, '.crucix', '.env')), 'Includes user profile ~/.crucix/.env (%USERPROFILE%\\.crucix\\.env)');
  assert.ok(paths.includes(resolve(testHome, '.crucix.env')), 'Includes user profile ~/.crucix.env');
  assert.ok(paths.length >= 3, 'Multiple candidates searched');
});
