# Architecture

How a sweep flows from the sources to the dashboard, and the design rules behind it.

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

## Architecture

```
crucix/
├── server.mjs                 # Express server: sweep loop, SSE, APIs, bots, alert and risk steps
├── crucix.config.mjs          # Configuration with env var overrides + delta thresholds + watched scopes
├── diag.mjs                   # Diagnostic script — run if server fails to start
├── .env.example               # All documented env vars
├── Dockerfile, docker-compose.yml
├── locales/                   # en.json, hu.json, fr.json (dashboard and server texts)
│
├── apis/
│   ├── briefing.mjs           # Master orchestrator — runs all 71 sources in parallel
│   ├── save-briefing.mjs      # CLI: save timestamped + latest.json
│   ├── utils/                 # safeFetch() (timeout, retries, bounded bodies), freshness policies, .env loader
│   └── sources/               # 71 source adapters, each exports briefing() and runs standalone:
│       ├── gdelt.mjs          #   node apis/sources/gdelt.mjs
│       ├── nhc.mjs, launches.mjs, adsb-orbits.mjs, openmeteo-wind.mjs ...
│       └── ...                # (live "current public data" adapters return freshResult rows)
│
├── dashboard/
│   ├── inject.mjs             # Data synthesis for the page (thermal, air, nuclear, cyclones, signals ...)
│   └── public/
│       ├── jarvis.html        # The HUD: globe, flat map, panels
│       ├── *.js, *.css        # Browser modules: record inspector, alerts, lenses, replay, risk, palette, credits ...
│       ├── data/              # Static datasets: infrastructure.json, sites.json
│       ├── vendor/            # Pinned local assets: globe.gl, D3, GSAP, fonts, textures (+ licences)
│       └── sw.js, pwa.js      # Offline shell (service worker)
│
├── lib/
│   ├── llm/                   # LLM abstraction (10 providers, raw fetch, no SDKs) + rule-based ideas
│   ├── delta/                 # Change tracking between sweeps (semantic dedup, severity scoring, hot/cold memory)
│   ├── alerts/                # Telegram/Discord bots, the v2.10 alert engine, notifiers, routes
│   ├── intelligence/          # Events, history and export, country risk, predictions, keywords and anomalies,
│   │                          # live-source normalisation, nearby infrastructure and military-site lookup
│   ├── sweeps/                # Sweep archive, changes, source-health matrix routes
│   ├── basemap.mjs            # Daily NASA GIBS basemap cache
│   └── *.mjs                  # HTTP security, SSE, snapshots, i18n, domains (lenses), offline shell
│
├── scripts/                   # check.mjs (syntax + locales), build-sites.mjs, watchlist.mjs, QA helpers
├── test/                      # node:test suites and fixtures (npm test)
├── docs/                      # OPERATIONS.md, release notes (docs/releases), audits, watchlist.json, site
│
└── runs/                      # Runtime data (gitignored)
    ├── latest.json            # Most recent sweep output
    ├── memory/                # Delta memory (hot.json + cold/YYYY-MM-DD.json)
    ├── sweeps/                # Sweep archive for replay and the source-health matrix
    ├── intelligence/          # History, country scores, predictions, keywords
    └── alerts/                # Alerts and rules
```

### Design Principles
- **Pure ESM** — every file is `.mjs` with explicit imports
- **Minimal dependencies** — three runtime packages: Express, `fast-xml-parser` (XML feeds) and `h3-js` (GPSJam hexagons). `discord.js` is optional (for the Discord bot). LLM providers use raw `fetch()`, no SDKs; browser libraries are pinned local assets.
- **Parallel execution** — `Promise.allSettled()` fires all 71 sources simultaneously
- **Graceful degradation** — missing keys are disabled, upstream errors are visible, and model failures use rules. Other sources continue.
- **Each source is standalone** — run `node apis/sources/gdelt.mjs` to test any source independently
- **Provider time, never collection time** — live rows carry the provider's own timestamp and a freshness policy; stale data is labelled or withheld, and a source's attribution and licence travel with its rows
- **Self-contained dashboard** — the HTML file works with or without the server
