#!/usr/bin/env node
// Crucix Status CLI — checks and displays live status of the running server
// Usage: node scripts/status.mjs (or: npm run status)

import http from 'http';
import config from '../crucix.config.mjs';

const port = config.port || 3117;
const host = config.host === '0.0.0.0' ? '127.0.0.1' : (config.host || '127.0.0.1');

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${host}:${port}${path}`, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Időtúllépés (Timeout)'));
    });
  });
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d > 0) parts.push(`${d} nap`);
  if (h > 0) parts.push(`${h} óra`);
  if (m > 0) parts.push(`${m} perc`);
  parts.push(`${s} mp`);
  return parts.join(' ');
}

async function main() {
  console.log(`\n========================================`);
  console.log(`   Crucix Intelligence — Státusz Ellenőrzés`);
  console.log(`========================================\n`);

  let health;
  try {
    health = await fetchJson('/api/health');
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.log(`❌ A Crucix szerver NEM fut.`);
      console.log(`   Cím: http://${host}:${port}`);
      console.log(`\n👉 Indítsd el a következő paranccsal egy másik terminálban:`);
      console.log(`   npm run dev\n`);
    } else {
      console.log(`⚠️ Hiba a szerver állapotának lekérésekor: ${err.message}\n`);
    }
    process.exit(1);
  }

  // Server is running!
  console.log(`✅ Szerver állapota:   FUT (Port: ${port})`);
  console.log(`⏱️  Futási idő (Uptime): ${formatUptime(health.uptime)}`);
  console.log(`🌐 Dashboard elérhető: http://localhost:${port}`);
  console.log(`----------------------------------------`);

  // Sweep information
  console.log(`🔄 Utolsó sweep:       ${health.lastSweep ? new Date(health.lastSweep).toLocaleTimeString('hu-HU') : 'Folyamatban az első gyűjtés...'}`);
  console.log(`⏳ Következő sweep:    ${health.nextSweep ? new Date(health.nextSweep).toLocaleTimeString('hu-HU') : 'Még nincs ütemezve'}`);
  console.log(`⚙️  Sweep folyamatban:  ${health.sweepInProgress ? 'IGEN (épp adatot gyűjt)' : 'Nem (várakozik)'}`);
  console.log(`📡 Források állapota:  ${health.sourcesOk} rendben, ${health.sourcesFailed} sikertelen`);
  console.log(`----------------------------------------`);

  // LLM information
  const llmStatus = health.llmEnabled ? 'AKTÍV' : 'Inaktív';
  console.log(`🧠 LLM Intelligencia:  ${llmStatus}`);
  console.log(`   Provider:           ${health.llmProvider || 'nincs'}`);
  console.log(`   Nyelv:              ${health.language || 'en'}`);
  console.log(`----------------------------------------`);

  // Alerts information (if available)
  try {
    const alerts = await fetchJson('/api/alerts/summary');
    if (alerts && alerts.threat) {
      const threatLabels = {
        1: 'Nyugodt (Level 1)',
        2: 'Info (Level 2)',
        3: 'Figyelem / Watch (Level 3)',
        4: 'Magas / High (Level 4)',
        5: 'Kritikus / Critical (Level 5)',
      };
      console.log(`🚨 Fenyegetettség:     ${threatLabels[alerts.threat.level] || `Level ${alerts.threat.level}`}`);
      if (alerts.counts) {
        console.log(`🔔 Riasztások:          Kritikus: ${alerts.counts.critical || 0} | Magas: ${alerts.counts.high || 0} | Figyelmeztetés: ${alerts.counts.watch || 0}`);
      }
    }
  } catch {
    // Alerts summary might be 503 until first sweep finishes
  }

  console.log(`========================================\n`);
}

main();
