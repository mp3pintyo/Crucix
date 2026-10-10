# Configuration

Bots, the LLM layer, API keys, environment variables and npm scripts. Everything is optional: with no keys at all Crucix still runs with the keyless sources.

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

## Telegram Bot (Two-Way)
Crucix doubles as an interactive Telegram bot. Beyond sending alerts, it responds to commands directly from your chat:

| Command | What It Does |
|---------|-------------|
| `/status` | System health, last sweep time, source status, LLM status |
| `/sweep` | Trigger a manual sweep cycle |
| `/brief` | Compact text summary of the latest intelligence (direction, key metrics, top OSINT) |
| `/portfolio` | Portfolio status (if Alpaca connected) |
| `/alerts` | Recent alert history with tiers |
| `/mute` / `/mute 2h` | Silence alerts for 1h (or custom duration) |
| `/unmute` | Resume alerts |
| `/help` | Show all available commands |

This requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`. The bot polls for messages every 5 seconds (configurable via `TELEGRAM_POLL_INTERVAL`).

## Discord Bot (Two-Way)

Crucix also supports Discord as a full-featured bot with slash commands and rich embed alerts. It mirrors the Telegram bot's capabilities with Discord-native formatting.

| Command | What It Does |
|---------|-------------|
| `/status` | System health, last sweep time, source status, LLM status |
| `/sweep` | Trigger a manual sweep cycle |
| `/brief` | Compact text summary of the latest intelligence |
| `/portfolio` | Portfolio status (if Alpaca connected) |

Alerts are delivered as rich embeds with color-coded sidebars: red for FLASH, yellow for PRIORITY, blue for ROUTINE. Each embed includes signal details, confidence scores, and cross-domain correlations.

**Setup requires:** `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, and optionally `DISCORD_GUILD_ID` for instant slash command registration. See [API Keys Setup](#api-keys-setup) for details.

**Webhook fallback:** If you don't want to run a full bot, set `DISCORD_WEBHOOK_URL` instead. This enables one-way alerts (no slash commands) with zero dependencies — no `discord.js` needed.

**Optional dependency:** The full bot requires `discord.js`. Install it with `npm install discord.js`. If it's not installed, Crucix automatically falls back to webhook-only mode.

## Optional LLM Layer
Connect any of 10 LLM providers for enhanced analysis:
- **AI trade ideas** — quantitative analyst producing 5-8 actionable ideas citing specific data
- **Smarter alert evaluation** — LLM classifies signals into FLASH/PRIORITY/ROUTINE tiers with cross-domain correlation and confidence scoring
- Providers: Anthropic Claude, OpenAI, Google Gemini, OpenRouter (Unified API), OpenAI Codex (ChatGPT subscription), MiniMax, Mistral, Grok, Ollama, and OpenAI-compatible servers
- Graceful fallback — when LLM is unavailable, a rule-based engine takes over alert evaluation. LLM failures never crash the sweep cycle.

## API Keys Setup

Copy `.env.example` to `.env` at the project root:

```bash
cp .env.example .env
```

### Required for Best Results (all free)

| Key | Source | How to Get |
|-----|--------|------------|
| `FRED_API_KEY` | Federal Reserve Economic Data | [fred.stlouisfed.org](https://fred.stlouisfed.org/docs/api/api_key.html) — instant, free |
| `FIRMS_MAP_KEY` | NASA FIRMS (satellite fire data) | [firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov/api/area/) — instant, free |
| `EIA_API_KEY` | US Energy Information Administration | [api.eia.gov](https://www.eia.gov/opendata/register.php) — instant, free |

These three unlock the most valuable economic and satellite data. Each takes about 60 seconds to register.

### Optional (enable additional sources)

| Key | Source | How to Get |
|-----|--------|------------|
| `ACLED_EMAIL` + `ACLED_PASSWORD` | Armed conflict event data | [acleddata.com/register](https://acleddata.com/register/) — free, OAuth2 |
| `AISSTREAM_API_KEY` | Maritime AIS vessel tracking | [aisstream.io](https://aisstream.io/) — free |
| `ADSB_API_KEY` | Unfiltered flight tracking | [RapidAPI](https://rapidapi.com/adsbexchange/api/adsbexchange-com1) — ~$10/mo |

### LLM Provider (optional, for AI-enhanced ideas)

Set `LLM_PROVIDER` to one of: `anthropic`, `openai`, `gemini`, `codex`, `openrouter`, `minimax`, `mistral`, `grok`, `ollama`, `openai-compatible`

| Provider | Key Required | Default Model |
|----------|-------------|---------------|
| `anthropic` | `LLM_API_KEY` or `ANTHROPIC_AUTH_TOKEN` | claude-sonnet-4-6 |
| `openai` | `LLM_API_KEY` | gpt-5.4 |
| `gemini` | `LLM_API_KEY` | gemini-3.1-pro |
| `openrouter` | `LLM_API_KEY` | openrouter/auto |
| `codex` | None (uses `~/.codex/auth.json`) | first listed model of your account (gpt-6.1-sol) |
| `minimax` | `LLM_API_KEY` | MiniMax-M2.5 |
| `mistral` | `LLM_API_KEY` | mistral-large-latest |
| `grok` | `LLM_API_KEY` | grok-4-latest |
| `ollama` | None | llama3.1:8b |
| `openai-compatible` | Optional | local-model (override for your server) |

For Codex, run `npx @openai/codex login` to authenticate via your ChatGPT subscription.

### Telegram Bot + Alerts (optional)

| Key | How to Get |
|-----|------------|
| `TELEGRAM_BOT_TOKEN` | Create via [@BotFather](https://t.me/BotFather) on Telegram |
| `TELEGRAM_CHAT_ID` | Get via [@userinfobot](https://t.me/userinfobot) |
| `TELEGRAM_CHANNELS` | *(Optional)* Comma-separated extra channel IDs to monitor beyond the 17 built-in channels |
| `TELEGRAM_POLL_INTERVAL` | *(Optional)* Bot command polling interval in ms (default: 5000) |

### Discord Bot + Alerts (optional)

| Key | How to Get |
|-----|------------|
| `DISCORD_BOT_TOKEN` | Create at [Discord Developer Portal](https://discord.com/developers/applications) → Bot → Token |
| `DISCORD_CHANNEL_ID` | Right-click channel in Discord (Developer Mode on) → Copy Channel ID |
| `DISCORD_GUILD_ID` | *(Optional)* Right-click server → Copy Server ID. Enables instant slash command registration (otherwise takes up to 1 hour for global commands) |
| `DISCORD_WEBHOOK_URL` | *(Optional)* Channel Settings → Integrations → Webhooks → New Webhook → Copy URL. Use this for alert-only mode without a bot |

**Discord bot setup:**
1. Go to [Discord Developer Portal](https://discord.com/developers/applications) and create a new application
2. Go to **Bot** → click **Reset Token** → copy the token to `DISCORD_BOT_TOKEN`
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**
4. Go to **OAuth2** → **URL Generator** → select `bot` + `applications.commands` scopes → select `Send Messages` + `Embed Links` permissions
5. Copy the generated URL and open it in your browser to invite the bot to your server
6. Install the dependency: `npm install discord.js`

Alerts work with or without an LLM on both Telegram and Discord. With an LLM configured, signal evaluation is richer and more context-aware. Without one, a deterministic rule engine evaluates signals based on severity, cross-domain correlation, and signal counts. Messages of the v2.10 [alert engine](FEATURES.md#alert-engine-v210) reach Telegram and Discord only when `ALERT_NOTIFY_CHANNELS` lists them.

### Without Any Keys

Crucix still works with zero API keys. Most of the 71 sources need no authentication at all, including all 36 live feeds and the country context inputs; the few that need a key or an account (FRED, FIRMS, EIA, ACLED, Reddit, Cloudflare Radar, ADS-B Exchange, optional Telegram) report a structured error or stay disabled, and the rest of the sweep continues normally.

## npm Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `npm run dev` | `node --trace-warnings server.mjs` | Start dashboard with auto-refresh |
| `npm run sweep` | `node apis/briefing.mjs` | Run a single sweep, output JSON to stdout |
| `npm run inject` | `node dashboard/inject.mjs` | Inject latest data into static HTML |
| `npm run brief:save` | `node apis/save-briefing.mjs` | Run sweep + save timestamped JSON |
| `npm run diag` | `node diag.mjs` | Run diagnostics (Node version, imports, port check) |
| `npm test` | `node --test test/*.test.mjs` | Local regressions using mocks/fixtures |
| `npm run check` | `node scripts/check.mjs` | JavaScript syntax and locale checks |

---

## Configuration

All settings are in `.env` with sensible defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3117` | Dashboard server port |
| `REFRESH_INTERVAL_MINUTES` | `15` | Auto-refresh interval |
| `LLM_PROVIDER` | disabled | `anthropic`, `openai`, `gemini`, `codex`, `openrouter`, `minimax`, `mistral`, `ollama`, `grok`, `openai-compatible` |
| `LLM_API_KEY` | — | API key (not needed for codex/local Ollama; optional for a local compatible server) |
| `LLM_MODEL` | per-provider default | Override model selection |
| `TELEGRAM_BOT_TOKEN` | disabled | For Telegram alerts + bot commands |
| `TELEGRAM_CHAT_ID` | — | Your Telegram chat ID |
| `TELEGRAM_CHANNELS` | — | Extra channel IDs to monitor (comma-separated) |
| `TELEGRAM_POLL_INTERVAL` | `5000` | Bot command polling interval (ms) |
| `DISCORD_BOT_TOKEN` | disabled | For Discord alerts + slash commands |
| `DISCORD_CHANNEL_ID` | — | Discord channel for alerts |
| `DISCORD_GUILD_ID` | — | Server ID (instant slash command registration) |
| `DISCORD_WEBHOOK_URL` | — | Webhook URL (alert-only fallback, no bot needed) |
| `LLM_BASE_URL` | — | Separate OpenAI-compatible endpoint |
| `ANTHROPIC_BASE_URL` | — | Anthropic Messages endpoint for `LLM_PROVIDER=anthropic` (a self-hosted gateway or router); default `https://api.anthropic.com` |
| `ANTHROPIC_AUTH_TOKEN` | — | Bearer token for `LLM_PROVIDER=anthropic`, sent as `Authorization: Bearer` instead of `x-api-key`; use it or `LLM_API_KEY`, not both |
| `LLM_IDEAS_EVERY_N_SWEEPS` | `1` | First sweep, then every Nth sweep; delta alerts run every sweep |
| `TELEGRAM_OSINT_ENABLED` | `false` | Opt-in public preview source |
| `ALERT_NOTIFY_CHANNELS` | — | `telegram` and/or `discord` (comma-separated): also send alert engine messages there (opt-in; their `/mute` applies) |
| `ALERT_NOTIFY_MIN_SEVERITY` | `high` | Lowest severity that is sent out: `critical`, `high`, `watch`, `info` |
| `ALERT_QUIET_HOURS` | — | `HH:MM-HH:MM` in server local time; only critical goes out, the rest follows as one summary |
| `ALERT_MAX_NOTIFICATIONS_PER_SWEEP` | `5` | Individual messages per sweep (1–50); the rest is one "+N more alerts" summary |
| `ALERT_PUBLIC_URL` | — | Dashboard link added to alert messages (separate from `PUBLIC_URL`); its origin is accepted for alert changes behind a reverse proxy |
| `ALERT_ALLOWED_HOSTS` | — | Host names (comma-separated) that may change alerts when `AUTH_USER`/`AUTH_PASSWORD` are not set |
| `ALERT_NTFY_URL` | — | ntfy topic URL, http(s) without credentials |
| `ALERT_NTFY_TOKEN` | — | Optional ntfy access token (Bearer header) |
| `ALERT_WEBHOOK_URL` | — | Webhook that receives each alert as a JSON POST |
| `ALERT_MAX_ACTIVE_PER_RULE` | `50` | Open alerts per rule (1–500); further hits are counted, not opened |
| `SWEEP_ARCHIVE_COUNT` | `96` | Sweeps kept in `RUNS_DIR/sweeps` for replay, changes and the source-health matrix (2–672; 96 = 24 hours at 15 minutes) |
| `SWEEP_ARCHIVE_MAX_MB` | `64` | Disk budget of the sweep archive in MB (4–512); the oldest sweeps go first, the newest is always kept |
| `RISK_ENABLED` | `true` | Country risk step, logged predictions and briefings; `false` writes no files and leaves `/api/countries`, `/api/predictions` and `/api/briefing` uninstalled (404) |
| `RISK_RETENTION_DAYS` | `35` | Days of event references and score history kept in `RUNS_DIR/intelligence/countries.json` (14–90) |
| `LLM_BRIEFING_MAX_TOKENS` | `1200` | Output budget of a cited briefing (128–8192) |
| `LLM_BRIEFING_TIMEOUT_MS` | `60000` | Timeout of a cited briefing (1000–360000 ms); a failure gives the rule-based briefing |

Delta engine thresholds (how sensitive the system is to changes between sweeps) can be customized in `crucix.config.mjs` under the `delta.thresholds` section. The defaults are tuned to filter out noise while catching meaningful moves.
