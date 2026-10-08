#!/usr/bin/env node
// Crucix Intelligence Engine — Dev Server
// Serves the Jarvis dashboard, runs sweep cycle, pushes live updates via SSE

import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { openBrowser } from './lib/open-browser.mjs';
import { inlineJson } from './lib/html.mjs';
import { installApiErrorHandler } from './lib/api-errors.mjs';
import { installHttpSecurity } from './lib/http-security.mjs';
import { saveSnapshot } from './lib/snapshots.mjs';
import { buildEvents, clusterEvents, stampLiveEventIds } from './lib/intelligence/events.mjs';
import { freshLiveSnapshot } from './lib/intelligence/live-sources.mjs';
import { HistoryStore } from './lib/intelligence/history.mjs';
import { installIntelligenceRoutes } from './lib/intelligence/routes.mjs';
import { EntityStore } from './lib/intelligence/entities.mjs';
import { PredictionJournal } from './lib/intelligence/predictions.mjs';
import { runRiskStep } from './lib/intelligence/risk-step.mjs';
import { KeywordStore } from './lib/intelligence/keywords.mjs';
import { installRiskRoutes } from './lib/intelligence/risk-routes.mjs';
import { createBriefingService } from './lib/llm/briefing.mjs';
import { renderOfflineShell } from './lib/offline-shell.mjs';
import { createDailyBasemap } from './lib/basemap.mjs';
import { broadcastEvent, writeToClient } from './lib/sse.mjs';
import config from './crucix.config.mjs';
import { getLocale, currentLanguage, getSupportedLocales } from './lib/i18n.mjs';
import { fullBriefing } from './apis/briefing.mjs';
import { startMaritimeCollector } from './apis/sources/ships.mjs';
import { synthesize, generateIdeas } from './dashboard/inject.mjs';
import { MemoryManager, computeDelta } from './lib/delta/index.mjs';
import { createLLMProvider } from './lib/llm/index.mjs';
import { IdeaCadence } from './lib/llm/cadence.mjs';
import { TelegramAlerter } from './lib/alerts/telegram.mjs';
import { DiscordAlerter } from './lib/alerts/discord.mjs';
import { AlertEngine } from './lib/alerts/engine.mjs';
import { AlertNotifier } from './lib/alerts/notify.mjs';
import { installAlertRoutes } from './lib/alerts/routes.mjs';
import { attachAlertSummary, runAlertStep } from './lib/alerts/sweep.mjs';
import { SweepArchive } from './lib/sweeps/archive.mjs';
import { installSweepRoutes } from './lib/sweeps/routes.mjs';
import { archiveSweep } from './lib/sweeps/step.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const RUNS_DIR = config.runsDir ? resolve(config.runsDir) : join(ROOT, 'runs');
const MEMORY_DIR = join(RUNS_DIR, 'memory');

