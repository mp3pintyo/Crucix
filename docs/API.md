# Crucix HTTP API

Crucix serves a JSON API next to the dashboard. The dashboard itself uses nothing else, so everything you see on screen
is available to your own scripts, spreadsheets, bots and websites.

- **Base URL:** `http://localhost:3117` (change with `PORT`; behind a proxy, your own host).
- **Format:** JSON, UTF-8. Exceptions: the CSV / HTML / STIX exports, the basemap JPEG and the event stream.
- **Version:** the API follows the app version ([changelog](../CHANGELOG.md)); there is no `/v1` prefix and no formal
  compatibility promise yet. Releases that change a documented route say so in their notes.
- **Quick try:** `curl http://localhost:3117/api/alerts/summary`

Other docs: [Embedding the dashboard and the widget](EMBEDDING.md) · [Configuration and operations](OPERATIONS.md) · [README](../README.md)

## Access

| Situation | What you do |
|-----------|-------------|
| Local, default | Nothing. The server listens on `127.0.0.1` only. |
| LAN / server (`HOST=0.0.0.0`) | Set `AUTH_USER` and `AUTH_PASSWORD`. Every route except `/healthz` then needs HTTP Basic auth: `curl -u user:password …`. Use HTTPS (a reverse proxy) when the traffic leaves your machine. |
| Calls from a browser page on **another site** | Set `CORS_ORIGINS` (below). |

There are no API keys, no rate limiter and no write access to the data: the API is read-only except the alert
operations. A sweep (the collection of all sources) runs every `REFRESH_INTERVAL_MINUTES` (default 15), so polling more
often than once a minute returns the same data. For push updates use the event stream.

### Cross-origin reads (CORS)

By default a page on another website cannot read the API from a visitor's browser. To allow it, list the origins:

```env
CORS_ORIGINS=https://example.com,https://dashboard.example.org
```

- Only `GET`/`HEAD` routes under `/api` get CORS headers (`Access-Control-Allow-Origin` is the matching origin, with
  `Vary: Origin`). `POST`/`PUT`/`DELETE` never do: a foreign page can read, never change alerts.
- With Basic auth the page sends the `Authorization` header itself (`fetch(url, {headers: {Authorization: 'Basic …'}})`);
  the preflight is answered without credentials, the data still needs them. Credentials mode (`include`) is not granted.
- `CORS_ORIGINS=*` allows every website. Use it only for an instance with `AUTH_USER`/`AUTH_PASSWORD` or one that holds
  nothing private; without them any page you open could read your local server (a warning is printed at start).
- `/events` and `/healthz` are outside `/api` and have no CORS headers.

```js
const res = await fetch('https://crucix.example.com/api/alerts/summary');
const { threat, counts } = await res.json();
```

## Errors

| Status | Body | Meaning |
|--------|------|---------|
| 400 | `{"error": "…", "code": "INVALID_FILTER", "field": "limit"}` | A bad or unknown query parameter or id; `field` names it |
| 401 | `{"error": "Authentication required"}` | Basic auth is on and missing or wrong |
| 404 | `{"error": "…"}` | Unknown id (sweep, event, country) |
| 503 | `{"error": "…temporarily unavailable"}` | No data yet (first sweep still running) or a store is unavailable. Never contains a stack or a provider message. |

Routes with a query string accept only the parameters listed below; an unknown one is a 400, not ignored.

## Endpoints

### Status

| Endpoint | Returns |
|----------|---------|
| `GET /healthz` | `{"status": "ok"}`, no authentication. For uptime monitors and the Docker health check. |
| `GET /api/health` | `status`, `uptime` (s), `lastSweep`, `nextSweep`, `sweepInProgress`, `sourcesOk`, `sourcesFailed`, `llmEnabled`, `language`, plus `historyStatus`, `riskStatus`, `archiveStatus` (`ok`, `unavailable`, `disabled`) and `archivedSweeps` |
| `GET /api/locales` | `{current, supported}` interface languages |

### The current picture

| Endpoint | Returns |
|----------|---------|
| `GET /api/data` | The full synthesized snapshot of the last sweep (several hundred KB): `meta` (sources queried / ok / failed), the source blocks (`air`, `thermal`, `fred`, `energy`, `news`, `markets`, `gdelt`, `liveSources`, …), `events`, `eventClusters`, `risk`, `alerts`, `changes`, `ideas`. `503` until the first sweep has finished. The shape grows with the sources; read the keys you need, ignore the rest. |
| `GET /api/changes?window=last` | What changed since the previous sweep. `window` = `last` (default), `1h`, `6h`, `24h` (merged over the archive). |
| `GET /api/source-health?sweeps=48` | The source-health matrix: `{sweeps, sources: [{source, domain, cells}]}`, cells oldest to newest. `sweeps` 1 to `SWEEP_ARCHIVE_COUNT`. |

### Alerts

