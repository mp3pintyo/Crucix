<div align="center">

# Crucix

**Your own intelligence terminal. 71 sources. One command. Local processing.**

[![Node.js 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](#quick-start)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPLv3-blue.svg)](LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-3-orange)](docs/ARCHITECTURE.md#design-principles)
[![Sources](https://img.shields.io/badge/OSINT%20sources-71-cyan)](docs/DATA-SOURCES.md#data-sources-71)
[![Docker](https://img.shields.io/badge/docker-ready-blue?logo=docker)](#docker)

![Crucix Dashboard](docs/dashboard.png)

<details>
<summary>More screenshots</summary>

| Boot Sequence | World Map |
|:---:|:---:|
| ![Boot](docs/boot.png) | ![Map](docs/map.png) |

| 3D Globe View |
|:---:|
| ![Globe](docs/globe.png) |

</details>

</div>

> **Fork:** this repository is a fork of [calesthio/Crucix](https://github.com/calesthio/Crucix).
> This fork's releases, audit and installation instructions are in this README and the [documentation pages](#documentation).
>
> **Showcase site:** an animated, bilingual (HU/EN) presentation of what Crucix does lives in [docs/site](docs/site/index.html) — open `docs/site/index.html` in a browser, no build step.

Crucix pulls satellite fire detection, flight tracking (including military air activity and orbits), radiation and wind at nuclear sites, cyclones and launches, earthquakes and disasters, economic indicators, live market prices, conflict data, sanctions lists, cyber and internet signals and social sentiment from 71 open-source intelligence sources — in parallel, every 15 minutes — and renders everything on a single Jarvis-style dashboard with a 3D globe and a flat map. On top of the raw feeds it keeps a searchable event history, a country risk index, an alert engine and a replayable sweep archive.

Hook it up to an LLM and it becomes a **two-way intelligence assistant** — pushing multi-tier alerts to Telegram and Discord when something meaningful changes, responding to commands like `/brief` and `/sweep` from your phone, and generating actionable trade ideas grounded in real cross-domain data. Your own analyst that watches the world while you sleep.

The server and data run on your machine. External feeds need network access; browser map/font libraries are pinned local assets. Cloud AI and paid APIs are optional. The app has no built-in telemetry. Start with `node server.mjs`.

## Documentation

The README is the short version. Everything else has its own page:

| | |
|---|---|
| [**Features by release**](docs/FEATURES.md) | What each version added: alert engine, country risk, record inspector, sweep archive, map layers, new sources |
| [**Configuration**](docs/CONFIGURATION.md) | API keys, Telegram and Discord bots, the LLM layer, environment variables, npm scripts |
| [**Data sources**](docs/DATA-SOURCES.md) | All 71 sources by tier, with keys, licences and limits |
| [**HTTP API**](docs/API.md) | The JSON API: routes, parameters, errors, CORS, recipes |
| [**Embedding**](docs/EMBEDDING.md) | Show Crucix or a status widget on your own site (iframe) |
| [**Architecture**](docs/ARCHITECTURE.md) | The sweep cycle, components and design principles |
| [**Operations**](docs/OPERATIONS.md) | LAN, Docker, local models and day-to-day use (Hungarian) |
| [**Troubleshooting**](docs/TROUBLESHOOTING.md) | Start-up and data problems |
| [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) | |

> **Use it from your own code:** every panel is backed by a JSON route, so scripts, bots and other sites can read the same data (`curl http://localhost:3117/api/alerts/summary`). See the [HTTP API](docs/API.md) and [embedding](docs/EMBEDDING.md) guides.

---

## Token / Asset Warning

> [!WARNING]
> **Crucix has not launched any official token, coin, NFT, airdrop, presale, or other blockchain-based asset.**
> Any token or digital asset using the Crucix name, logo, or branding is not affiliated with or endorsed by Crucix.
> Do not buy it, promote it, connect a wallet to claim it, sign transactions, or send funds based on third-party posts, DMs, or websites.

---

## Why This Exists

Most of the world's real-time intelligence — satellite imagery, radiation levels, conflict events, economic indicators, flight tracking, maritime activity — is publicly available. It's just scattered across dozens of government APIs, research institutions, and open data feeds that nobody has time to check individually.

Crucix brings it all into one place. Not behind a paywall, not locked in an enterprise platform, not requiring a security clearance. Just open data, aggregated and cross-correlated on your own machine, updated every 15 minutes.

It was built for anyone who wants to understand what's actually happening in the world right now — researchers, journalists, traders, OSINT analysts, or just curious people who believe access to information shouldn't depend on your budget.

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/mp3pintyo/Crucix.git
cd Crucix

# 2. Install locked dependencies (Express, fast-xml-parser, h3-js, plus optional Discord support)
npm ci

# 3. Copy env template and add your API keys (see docs/CONFIGURATION.md)
cp .env.example .env

# 4. Start the dashboard
npm run dev
```

> **If `npm run dev` fails silently** (exits with no output), run Node directly instead:
> ```bash
> node --trace-warnings server.mjs
> ```
> This bypasses npm's script runner, which can swallow errors on some systems (particularly PowerShell on Windows). You can also run `node diag.mjs` to diagnose the exact issue — it checks your Node version, tests each module import individually, and verifies port availability. See [Troubleshooting](docs/TROUBLESHOOTING.md#troubleshooting) for more.

The dashboard opens automatically at `http://localhost:3117` and immediately begins its first intelligence sweep. This initial sweep queries all 71 sources in parallel and typically takes 30–60 seconds — the dashboard will appear empty until the sweep completes and pushes the first data update. After that, it auto-refreshes every 15 minutes via SSE (Server-Sent Events). No manual page refresh needed.

**Requirements:** Node.js 22+ (uses native `fetch`, top-level `await`, ESM)

### Docker

```bash
git clone https://github.com/mp3pintyo/Crucix.git
cd Crucix
cp .env.example .env    # add your API keys
docker compose up -d
```

Dashboard at `http://localhost:3117`. Sweep data persists in `./runs/` via volume mount. Includes a health check endpoint.

### Access and privacy (v2.1)

The native server and Docker published port default to localhost. For LAN access, set `HOST=0.0.0.0` for native Node, or `BIND_ADDRESS=0.0.0.0` for Compose. Set both `AUTH_USER` and `AUTH_PASSWORD` to protect the dashboard, JSON APIs and event stream. A partial credential configuration fails at startup. Use an HTTPS reverse proxy when exposing password-protected access beyond the local machine; HTTP Basic authentication does not encrypt credentials. `/healthz` exposes only a minimal health status without authentication.

`PUBLIC_URL` controls dashboard links in bot messages. `NO_AUTO_OPEN=1` disables automatic browser launch. `PORT` accepts integers from 1 to 65535. The event stream has heartbeats and a configurable `MAX_SSE_CLIENTS` limit.

Public Telegram preview collection is disabled by default. Set `TELEGRAM_OSINT_ENABLED=true` to enable it. The OSINT source never reads private messages or control-bot updates; `TELEGRAM_BOT_TOKEN` is used only for alerts and commands. Discord commands are restricted to the configured channel and guild. Sweep/mute/unmute require Manage Server/Administrator permission or membership in `DISCORD_ALLOWED_USER_IDS`.

To read the API or show the dashboard on another website, set `CORS_ORIGINS` and/or `EMBED_ORIGINS` (both off by default; see [HTTP API](docs/API.md#cross-origin-reads-cors) and [Embedding](docs/EMBEDDING.md)).

The container runs as UID 1000. On Linux, prepare the bind-mounted directory with `mkdir -p runs && sudo chown 1000:1000 runs` before starting Compose. Keep existing sweep files and adjust their ownership if necessary. The container checks `/healthz` using the configured port.

Run `npm run check` and `npm test` before submitting changes. See [the bilingual changelog](CHANGELOG.md) and [the audit plan](docs/audit/implementation-plan-2026-10-01.md).

---

## What You Get

### Live Dashboard
A self-contained Jarvis-style HUD with:
- **3D WebGL globe** (Globe.gl) with atmosphere glow, star field, and smooth rotation — plus a classic flat map toggle
- **Shared layer controls** across both views (22 layers): fire, air, radiation, maritime references, SDR, OSINT, health, inferred news, conflict, internet outages, weather, earthquakes, natural events, space stations, GNSS interference, cyclone forecast tracks and cones, orbital launches and (off by default) oil and gas pipelines, military bases, mapped military areas, data centres and dams. Located live records take the colour of their layer
- **Globe basemap button** — night lights or the daily NASA GIBS satellite image of yesterday; the **©** button lists the credits and licences of what is on screen
- **Animated 3D flight corridor arcs** between air traffic hotspots and global hubs
- **Region filters** (World, Americas, Europe, Middle East, Asia Pacific, Africa) — rotates the globe or zooms the flat map
- **Live market data** — indexes, crypto, energy, commodities via Yahoo Finance (no API key needed)
- **Risk gauges** — VIX, high-yield spread, supply chain pressure index
- **OSINT feed** — English-language posts from 17 Telegram intelligence channels (expandable)
- **News ticker** — merged RSS + GDELT headlines + Telegram posts, auto-scrolling. 52 RSS feeds carry a source tier (T1 official or wire … T4 aggregator, a ranking of the source, not of the headline), a language tag and a state-funded tag; seven Hungarian outlets are included (v2.18)
- **Sweep delta** — live panel showing what changed since last sweep (new signals, escalations, de-escalations with severity)
- **Cross-source signals** — correlated intelligence across satellite, economic, conflict, and social domains
- **Nuclear watch** — recent (72 h) radiation readings from Safecast, shown with their age, the modelled current wind at each site (Open-Meteo; not a dispersion forecast), plus EPA RadNet when reachable
- **Space watch** — CelesTrak satellite tracking: recent launches, ISS, military constellations, Starlink/OneWeb counts; Launch Library 2 launches of the next 14 days and the last 7 on the map
- **Leverageable ideas** — AI-generated trade ideas (with LLM) or signal-correlated ideas (without)
- **Intelligence layer on top** — record inspector, searchable history and exports, alert engine, domain lenses, sweep replay, country risk index with cited briefings and a source-health matrix (see [Features by release](docs/FEATURES.md) and the [HTTP API](docs/API.md))
- **Three languages** — the dashboard and the rule-based ideas and briefings follow `CRUCIX_LANG` (`en`, `hu`, `fr`)

### Performance Modes
The `VISUALS FULL` / `VISUALS LITE` button in the top bar only changes rendering behavior - it does **not** remove data sources or reduce sweep coverage.

When you switch to **VISUALS LITE**, the dashboard:
- Disables decorative background effects such as the radial/grid overlays and scanlines
- Removes expensive blur/backdrop-filter effects on panels and overlays
- Stops non-essential animations like the logo ring blink, conflict rings, and corridor flow effects
- Disables globe auto-rotation and turns off animated flight-arc dashes
- Converts the horizontal news ticker and OSINT stream into static, scrollable lists instead of continuously animated marquees

Mobile-specific behavior:
- On mobile, `VISUALS LITE` also forces the dashboard into **flat map mode** if you are currently on the globe
- Future mobile loads will continue to start flat while low-perf mode is enabled

The preference is saved in browser local storage, so the UI will remember your last setting.

### Auto-Refresh
The server runs a sweep cycle every 15 minutes (configurable). Each cycle:
1. Queries all 71 sources in parallel (~30s)
2. Synthesizes raw data into dashboard format
3. Computes delta from previous run (what changed, escalated, de-escalated) — visible in the **Sweep Delta** panel on the dashboard
4. Generates LLM trade ideas (if configured)
5. Evaluates breaking news alerts — multi-tier (FLASH / PRIORITY / ROUTINE) with semantic dedup. Sends to Telegram and/or Discord if configured. Works with LLM evaluation or falls back to rule-based alerting when LLM is unavailable.
6. Evaluates the [alert engine](docs/FEATURES.md#alert-engine-v210) rules: alerts for the dashboard and, if configured, ntfy/webhook (Telegram/Discord by opt-in)
7. Pushes update to all connected browsers via SSE

### Alerts, bots and the LLM layer
Alerts reach you on the dashboard, and optionally in Telegram, Discord, ntfy or a webhook; with an LLM key Crucix also writes trade ideas and cited briefings. Telegram and Discord are two-way (`/status`, `/brief`, `/sweep`, `/mute`, …). All of it is off until you set the matching keys: see [Configuration](docs/CONFIGURATION.md).


---

## Screenshots

The `docs/` folder contains dashboard screenshots referenced by this README:

| File | Description |
|------|-------------|
| `docs/dashboard.png` | Full dashboard — hero image at the top of this README |
| `docs/boot.png` | Cinematic boot sequence animation |
| `docs/map.png` | D3 world map with marker types and flight arcs |
| `docs/globe.png` | 3D WebGL globe view with atmosphere glow and markers |

The current set was taken from a real sweep on 2026-10-08 (v2.30.4; English UI, 1945×1233). To update them: run the dashboard (for screenshots, with the bots, the LLM and the alert channels left empty), wait for a sweep to complete, then use your browser's DevTools (`F12` → `Ctrl+Shift+P` → "Capture full size screenshot") or a tool like [LICEcap](https://www.cockos.com/licecap/) for GIFs.

---

## Contributing

Found a bug or want to add another source? PRs welcome. Each source is a standalone module in `apis/sources/` — export a `briefing()` function that returns structured data and add it to the orchestrator in `apis/briefing.mjs`. A "current public data" source (provider time, freshness policy, record inspector rows) also needs a freshness policy (`apis/utils/freshness.mjs`), a domain lens (`lib/domains.mjs` and its browser copy), fact captions in `locales/*.json` and the registry tests; see [CONTRIBUTING.md](CONTRIBUTING.md) and the release notes of a recent source (for example [v2.27.0](docs/releases/v2.27.0.md)).

If you find this useful, a star helps others find it too.

For contribution guidelines, review expectations, and source-add rules, see `CONTRIBUTING.md`. For security reports, see `SECURITY.md`.

---

## License

AGPL-3.0