// Ensure directories exist
for (const dir of [RUNS_DIR, MEMORY_DIR, join(MEMORY_DIR, 'cold')]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// === State ===
let currentData = null;    // Current synthesized dashboard data
let lastSweepTime = null;  // Timestamp of last sweep
let sweepStartedAt = null; // Timestamp when current/last sweep started
let sweepInProgress = false;
const startTime = Date.now();
const sseClients = new Set();

// === Delta/Memory ===
const memory = new MemoryManager(RUNS_DIR);
const ideaCadence = new IdeaCadence({ everyNSweeps: config.llm.everyNSweeps });
const history = new HistoryStore(RUNS_DIR);
let historyStatus = 'ok';
function recordSnapshotEvents(snapshot) {
  if (Array.isArray(snapshot.liveSources)) snapshot.liveSources = stampLiveEventIds(snapshot.liveSources);
  snapshot.events = buildEvents(snapshot);
  snapshot.eventClusters = clusterEvents(snapshot.events);
  try { history.add(snapshot.events); historyStatus = 'ok'; }
  catch (error) { historyStatus = 'unavailable'; console.error('[History] Save failed:', error.message); }
}
// Country risk (runs/intelligence/countries.json and predictions.json): a missing or corrupt file starts empty. With
// RISK_ENABLED=false nothing is created, the step never runs and the risk routes are not installed.
const riskStore = config.risk.enabled ? new EntityStore(RUNS_DIR, { retentionDays: config.risk.retentionDays }) : null;
const riskJournal = config.risk.enabled ? new PredictionJournal(RUNS_DIR) : null;
const riskKeywords = config.risk.enabled ? new KeywordStore(RUNS_DIR) : null;
riskStore?.load();
riskJournal?.load();
riskKeywords?.load();
let riskStatus = config.risk.enabled ? 'unavailable' : 'disabled';
let riskLatest = null; // the last successful step: {at, scores, inputs}
// Never throws: on a failure the snapshot goes on without `risk` and /api/health says 'unavailable'.
function recordRisk(snapshot, raw) {
  if (!riskStore) return;
  const result = runRiskStep({ store: riskStore, journal: riskJournal, keywords: riskKeywords, snapshot, raw, now: Date.now() });
  riskStatus = result.ok ? 'ok' : 'unavailable';
  if (result.ok) riskLatest = result;
}
// Alert state lives in runs/alerts/; a missing or corrupt file starts empty and never stops the server.
const alertEngine = new AlertEngine(RUNS_DIR, { config: { maxActivePerRule: config.alerts.maxActivePerRule } });
alertEngine.load();
// Sweep archive in runs/sweeps/: every completed sweep is stored for replay, the changes windows and the source-health matrix.
// previousArchived is the baseline of the next sweep's changes; after a restart it is the newest archived sweep.
const sweepArchive = new SweepArchive(RUNS_DIR, { count: config.sweeps.count, maxMb: config.sweeps.maxMb });
let previousArchived = null;
try { previousArchived = sweepArchive.latest(); }
catch (error) { console.error('[Sweeps] Could not read the archive:', error.message); }

// === LLM + Telegram + Discord ===
const llmProvider = createLLMProvider(config.llm);
const telegramAlerter = new TelegramAlerter(config.telegram);
const discordAlerter = new DiscordAlerter(config.discord || {});
const alertNotifier = new AlertNotifier({
  telegram: telegramAlerter, discord: discordAlerter, notifyChannels: config.alerts.notifyChannels, ntfy: config.alerts.ntfy, webhook: config.alerts.webhook,
  minSeverity: config.alerts.notifyMinSeverity, quietHours: config.alerts.quietHours,
  maxPerSweep: config.alerts.maxNotificationsPerSweep, publicUrl: config.alerts.publicUrl,
});

if (llmProvider) console.log(`[Crucix] LLM enabled: ${llmProvider.name} (${llmProvider.model})`);
if (telegramAlerter.isConfigured) {
  console.log('[Crucix] Telegram alerts enabled');

  // ─── Two-Way Bot Commands ───────────────────────────────────────────────

  telegramAlerter.onCommand('/status', async () => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const sourcesOk = currentData?.meta?.sourcesOk || 0;
    const sourcesTotal = currentData?.meta?.sourcesQueried || 0;
    const sourcesFailed = currentData?.meta?.sourcesFailed || 0;
    const llmStatus = llmProvider?.isConfigured ? `✅ ${llmProvider.name}` : '❌ Disabled';
    const nextSweep = lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()
      : 'pending';

    return [
      `🖥️ *CRUCIX STATUS*`,
      ``,
      `Uptime: ${h}h ${m}m`,
      `Last sweep: ${lastSweepTime ? new Date(lastSweepTime).toLocaleTimeString() + ' UTC' : 'never'}`,
      `Next sweep: ${nextSweep} UTC`,
      `Sweep in progress: ${sweepInProgress ? '🔄 Yes' : '⏸️ No'}`,
      `Sources: ${sourcesOk}/${sourcesTotal} OK${sourcesFailed > 0 ? ` (${sourcesFailed} failed)` : ''}`,
      `LLM: ${llmStatus}`,
      `SSE clients: ${sseClients.size}`,
      `Dashboard: ${config.publicUrl}`,
    ].join('\n');
  });

  telegramAlerter.onCommand('/sweep', async () => {
    if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
    // Fire and forget — don't block the bot response
    runSweepCycle().catch(err => console.error('[Crucix] Manual sweep failed:', err.message));
    return '🚀 Manual sweep triggered. You\'ll receive alerts if anything significant is detected.';
  });

  telegramAlerter.onCommand('/brief', async () => {
    if (!currentData) return '⏳ No data yet — waiting for first sweep to complete.';

    const tg = currentData.tg || {};
    const energy = currentData.energy || {};
    const metals = currentData.metals || {};
    const delta = memory.getLastDelta();
    const ideas = (currentData.ideas || []).slice(0, 3);

    const sections = [
      `📋 *CRUCIX BRIEF*`,
      `_${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_`,
      ``,
    ];

    // Delta direction
    if (delta?.summary) {
      const dirEmoji = { 'risk-off': '📉', 'risk-on': '📈', 'mixed': '↔️' }[delta.summary.direction] || '↔️';
      sections.push(`${dirEmoji} Direction: *${delta.summary.direction.toUpperCase()}* | ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical`);
      sections.push('');
    }

    // Key metrics
    const vix = currentData.fred?.find(f => f.id === 'VIXCLS');
    const hy = currentData.fred?.find(f => f.id === 'BAMLH0A0HYM2');
    if (vix || energy.wti || metals.gold || metals.silver) {
      sections.push(`📊 VIX: ${vix?.value || '--'} | WTI: $${energy.wti || '--'} | Brent: $${energy.brent || '--'}`);
      sections.push(`   Gold: $${metals.gold || '--'} | Silver: $${metals.silver || '--'}${hy ? ` | HY Spread: ${hy.value}` : ''}`);
      sections.push(`   NatGas: $${energy.natgas || '--'}`);
      sections.push('');
    }

    // OSINT
    if (tg.urgent?.length > 0) {
      sections.push(`📡 OSINT: ${tg.urgent.length} urgent signals, ${tg.posts || 0} total posts`);
      // Top 2 urgent
      for (const p of tg.urgent.slice(0, 2)) {
        sections.push(`  • ${(p.text || '').substring(0, 80)}`);
      }
      sections.push('');
    }

    // Top ideas
    if (ideas.length > 0) {
      sections.push(`💡 *Top Ideas:*`);
      for (const idea of ideas) {
        sections.push(`  ${idea.type === 'long' ? '📈' : idea.type === 'hedge' ? '🛡️' : '👁️'} ${idea.title}`);
      }
    }

    return sections.join('\n');
  });

  telegramAlerter.onCommand('/portfolio', async () => {
    return '📊 Portfolio integration requires Alpaca MCP connection.\nUse the Crucix dashboard or Claude agent for portfolio queries.';
  });

  // Start polling for bot commands
  telegramAlerter.startPolling(config.telegram.botPollingInterval);
}