| Endpoint | Returns |
|----------|---------|
| `GET /api/alerts/summary` | `{counts: {critical, high, watch, info, total, acked, snoozed}, threat: {level 1–5, drivers}, top: […], overflow, rules, lastEvaluatedAt}`. The cheapest "what is the situation" call. |
| `GET /api/alerts` | `{alerts, counts, threat, generatedAt}`. Filters: `state` (`active` default, `all`, `resolved`), `severity` (`critical`, `high`, `watch`, `info`), `rule`, `limit` 1–200. |
| `GET /api/alerts/rules` | Effective rules, the metric catalogue and the rule kinds |
| `POST /api/alerts/:id/ack`, `/snooze`, `/resolve` · `POST /api/alerts/ack-all` · `PUT`/`DELETE /api/alerts/rules/:id` | Operator actions. Same-origin only (never CORS), `Content-Type: application/json`, body ≤ 8 KB. Details in the [README](FEATURES.md#alert-engine-v210). |

Threat level: 1 = no firing alert, 2 = info, 3 = watch, 4 = high, 5 = critical.

### Events and history

| Endpoint | Returns |
|----------|---------|
| `GET /api/history` | The stored event records, newest first: `{items, total, limit, offset, stats}`. Filters: `q` (text), `kind` (`news`, `osint`, `health`, `outage`, `conflict`, `signal` or a live-source kind), `source`, `from`, `to` (ISO timestamps), `limit` 1–200 (default 50), `offset`. |
| `GET /api/events/:id` | One event record (from the current snapshot or the history) with its source, location and quality checks |
| `GET /api/export` | The same filters, up to 2,000 records, as a download. `format` = `json` (default), `csv`, `html` or `stix` (STIX 2.1 bundle of context notes). Headers `X-Export-Total`, `X-Export-Count`, `X-Export-Truncated` tell whether it was cut. |

```bash
curl 'http://localhost:3117/api/history?kind=outage&from=2026-10-01T00:00:00Z&limit=20'
curl -o crucix.csv 'http://localhost:3117/api/export?format=csv&q=hormuz'
```

### Sweep archive (replay)

| Endpoint | Returns |
|----------|---------|
| `GET /api/sweeps` | `{sweeps: [{id, timestamp, ok, total, changeCounts}], retention}`, newest first; `limit` 1 to `SWEEP_ARCHIVE_COUNT` |
| `GET /api/sweeps/:id` | One stored snapshot (`id` = `sweep-YYYYMMDDTHHMMSSZ`). Sent gzip-compressed to clients that accept it. |

### Country risk

Not available when `RISK_ENABLED=false` (404). These routes take no query parameters.

| Endpoint | Returns |
|----------|---------|
| `GET /api/countries` | Countries with a score above 0, highest first (≤ 100): `{version, at, total, countries: [{iso3, name, displayName, score, change24h, coverage, convergence}]}` (`name` is the English gazetteer name, `displayName` the name in `CRUCIX_LANG`) |
| `GET /api/countries/:iso3` | One country: score, components with weights, score series, VIEWS and INFORM inputs, last 20 records, linked countries. `iso3` = ISO 3166-1 alpha-3, upper case. |
| `GET /api/predictions` | The prediction journal: `{calibration, recent}` |
| `POST /api/briefing` | A cited briefing for `{"scope": "global"}` or an ISO3 code. Same-origin only (it can call the LLM), body ≤ 1 KB. |

### Other

| Endpoint | Returns |
|----------|---------|
| `GET /api/basemap/daily.jpg` | The daily globe basemap (NASA GIBS true colour of yesterday), JPEG |
| `GET /events` | Server-sent events: `{"type":"connected"}`, then `sweep_start`, `update` (carries the new snapshot as `data`), `sweep_error` and `alerts` (after an operator action) messages. `MAX_SSE_CLIENTS` caps the connections (503 with `Retry-After`). |

```js
const stream = new EventSource('/events');           // same origin
stream.onmessage = e => { const msg = JSON.parse(e.data); if (msg.type === 'update') refresh(); };
```

## Recipes

```bash
# Is the threat level above 3? (cron, home automation, a status badge)
curl -s localhost:3117/api/alerts/summary | jq '.threat.level'

# The ten highest country risks as a table
curl -s localhost:3117/api/countries | jq -r '.countries[:10][] | "\(.iso3)\t\(.score)\t\(.name)"'

# Every outage record of today, as CSV
curl -o outage.csv "localhost:3117/api/export?format=csv&kind=outage&from=$(date -u +%F)T00:00:00Z"

# With Basic auth, from a script
curl -u owner:secret https://crucix.example.com/api/alerts/summary
```

## Stability and limits

- `/api/data` and the stored sweeps are large and their keys follow the sources; pin to the fields you use.
- The documented routes above are the public surface. The dashboard may call other internal paths that can change.
- There is no write API for data: Crucix collects public sources itself, so there is nothing to push in.
- Source data keeps its original licence; see the credits panel in the app and the [data sources](DATA-SOURCES.md) when
  you republish what the API returns.
