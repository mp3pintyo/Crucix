#!/usr/bin/env node
// Install Crucix into User Profile (%USERPROFILE%/.crucix) and .local/bin
// Production-grade standalone installation: binary contains all application code,
// user profile only contains configuration (.env) and runtime data (runs/).
// Usage: node scripts/install-local.mjs

import { existsSync, mkdirSync, cpSync, copyFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const HOME = homedir();
const userCrucixDir = join(HOME, '.crucix');
const userRunsDir = join(userCrucixDir, 'runs');
const userLocalBinDir = join(HOME, '.local', 'bin');
const isWin = process.platform === 'win32';
const exeName = isWin ? 'crucix.exe' : 'crucix';
const srcExe = join(ROOT, 'bin', exeName);
const targetExe = join(userLocalBinDir, exeName);

console.log('\n=============================================================');
console.log('       CRUCIX PRODUCTION STANDALONE INSTALLER');
console.log('=============================================================\n');
console.log(`🏠 Felhasználói könyvtár (HOME): ${HOME}`);
console.log(`📂 Adatkönyvtár (.crucix/runs):  ${userRunsDir}`);
console.log(`🚀 Bináris mappa (.local/bin):    ${userLocalBinDir}\n`);

// 1. Build latest self-contained SEA executable first
console.log('🔨 [1/4] Önálló, zárt SEA bináris fordítása...');
execSync(`"${process.execPath}" scripts/build-exe.mjs`, { cwd: ROOT, stdio: 'inherit' });

// 2. Ensure directories exist
console.log('\n📁 [2/4] Célkönyvtárak előkészítése és tisztítása...');
mkdirSync(userCrucixDir, { recursive: true });
mkdirSync(userRunsDir, { recursive: true });
mkdirSync(userLocalBinDir, { recursive: true });

// Clean up any legacy raw source code folders in ~/.crucix from previous installs
// so user cannot tamper with source code and only runtime data remains.
const legacyDirs = [
  'apis',
  'dashboard',
  'lib',
  'locales',
  'scripts',
  'node_modules',
  'data',
];
for (const dir of legacyDirs) {
  const p = join(userCrucixDir, dir);
  if (existsSync(p)) {
    try {
      rmSync(p, { recursive: true, force: true });
      console.log(`   🧹 Korábbi nyílt forráskönyvtár törölve a profilból: ${dir}/`);
    } catch {}
  }
}

const legacyFiles = [
  'package.json',
  'package-lock.json',
  'crucix.config.mjs',
  'server.mjs',
  'diag.mjs',
];
for (const file of legacyFiles) {
  const p = join(userCrucixDir, file);
  if (existsSync(p)) {
    try {
      rmSync(p, { force: true });
    } catch {}
  }
}

// Ensure .env exists in ~/.crucix
const srcEnv = existsSync(join(ROOT, '.env')) ? join(ROOT, '.env') : join(ROOT, '.env.example');
const destEnv = join(userCrucixDir, '.env');
if (!existsSync(destEnv) && existsSync(srcEnv)) {
  copyFileSync(srcEnv, destEnv);
  console.log('   • .env konfiguráció létrehozva a profilban');
}

// Copy initial seed data to runs/ if user profile runs/ is empty
const srcRuns = join(ROOT, 'runs');
if (existsSync(srcRuns)) {
  try {
    cpSync(srcRuns, userRunsDir, { recursive: true });
    console.log('   • Alapértelmezett adatbázisok és sweep gyorsítótár szinkronizálva a runs/ mappába');
  } catch {}
}

// 3. Copy standalone executable and shims to .local/bin
console.log('\n🚀 [3/4] Önálló natív bináris telepítése -> ' + userLocalBinDir + '...');
copyFileSync(srcExe, targetExe);
try {
  chmodSync(targetExe, 0o755);
} catch {}
console.log(`   • ${exeName} sikeresen átmásolva (${(srcExe ? 'OK' : 'HIÁNYZIK')})`);

if (isWin) {
  // Add crucix.cmd wrapper for Windows Command Prompt convenience
  const cmdShim = `@echo off\r\n"%~dp0crucix.exe" %*\r\n`;
  writeFileSync(join(userLocalBinDir, 'crucix.cmd'), cmdShim, 'utf8');
  console.log('   • crucix.cmd parancsfájl létrehozva');
}

// Add unix-compatible shell wrapper for WSL/Git Bash
const shShim = `#!/usr/bin/env sh
basedir=$(dirname "$0")
if [ -f "$basedir/crucix.exe" ]; then
  exec "$basedir/crucix.exe" "$@"
else
  exec "$basedir/crucix" "$@"
fi
`;
writeFileSync(join(userLocalBinDir, 'crucix'), shShim, { encoding: 'utf8', mode: 0o755 });
console.log('   • crucix shell shim létrehozva');

// 4. Verification from user home (where no source files exist)
console.log('\n🔍 [4/4] Telepítés ellenőrzése forrásfájlok nélküli könyvtárból...');
try {
  const verifyOut = execFileSync(targetExe, ['--categories', '--no-server'], {
    cwd: HOME,
    encoding: 'utf8',
    env: { ...process.env, CRUCIX_HOME: userCrucixDir, RUNS_DIR: userRunsDir },
  });
  console.log('✅ A bináris sikeresen fut a forrásfájloktól teljesen mentes profilból (%USERPROFILE%/.crucix)!');
  
  const briefOut = execFileSync(targetExe, ['-b', '--no-server', '-L', 'hu'], {
    cwd: HOME,
    encoding: 'utf8',
    env: { ...process.env, CRUCIX_HOME: userCrucixDir, RUNS_DIR: userRunsDir },
  });
  if (briefOut.includes('CRUCIX VEZETŐI INTELLIGENCIA ÖSSZEFOGLALÓ')) {
    console.log('✅ A vezetői összefoglaló (briefing) sikeresen válaszol magyar nyelven.');
  }
} catch (err) {
  console.error('❌ Hiba történt az ellenőrzés során:', err.message);
  process.exit(1);
}

console.log('\n=============================================================');
console.log('🎉 CRUCIX PRODUCTION TELEPÍTÉS SIKERES!');
console.log('=============================================================');
console.log('Adatkönyvtár:       ' + userCrucixDir + ' (Kizárólag .env és runs/ adatok, forrásfájlok nélkül)');
console.log('Bináris elérési út: ' + targetExe + ' (100%-ban önálló, zárt bináris)');
console.log('\nTerminál parancsok bárhonnan futtatva:');
console.log('  crucix -b                               # Vezetői összefoglaló (EN)');
console.log('  crucix -b -L hu                         # Vezetői összefoglaló (HU)');
console.log('  crucix -m                               # Pénzügyi piacok és nyersanyagok');
console.log('  crucix --earthquakes                    # Legfrissebb földrengések');
console.log('  crucix --risk UA                        # Ukrajna kockázati profilja');
console.log('  crucix --collector                      # Folyamatos adatgyűjtő ciklus\n');