// === Discord Bot ===
if (discordAlerter.isConfigured) {
  console.log('[Crucix] Discord bot enabled');

  // Reuse the same command handlers as Telegram (DRY)
  discordAlerter.onCommand('status', async () => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const sourcesOk = currentData?.meta?.sourcesOk || 0;
    const sourcesTotal = currentData?.meta?.sourcesQueried || 0;
    const sourcesFailed = currentData?.meta?.sourcesFailed || 0;
    const llmStatus = llmProvider?.isConfigured ? `✅ ${llmProvider.name}` : '❌ Disabled';
    const nextSweep = lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()
      : 'pending';

    return [
      `**🖥️ CRUCIX STATUS**\n`,
      `Uptime: ${h}h ${m}m`,
      `Last sweep: ${lastSweepTime ? new Date(lastSweepTime).toLocaleTimeString() + ' UTC' : 'never'}`,
      `Next sweep: ${nextSweep} UTC`,
      `Sweep in progress: ${sweepInProgress ? '🔄 Yes' : '⏸️ No'}`,
      `Sources: ${sourcesOk}/${sourcesTotal} OK${sourcesFailed > 0 ? ` (${sourcesFailed} failed)` : ''}`,
      `LLM: ${llmStatus}`,
      `SSE clients: ${sseClients.size}`,
      `Dashboard: ${config.publicUrl}`,
    ].join('\n');
  });

  discordAlerter.onCommand('sweep', async () => {
    if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
    runSweepCycle().catch(err => console.error('[Crucix] Manual sweep failed:', err.message));
    return '🚀 Manual sweep triggered. You\'ll receive alerts if anything significant is detected.';
  });

  discordAlerter.onCommand('brief', async () => {
    if (!currentData) return '⏳ No data yet — waiting for first sweep to complete.';

    const tg = currentData.tg || {};
    const energy = currentData.energy || {};
    const metals = currentData.metals || {};
    const delta = memory.getLastDelta();
    const ideas = (currentData.ideas || []).slice(0, 3);

    const sections = [`**📋 CRUCIX BRIEF**\n_${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_\n`];

    if (delta?.summary) {
      const dirEmoji = { 'risk-off': '📉', 'risk-on': '📈', 'mixed': '↔️' }[delta.summary.direction] || '↔️';
      sections.push(`${dirEmoji} Direction: **${delta.summary.direction.toUpperCase()}** | ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical\n`);
    }

    const vix = currentData.fred?.find(f => f.id === 'VIXCLS');
    const hy = currentData.fred?.find(f => f.id === 'BAMLH0A0HYM2');
    if (vix || energy.wti || metals.gold || metals.silver) {
      sections.push(`📊 VIX: ${vix?.value || '--'} | WTI: $${energy.wti || '--'} | Brent: $${energy.brent || '--'}`);
      sections.push(`   Gold: $${metals.gold || '--'} | Silver: $${metals.silver || '--'}${hy ? ` | HY Spread: ${hy.value}` : ''}`);
      sections.push(`   NatGas: $${energy.natgas || '--'}`);
      sections.push('');
    }

    if (tg.urgent?.length > 0) {
      sections.push(`📡 OSINT: ${tg.urgent.length} urgent signals, ${tg.posts || 0} total posts`);
      for (const p of tg.urgent.slice(0, 2)) {
        sections.push(`  • ${(p.text || '').substring(0, 80)}`);
      }
      sections.push('');
    }

    if (ideas.length > 0) {
      sections.push(`**💡 Top Ideas:**`);
      for (const idea of ideas) {
        sections.push(`  ${idea.type === 'long' ? '📈' : idea.type === 'hedge' ? '🛡️' : '👁️'} ${idea.title}`);
      }
    }

    return sections.join('\n');
  });

  discordAlerter.onCommand('portfolio', async () => {
    return '📊 Portfolio integration requires Alpaca MCP connection.\nUse the Crucix dashboard or Claude agent for portfolio queries.';
  });

  // Start the Discord bot (non-blocking — connection happens async)
  discordAlerter.start().catch(err => {
    console.error('[Crucix] Discord bot startup failed (non-fatal):', err.message);
  });
}

