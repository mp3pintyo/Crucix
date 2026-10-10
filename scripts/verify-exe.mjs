#!/usr/bin/env node
// Verification test for Crucix Standalone Executable (Windows / Linux / macOS)
// Validates binary existence, execution, help flag, offline/standalone capabilities,
// and platform-independent user profile config resolution.

import { existsSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const exePath = join(ROOT, 'bin', isWin ? 'crucix.exe' : 'crucix');

console.log('🔍 Executable ellenőrzése...');
console.log(`📁 Fájl: ${exePath}`);

assert.ok(existsSync(exePath), `A bináris nem található: ${exePath}`);

const stat = statSync(exePath);
console.log(`📏 Méret: ${(stat.size / (1024 * 1024)).toFixed(1)} MB`);
assert.ok(stat.size > 10 * 1024 * 1024, 'A bináris mérete túl kicsi egy beágyazott Node SEA futtatóhoz képest');

console.log('▶️ Futtatás: --help tesztelése...');
const helpOut = execFileSync(exePath, ['--help'], { encoding: 'utf8' });
assert.ok(helpOut.includes('Crucix Intelligence CLI'), 'A --help kimenet nem tartalmazza a várt címsort');
assert.ok(helpOut.includes('--sweep'), 'A --help kimenet nem tartalmazza a --sweep opciót');
assert.ok(helpOut.includes('--collector'), 'A --help kimenet nem tartalmazza a --collector opciót');
assert.ok(!helpOut.includes('npm run cli'), 'A bináris --help kimenete nem tartalmazhat npm parancsokat');
assert.ok(helpOut.includes('crucix [options]') || helpOut.includes('crucix [opciók]'), 'A bináris --help kimenetének crucix szintaxist kell mutatnia');
console.log('✅ --help sikeres (csak natív crucix parancsok, npm hivatkozás nélkül)');

console.log('▶️ Futtatás: --categories --no-server tesztelése...');
const catOut = execFileSync(exePath, ['--categories', '--no-server'], { encoding: 'utf8' });
assert.ok(catOut.includes('Kategóriák') || catOut.includes('Categories') || catOut.includes('news'), 'A --categories kimenet rendben');
console.log('✅ --categories --no-server sikeres');

console.log('▶️ Platform-független profilkönyvtár feloldás ellenőrzése...');
const testHomeDir = join(ROOT, 'dist', 'test-user-home');
try {
  mkdirSync(join(testHomeDir, '.crucix'), { recursive: true });
  writeFileSync(join(testHomeDir, '.crucix', '.env'), 'CRUCIX_TEST_USER_PROFILE=active\n', 'utf8');

  // Verify that env.mjs detects ~/.crucix/.env
  const { getEnvSearchPaths } = await import('../apis/utils/env.mjs');
  const paths = getEnvSearchPaths({ home: testHomeDir, cwd: join(ROOT, 'dist') });
  const expectedPath = resolve(join(testHomeDir, '.crucix', '.env'));
  assert.ok(paths.some(p => resolve(p) === expectedPath), `A keresési útvonalak nem tartalmazzák a profil .env-t: ${paths}`);
  console.log(`✅ Profilkönyvtár (.crucix/.env) észlelése sikeres: ${expectedPath}`);
} finally {
  try {
    rmSync(testHomeDir, { recursive: true, force: true });
  } catch {}
}

console.log('▶️ Teljes önállóság (standalone isolation) tesztelése forrásfájlok nélkül...');
const testIsolatedDir = join(ROOT, 'dist', 'test-isolated-env');
try {
  mkdirSync(testIsolatedDir, { recursive: true });
  const isolatedOut = execFileSync(exePath, ['--countries'], {
    cwd: testIsolatedDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      CRUCIX_HOME: join(testIsolatedDir, '.crucix'),
      RUNS_DIR: join(testIsolatedDir, '.crucix', 'runs'),
    },
  });
  assert.ok(isolatedOut.includes('Crucix World News Catalog'), 'A bináris nem működött izolált könyvtárban');
  assert.ok(isolatedOut.includes('191+ Countries'), 'A katalógus nem érhető el forrásfájlok nélkül');
  console.log('✅ Teljes önállóság (standalone isolation) sikeres: a bináris forrásfájlok nélkül is 100%-ban működik!');
} finally {
  try {
    rmSync(testIsolatedDir, { recursive: true, force: true });
  } catch {}
}

console.log('\n🎉 Minden bináris és platformfüggetlen konfigurációs teszt sikeresen lefutott!');
