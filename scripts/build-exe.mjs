#!/usr/bin/env node
// Crucix Executable Builder (Cross-Platform Node SEA: Windows, Linux, macOS)
// Generates a fully self-contained standalone native binary (bin/crucix.exe or bin/crucix)
// using esbuild bundling, Node.js SEA (Single Executable Application), and postject.

import { existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const binDir = join(ROOT, 'bin');
const distBuildDir = join(ROOT, 'dist', 'sea-build');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const exeName = isWin ? 'crucix.exe' : 'crucix';
const targetExe = join(binDir, exeName);

console.log(`\n=============================================================`);
console.log(`        CRUCIX STANDALONE EXECUTABLE BUILDER (SEA)`);
console.log(`=============================================================\n`);

console.log(`📦 Node verzió:      ${process.version}`);
console.log(`💻 Platform:         ${process.platform} (${process.arch})`);
console.log(`📂 Célfájl:          ${targetExe}\n`);

// 1. Ensure build directories exist
mkdirSync(binDir, { recursive: true });
mkdirSync(distBuildDir, { recursive: true });

// 2. Bundle the entire application into a single self-contained CommonJS file
console.log('📦 [1/4] Alkalmazás és forrásmodulok egybecsomagolása (esbuild bundle)...');

const bundlePath = join(distBuildDir, 'bundle.cjs');

const transformPlugin = {
  name: 'crucix-sea-transform',
  setup(build) {
    build.onLoad({ filter: /\.(mjs|js)$/ }, async (args) => {
      let text = await (await import('node:fs/promises')).readFile(args.path, 'utf8');

      // Strip standalone developer CLI execution blocks from source adapters
      if (args.path.includes('apis') || args.path.includes('dashboard')) {
        text = text.replace(/\/\/\s*Run standalone[\s\S]*$/m, '/* standalone stripped */');
        text = text.replace(/if\s*\(process\.argv\[1\]\?\.endsWith[\s\S]*$/m, '/* standalone stripped */');
        text = text.replace(/\/\/\s*Run and output when executed directly[\s\S]*$/m, '/* direct entry stripped */');
        text = text.replace(/\/\/\s*Run CLI if invoked directly[\s\S]*$/m, '/* direct entry stripped */');
      }

      // In cli.mjs, ensure main() is called directly and server.mjs is statically bundled
      if (args.path.endsWith('cli.mjs')) {
        text = text.replace(
          /if\s*\(entryHref\s*&&\s*import\.meta\.url\s*===\s*entryHref\)\s*\{[\s\S]*?main\(\);[\s\S]*?\}/,
          'main();'
        );
        text = text.replace(
          /await import\(pathToFileURL\(join\(ROOT, 'server\.mjs'\)\)\.href\);/,
          "await import('../server.mjs');"
        );
      }

      return { contents: text, loader: args.path.endsWith('.mjs') ? 'js' : 'default' };
    });
  }
};

const bannerJs = `// Crucix Standalone Self-Contained Binary
const __node_path = require('node:path');
const __node_os = require('node:os');
const __node_fs = require('node:fs');
const __node_url = require('node:url');

process.env.CRUCIX_EXECUTABLE = '1';
process.env.CRUCIX_IS_EXE = '1';

const defaultCrucixHome = __node_path.join(__node_os.homedir(), '.crucix');
if (!process.env.CRUCIX_HOME) {
  process.env.CRUCIX_HOME = defaultCrucixHome;
}
if (!process.env.RUNS_DIR) {
  process.env.RUNS_DIR = __node_path.join(process.env.CRUCIX_HOME, 'runs');
}

try {
  __node_fs.mkdirSync(process.env.RUNS_DIR, { recursive: true });
} catch (e) {}

const import_meta_url = __node_url.pathToFileURL(process.execPath || __filename).href;
`;

await esbuild.build({
  entryPoints: [join(ROOT, 'scripts', 'cli.mjs')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: bundlePath,
  plugins: [transformPlugin],
  banner: {
    js: bannerJs,
  },
  define: {
    'import.meta.url': 'import_meta_url',
  },
});

const bundleStat = statSync(bundlePath);
console.log(`   • Összesített JS csomag elkészült: ${(bundleStat.size / (1024 * 1024)).toFixed(2)} MB`);

// 3. Write sea-config.json
const seaConfigPath = join(distBuildDir, 'sea-config.json');
const prepBlobPath = join(distBuildDir, 'sea-prep.blob');
writeFileSync(seaConfigPath, JSON.stringify({
  main: bundlePath,
  output: prepBlobPath,
  disableExperimentalSEAWarning: true
}, null, 2), 'utf8');

// 4. Generate SEA preparation blob
console.log('⚙️  [2/4] SEA bináris blob generálása (node --experimental-sea-config)...');
execSync(`"${process.execPath}" --experimental-sea-config "${seaConfigPath}"`, { stdio: 'inherit' });

// 5. Copy Node binary to target
console.log(`📋 [3/4] Futtatható bináris előkészítése -> ${targetExe}...`);
copyFileSync(process.execPath, targetExe);

// 6. Inject blob into executable with postject
console.log('💉 [4/4] Beágyazott kód beoltása a binárisba (postject)...');
const machoFlag = isMac ? ' --macho-segment-name NODE_SEA' : '';
const postjectCmd = `npx --yes postject "${targetExe}" NODE_SEA_BLOB "${prepBlobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2${machoFlag} --overwrite`;
execSync(postjectCmd, { stdio: 'inherit' });

if (!isWin) {
  try {
    chmodSync(targetExe, 0o755);
  } catch (err) {
    console.warn('⚠️  chmod hiba:', err?.message || err);
  }
}

if (isMac) {
  try {
    execSync(`codesign --sign - "${targetExe}"`, { stdio: 'inherit' });
    console.log('🔏 Mach-O kódaláírás sikeres (ad-hoc codesign)');
  } catch (err) {
    console.warn('⚠️  codesign nem sikerült vagy nem elérhető:', err?.message || err);
  }
}

// 7. Cleanup temp build folder
try {
  rmSync(distBuildDir, { recursive: true, force: true });
} catch {
  // ignore
}

const stat = statSync(targetExe);
const mb = (stat.size / (1024 * 1024)).toFixed(1);
const runCmd = isWin ? `.\\bin\\crucix.exe` : `./bin/crucix`;

console.log(`\n=============================================================`);
console.log(`✅ Önálló (Standalone) Crucix Executable Sikeresen Létrejött!`);
console.log(`📁 Elérési út:       ${targetExe}`);
console.log(`📏 Méret:           ${mb} MB (a teljes runtime és forrás beépítve)`);
console.log(`=============================================================\n`);
console.log(`💡 Használati példák a terminálból (külső fájlok nélkül):`);
console.log(`   ${runCmd} --help -L hu             # Magyar nyelvű súgó`);
console.log(`   ${runCmd} -b                       # Vezetői összefoglaló`);
console.log(`   ${runCmd} -m --no-server           # Pénzügyi piacok & nyersanyagok`);
console.log(`   ${runCmd} --earthquakes --since 14d # Földrengések az elmúlt 2 hétből`);
console.log(`   ${runCmd} --risk UA                # Ukrajna kockázati profilja`);
console.log(`   ${runCmd} --collector              # Folyamatos adatgyűjtő ciklus\n`);