// === Express Server ===
if (config.web.corsOrigins.includes('*') && !config.auth.user) {
  console.warn("[Crucix] CORS_ORIGINS=* without AUTH_USER/AUTH_PASSWORD: any website you open can read this server's API from your browser");
}
const app = express();
installHttpSecurity(app, config.auth, config.web);
app.use(express.static(join(ROOT, 'dashboard/public')));
app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.get('/offline-shell', (_req, res) => {
  res.type('html').send(renderOfflineShell(readFileSync(join(ROOT, 'dashboard/public/jarvis.html'), 'utf8'), getLocale()));
});

// Serve an empty dashboard until the first sweep, then inject the current locale.
app.get('/', (req, res) => {
  if (!currentData) {
    res.type('html').send(renderOfflineShell(readFileSync(join(ROOT, 'dashboard/public/jarvis.html'), 'utf8'), getLocale(), { offline: false }));
  } else {
    const htmlPath = join(ROOT, 'dashboard/public/jarvis.html');
    let html = readFileSync(htmlPath, 'utf-8');
    const dataScript = inlineJson(freshLiveSnapshot(currentData));
    
    html = html.replace(/^(let|const) D = .*;\s*$/m, () => `let D = ${dataScript};`);

    // Inject locale data into the HTML
    const locale = getLocale();
    const localeScript = `<script>window.__CRUCIX_LOCALE__ = ${inlineJson(locale)};</script>`;
    html = html.replace('</head>', `${localeScript}\n</head>`);
    
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
  }
});

