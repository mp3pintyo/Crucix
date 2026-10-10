// Crucix Configuration — all settings with env var overrides

import "./apis/utils/env.mjs"; // Load .env first

export function envInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return Number(raw);
}

export function envUrl(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${name} must be an absolute HTTP or HTTPS URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${name} must use HTTP or HTTPS without embedded credentials`);
  }
  return url.toString().replace(/\/$/, '');
}

// An optional http(s) URL from the environment. Unlike envUrl it never throws: an unusable value (other scheme,
// embedded credentials, not a URL) is treated as unset and the warning names the variable only, never its value.
function envUrlOrNull(name) {
  try {
    return envUrl(name, null);
  } catch (error) {
    console.warn(`[Config] ${error.message}; ${name} is ignored`);
    return null;
  }
}

// A comma-separated list from the environment: trimmed, lower-cased, each entry once, in order. Entries that `accept`
// refuses are dropped with one warning that names the variable only, never an entry (it may be a mistyped secret).
function envList(name, accept, expected) {
  const entries = [];
  let rejected = false;
  for (const raw of (process.env[name] || '').split(',')) {
    const entry = raw.trim().toLowerCase();
    if (entry === '') continue;
    if (!accept(entry)) rejected = true;
    else if (!entries.includes(entry)) entries.push(entry);
  }
  if (rejected) console.warn(`[Config] ${name} has entries that are not ${expected}; they are ignored`);
  return entries;
}
// A comma-separated list of browser origins (scheme://host[:port], no path) from the environment. `wildcard` additionally accepts
// a lone `*`. Anything else is dropped with one warning that names the variable only.
function envOrigins(name, { wildcard = false } = {}) {
  const origin = entry => {
    try { const url = new URL(entry); return ['http:', 'https:'].includes(url.protocol) && url.origin === entry && !url.username ? url.origin : null; }
    catch { return null; }
  };
  return envList(name, entry => (wildcard && entry === '*') || origin(entry) !== null, wildcard ? 'origins or *' : 'origins like https://example.com');
}
// An on/off switch from the environment: unset or empty gives the fallback; anything but true/false/1/0/yes/no/on/off stops startup.
export function envBoolean(name, fallback) {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return fallback;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}
const HOST_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export default {
  port: envInteger('PORT', 3117, 1, 65535),
  host: process.env.HOST || '127.0.0.1',
  runsDir: process.env.RUNS_DIR || null,
  publicUrl: envUrl('PUBLIC_URL', `http://localhost:${envInteger('PORT', 3117, 1, 65535)}`),
  auth: { user: process.env.AUTH_USER || '', password: process.env.AUTH_PASSWORD || '' },
  maxSseClients: envInteger('MAX_SSE_CLIENTS', 100, 1, 10000),
  // Opt-in browser access from other sites (both empty = off, the default). corsOrigins: pages from these origins (or `*`) may
  // READ the GET /api routes; embedOrigins: pages from these origins may show the dashboard / widget in an iframe.
  web: {
    corsOrigins: envOrigins('CORS_ORIGINS', { wildcard: true }),
    embedOrigins: envOrigins('EMBED_ORIGINS'),
  },
  refreshIntervalMinutes: envInteger('REFRESH_INTERVAL_MINUTES', 15, 1, 1440),

  // Small public watchlists. Adapters validate/cap these values; no API keys.
  publicSources: {
    meteoalarmCountries: ['hungary', 'austria', 'germany'],
    routingASNs: ['AS5483'],
    weatherLocations: [{ label: 'Budapest', lat: 47.4979, lon: 19.0402 }],
    ooniCountries: ['HU'],
    // Names exactly as the IMF PortWatch layer spells them.
    portwatchChokepoints: ['Strait of Hormuz', 'Bab el-Mandeb Strait', 'Suez Canal', 'Malacca Strait', 'Bosporus Strait', 'Panama Canal', 'Gibraltar Strait', 'Dover Strait'],
    // Military air activity (adsb.lol, apis/sources/adsb-military.mjs): one aggregate row per theater, never one row per aircraft. A theater is a
    // box (degrees; edges included; lonMin > lonMax crosses the antimeridian). An aircraft counts in the FIRST box of this list that contains it,
    // so overlaps and shared borders belong to the earlier box. Ids must be unique (a repeated id is skipped); the row link carries the id. At most 12.
    //   black-sea         Ukraine, Belarus south, Moldova, east Romania, the Black Sea and Azov, Crimea, Russia west of 42 E (Kursk to Rostov).
    //                     West edge 24 E: eastern Poland, Slovakia, Hungary and Romania west of it are in central-europe (Anatolia, 38-40.5 N, is in no box).
    //   east-med          Greece south of 38 N and Crete, the Turkish south coast, Cyprus, Syria and Lebanon coast, Israel, Nile delta, east Libya coast.
    //   middle-east-gulf  Red Sea and Yemen to Iran and the Arabian Sea up to 62 E; the overlap with east-med (34-36.5 E) goes to east-med.
    //   baltic            Baltic Sea with Denmark's islands, south Sweden, south Finland, Estonia/Latvia/Lithuania, Kaliningrad and Poland's coast (from 53.5 N).
    //   south-china-sea-taiwan  South China Sea, Taiwan Strait, Hainan, west Philippines, Vietnam coast.
    //   korea             The Korean Peninsula with the Yellow Sea and the East Sea (Sea of Japan) coast.
    //   central-europe    Hungary and its neighbours: Germany east of 8 E, Austria, Czechia, Slovakia, Poland (to 53.5 N), Balkans north of 44 N.
    adsbTheaters: [
      { id: 'black-sea', label: 'Black Sea and Ukraine', latMin: 40.5, latMax: 52.5, lonMin: 24, lonMax: 42 },
      { id: 'east-med', label: 'Eastern Mediterranean', latMin: 30, latMax: 38, lonMin: 22, lonMax: 36.5 },
      { id: 'middle-east-gulf', label: 'Middle East and Gulf', latMin: 12, latMax: 38, lonMin: 34, lonMax: 62 },
      { id: 'baltic', label: 'Baltic Sea', latMin: 53.5, latMax: 66, lonMin: 9, lonMax: 30 },
      { id: 'south-china-sea-taiwan', label: 'South China Sea and Taiwan', latMin: 5, latMax: 27, lonMin: 105, lonMax: 124 },
      { id: 'korea', label: 'Korean Peninsula', latMin: 33, latMax: 43, lonMin: 124, lonMax: 131.5 },
      { id: 'central-europe', label: 'Central Europe', latMin: 44, latMax: 53.5, lonMin: 8, lonMax: 24 },
    ],
    // Prediction markets (Manifold, apis/sources/prediction-markets.mjs): the words to look for, one request each. A market is listed when every
    // word of an entry starts a word of its question (any letter case, accents ignored), it has not closed and it had a bet in the last 12 hours.
    // Plain text only: entries that are not text, have no word of two characters or repeat an earlier one are skipped, an entry is cut to 60
    // characters, and at most 6 entries are used (the rest of the list is ignored).
    marketQueries: ['Hormuz', 'Ukraine', 'Iran', 'Taiwan', 'recession'],
  },

  llm: {
    provider: process.env.LLM_PROVIDER || null, // anthropic | openai | gemini | codex | openrouter | minimax | mistral | ollama | grok
    apiKey: process.env.LLM_API_KEY || null,
    model: process.env.LLM_MODEL || null,
    baseUrl: process.env.OLLAMA_BASE_URL || null,
    compatibleBaseUrl: process.env.LLM_BASE_URL || null,
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || null,
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN || null,
    reasoningEffort: process.env.OLLAMA_REASONING_EFFORT || null,
    ideasMaxTokens: envInteger('LLM_IDEAS_MAX_TOKENS', 4096, 128, 16384),
    ideasTimeoutMs: envInteger('LLM_IDEAS_TIMEOUT_MS', 90000, 1000, 360000),
    alertMaxTokens: envInteger('LLM_ALERT_MAX_TOKENS', 800, 128, 4096),
    alertTimeoutMs: envInteger('LLM_ALERT_TIMEOUT_MS', 30000, 1000, 360000),
    briefingMaxTokens: envInteger('LLM_BRIEFING_MAX_TOKENS', 1200, 128, 8192), // cited briefings (getLLMBudget(config, 'briefing'))
    briefingTimeoutMs: envInteger('LLM_BRIEFING_TIMEOUT_MS', 60000, 1000, 360000),
    everyNSweeps: envInteger('LLM_IDEAS_EVERY_N_SWEEPS', 1, 1, 96),
    tradeIdeasLang: process.env.TRADE_IDEAS_LANG || process.env.CRUCIX_LANG || 'en',
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || null,
    chatId: process.env.TELEGRAM_CHAT_ID || null,
    botPollingInterval: envInteger('TELEGRAM_POLL_INTERVAL', 5000, 1000, 300000),
    channels: process.env.TELEGRAM_CHANNELS || null, // Comma-separated extra channel IDs
  },

  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || null,
    channelId: process.env.DISCORD_CHANNEL_ID || null,
    guildId: process.env.DISCORD_GUILD_ID || null, // Server ID (for instant slash command registration)
    allowedUserIds: (process.env.DISCORD_ALLOWED_USER_IDS || '').split(',').map(id => id.trim()).filter(Boolean),
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || null, // Fallback: webhook-only alerts (no bot needed)
  },

  // Alert engine: notification channels exist only when their variable is set (see .env.example)
  alerts: {
    // Telegram and Discord carry engine alerts only when listed here (their bots already send the delta alerts)
    notifyChannels: envList('ALERT_NOTIFY_CHANNELS', entry => entry === 'telegram' || entry === 'discord', 'telegram or discord'),
    notifyMinSeverity:(process.env.ALERT_NOTIFY_MIN_SEVERITY || '').trim().toLowerCase() || 'high', // critical | high | watch | info; the notifier validates it
    quietHours: (process.env.ALERT_QUIET_HOURS || '').trim() || null, // HH:MM-HH:MM local time; the notifier validates it
    maxNotificationsPerSweep: envInteger('ALERT_MAX_NOTIFICATIONS_PER_SWEEP', 5, 1, 50),
    publicUrl: envUrlOrNull('ALERT_PUBLIC_URL'), // dashboard link added to notifications; its origin may change alerts too
    // Without AUTH_USER/AUTH_PASSWORD, alert changes are taken only through these host names, an IP address, localhost or
    // the ALERT_PUBLIC_URL host (a guard against DNS rebinding)
    allowedHosts: envList('ALERT_ALLOWED_HOSTS', entry => entry.length <= 253 && HOST_NAME.test(entry), 'host names'),
    ntfy: { url: envUrlOrNull('ALERT_NTFY_URL'), token: process.env.ALERT_NTFY_TOKEN || null },
    webhook: { url: envUrlOrNull('ALERT_WEBHOOK_URL') },
    maxActivePerRule: envInteger('ALERT_MAX_ACTIVE_PER_RULE', 50, 1, 500),
  },

  // Sweep archive (<RUNS_DIR>/sweeps): replay, changes windows and the source-health matrix. The oldest sweeps go first
  // once either cap is reached; the newest sweep is always kept.
  sweeps: {
    count: envInteger('SWEEP_ARCHIVE_COUNT', 96, 2, 672), // 96 = 24 hours at the default 15-minute sweep
    maxMb: envInteger('SWEEP_ARCHIVE_MAX_MB', 64, 4, 512),
  },

  // Country risk, logged predictions and cited briefings (<RUNS_DIR>/intelligence/countries.json and predictions.json).
  // RISK_ENABLED=false skips the risk step entirely: no files are written and the /api/countries, /api/predictions and
  // /api/briefing routes are not installed (404).
  risk: {
    enabled: envBoolean('RISK_ENABLED', true),
    retentionDays: envInteger('RISK_RETENTION_DAYS', 35, 14, 90), // event references and score series kept
  },

  // Delta engine thresholds — override defaults from lib/delta/engine.mjs
  // Set to null to use built-in defaults
  delta: {
    thresholds: {
      numeric: {
        // Example overrides (uncomment to customize):
        // vix: 3,       // more sensitive to VIX moves
        // wti: 5,       // less sensitive to oil moves
      },
      count: {
        // urgent_posts: 3,     // need ±3 urgent posts to flag
        // thermal_total: 1000, // need ±1000 thermal detections
      },
    },
  },
};