// API: current data
app.get('/api/data', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(freshLiveSnapshot(currentData));
});

// API: the daily globe basemap (NASA GIBS VIIRS true colour of yesterday, cached; see lib/basemap.mjs)
const dailyBasemap = createDailyBasemap();
app.get('/api/basemap/daily.jpg', async (req, res) => {
  if (Object.keys(req.query ?? {}).length) return res.status(400).json({ error: 'Unknown query parameter', code: 'INVALID_QUERY' });
  try {
    const image = await dailyBasemap.get();
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600', 'X-Basemap-Date': image.day, 'X-Basemap-Stale': image.stale ? '1' : '0' });
    res.send(image.buffer);
  } catch {
    res.status(503).json({ error: 'Daily basemap unavailable' });
  }
});

installIntelligenceRoutes(app, { getSnapshot: () => freshLiveSnapshot(currentData), history, language: currentLanguage });
if (riskStore) {
  const briefing = createBriefingService({ provider: llmProvider, language: currentLanguage, store: riskStore, history,
    getSnapshot: () => currentData, getScores: () => riskLatest?.scores ?? null });
  installRiskRoutes(app, { store: riskStore, journal: riskJournal, getSnapshot: () => currentData, getState: () => riskLatest, history, briefing,
    security: { publicUrl: config.alerts.publicUrl, allowedHosts: config.alerts.allowedHosts } });
}
// After an operator action the dashboards get the new summary; the next /api/data and page load carry it too.
installAlertRoutes(app, { engine: alertEngine, getSnapshot: () => freshLiveSnapshot(currentData), onChange: (summary, newIds) => {
  if (currentData) currentData.alerts = summary;
  broadcast({ type: 'alerts', data: summary, newIds });
}, security: { publicUrl: config.alerts.publicUrl, allowedHosts: config.alerts.allowedHosts } });
installSweepRoutes(app, { archive: sweepArchive, getCurrent: () => currentData });

function archivedSweepCount() {
  try { return sweepArchive.list().length; } catch { return 0; }
}

// API: health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastSweep: lastSweepTime,
    nextSweep: lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toISOString()
      : null,
    sweepInProgress,
    sweepStartedAt,
    sourcesOk: currentData?.meta?.sourcesOk || 0,
    sourcesFailed: currentData?.meta?.sourcesFailed || 0,
    llmEnabled: !!llmProvider?.isConfigured,
    ideasEveryNSweeps: ideaCadence.everyNSweeps,
    llmProvider: config.llm.provider,
    telegramEnabled: !!(config.telegram.botToken && config.telegram.chatId),
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    language: currentLanguage,
    historyStatus,
    riskStatus,
    archiveStatus: sweepArchive.status,
    archivedSweeps: archivedSweepCount(),
  });
});

// API: available locales
app.get('/api/locales', (req, res) => {
  res.json({
    current: currentLanguage,
    supported: getSupportedLocales(),
  });
});

// After the last /api route: JSON for what a route could not answer itself (a broken percent-encoding in an id, an escaped error).
installApiErrorHandler(app);

// SSE: live updates
app.get('/events', (req, res) => {
  if (sseClients.size >= config.maxSseClients) return res.status(503).set('Retry-After', '15').end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    if (!writeToClient(res, ': heartbeat\n\n')) sseClients.delete(res);
  }, 15000);
  heartbeat.unref();
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
});

function broadcast(data) {
  broadcastEvent(sseClients, data);
}

// === Sweep Cycle ===
async function runSweepCycle() {
  if (sweepInProgress) {
    console.log('[Crucix] Sweep already in progress, skipping');
    return;
  }

  sweepInProgress = true;
  sweepStartedAt = new Date().toISOString();
  broadcast({ type: 'sweep_start', timestamp: sweepStartedAt });
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Crucix] Starting sweep at ${new Date().toLocaleTimeString()}`);
  console.log(`${'='.repeat(60)}`);

  try {
    // 1. Run the full briefing sweep
    const rawData = await fullBriefing();

    // 2. Save to runs/latest.json
    saveSnapshot(RUNS_DIR, rawData);
    lastSweepTime = new Date().toISOString();

    // 3. Synthesize into dashboard format
    console.log('[Crucix] Synthesizing dashboard data...');
    const synthesized = await synthesize(rawData);

    // Calculate against the prior run; persist only after ideas have been resolved.
    const previous = memory.getLastRun();
    const delta = computeDelta(synthesized, previous, config.delta.thresholds,
      memory.getRunHistory().map(run => run.data));
    synthesized.delta = delta;
    Object.assign(synthesized, await ideaCadence.resolve(llmProvider, synthesized, delta,
      previous?.ideas || [], config.llm.tradeIdeasLang));
    memory.addRun(synthesized, config.delta.thresholds);
    if (discordAlerter.isConfigured && synthesized.ideasSource === 'llm' && !synthesized.ideasCached) {
      discordAlerter.sendActionableIdeas(synthesized.ideas).catch(error =>
        console.error('[Discord] Idea delivery failed:', error.message));
    }

    // 6. Alert evaluation — Telegram + Discord (LLM with rule-based fallback, multi-tier, semantic dedup)
    if (delta?.summary?.totalChanges > 0) {
      if (telegramAlerter.isConfigured) {
        telegramAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Telegram alert error:', err.message);
        });
      }
      if (discordAlerter.isConfigured) {
        discordAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Discord alert error:', err.message);
        });
      }
    }

    // Prune old alerted signals
    memory.pruneAlertedSignals();

    recordSnapshotEvents(synthesized);
    // Country risk: sets synthesized.risk before the alert metrics read it and before the sweep is archived; never throws.
    recordRisk(synthesized, rawData);
    // Alert engine: never throws and does not wait for the notifications it sends.
    runAlertStep(synthesized, { engine: alertEngine, notifier: alertNotifier, delta });
    // Sets synthesized.changes and stores the sweep; never throws. After a failed write the next changes are counted from
    // the last sweep on disk, so the next archived sweep also covers this one.
    if (!archiveSweep({ archive: sweepArchive, snapshot: synthesized, timing: rawData.timing, previous: previousArchived }).error) previousArchived = synthesized;
    currentData = synthesized;

    // 6. Push to all connected browsers
    broadcast({ type: 'update', data: currentData });

    console.log(`[Crucix] Sweep complete — ${currentData.meta.sourcesOk}/${currentData.meta.sourcesQueried} sources OK`);
    console.log(`[Crucix] ${currentData.ideas.length} ideas (${synthesized.ideasSource}) | ${currentData.news.length} news | ${currentData.newsFeed.length} feed items`);
    if (delta?.summary) console.log(`[Crucix] Delta: ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical, direction: ${delta.summary.direction}`);
    console.log(`[Crucix] Next sweep at ${new Date(Date.now() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()}`);

  } catch (err) {
    console.error('[Crucix] Sweep failed:', err.message);
    broadcast({ type: 'sweep_error', error: err.message });
  } finally {
    sweepInProgress = false;
  }
}

// === Startup ===
async function start() {
  const port = config.port;

  console.log(`
  ╔══════════════════════════════════════════════╗
  ║           CRUCIX INTELLIGENCE ENGINE         ║
  ║          Local Intelligence Engine          ║
  ╠══════════════════════════════════════════════╣
  ║  Dashboard:  http://localhost:${port}${' '.repeat(14 - String(port).length)}║
  ║  Health:     http://localhost:${port}/api/health${' '.repeat(Math.max(0, 4 - String(port).length))}║
  ║  Refresh:    Every ${config.refreshIntervalMinutes} min${' '.repeat(20 - String(config.refreshIntervalMinutes).length)}║
  ║  LLM:        ${(config.llm.provider || 'disabled').padEnd(31)}║
  ║  Telegram:   ${config.telegram.botToken ? 'enabled' : 'disabled'}${' '.repeat(config.telegram.botToken ? 24 : 23)}║
  ║  Discord:    ${config.discord?.botToken ? 'enabled' : config.discord?.webhookUrl ? 'webhook only' : 'disabled'}${' '.repeat(config.discord?.botToken ? 24 : config.discord?.webhookUrl ? 20 : 23)}║
  ╚══════════════════════════════════════════════╝
  `);

  const server = app.listen(port, config.host);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[Crucix] FATAL: Port ${port} is already in use!`);
      console.error(`[Crucix] A previous Crucix instance may still be running.`);
      console.error(`[Crucix] Identify the process using this port, or change PORT in .env.\n`);
    } else {
      console.error(`[Crucix] Server error:`, err.stack || err.message);
    }
    process.exit(1);
  });

  server.on('listening', async () => {
    console.log(`[Crucix] Server running on http://localhost:${port}`);

    // Auto-open browser
    openBrowser(`http://localhost:${port}`);

    // Try to load existing data first for instant display (await so dashboard shows immediately)
    try {
      const existing = JSON.parse(readFileSync(join(RUNS_DIR, 'latest.json'), 'utf8'));
      const data = await synthesize(existing, { news: [] });
      recordSnapshotEvents(data);
      // The stored references and VIEWS/INFORM inputs of runs/latest.json give the dashboard a risk summary at once; the
      // event ids are cached, so the next sweep does not count these events twice.
      recordRisk(data, existing);
      // Stale data without a delta: show the stored alerts, do not evaluate. Not archived: this copy is re-synthesized without its
      // news, and the sweep behind runs/latest.json was archived when it ran - except on the first start after the upgrade to a
      // version with an archive, when that sweep ran before there was one. The initial sweep below is then the first one stored.
      attachAlertSummary(data, alertEngine);
      currentData = data;
      lastSweepTime = data.meta?.timestamp || null;
      console.log('[Crucix] Loaded existing data from runs/latest.json — dashboard ready instantly');
      broadcast({ type: 'update', data: currentData });
    } catch {
      console.log('[Crucix] No existing data found — first sweep required');
    }

    // Live AIS vessel counts at the maritime chokepoints: one aisstream.io WebSocket for the life of the server, only with a key.
    if (process.env.AISSTREAM_API_KEY) startMaritimeCollector(process.env.AISSTREAM_API_KEY);

    // Run first sweep (refreshes data in background)
    console.log('[Crucix] Running initial sweep...');
    runSweepCycle().catch(err => {
      console.error('[Crucix] Initial sweep failed:', err.message || err);
    });

    // Schedule recurring sweeps
    setInterval(runSweepCycle, config.refreshIntervalMinutes * 60 * 1000);
  });
}

// Graceful error handling — log full stack traces for diagnosis
process.on('unhandledRejection', (err) => {
  console.error('[Crucix] Unhandled rejection:', err?.stack || err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[Crucix] Uncaught exception:', err?.stack || err?.message || err);
});

start().catch(err => {
  console.error('[Crucix] FATAL — Server failed to start:', err?.stack || err?.message || err);
  process.exit(1);
});
