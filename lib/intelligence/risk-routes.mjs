// The country-risk API (spec section 7). Installed after the application's authentication middleware and after the
// intelligence routes, before the /api JSON error handler. Read-only routes take no query parameters (400 otherwise);
// POST /api/briefing passes requireSameOriginJson like the alert routes and takes at most 1 KB. Errors are JSON:
// {error, code, field} for a bad request, 404 for an unknown country, a generic 503 for anything else (no stack).
import { requireSameOriginJson } from '../http-security.mjs';
import { briefingScope } from '../llm/briefing.mjs';
import { countryByIso3, countryDisplayName } from './countries.mjs';
import { RISK_MODEL_VERSION } from './risk.mjs';
import { viewsRowFor } from './risk-step.mjs';
import { exposureOf } from './exposure.mjs';

const ISO3 = /^[A-Z]{3}$/;
const HOUR = 3600000;
const MAX_LIST = 100;
const MAX_EVENTS = 20;
const MAX_LINKED = 8;
const MAX_PREDICTIONS = 20;
const RECENT_SERIES = 48 * HOUR;
const BODY_LIMIT = 1024;

class RiskRequestError extends Error {
  constructor(status, code, message, field = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}
const bad = (code, message, field) => new RiskRequestError(400, code, message, field);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : null;
const messageOf = error => { try { return String(error instanceof Error ? error.message : error).split('\n')[0].slice(0, 200); } catch { return 'unprintable error'; } };
// `displayName` is the server language's name for the UI; `name` stays the English gazetteer name.
const summaryRow = language => ({ iso3, name, score, change24h, coverage, convergence }) => ({ iso3, name, displayName: countryDisplayName(iso3, language) ?? name, score, change24h, coverage, convergence });

function noQuery(req) {
  if (Object.keys(req.query ?? {}).length) throw bad('INVALID_QUERY', 'Unknown query parameter', 'query');
}

// A recorded series as the last 48 hours (every point) and one point per UTC day (the day's last).
function seriesOf(points, now) {
  const recent = points.filter(point => point.at >= now - RECENT_SERIES).map(point => ({ at: iso(point.at), score: point.score }));
  const days = new Map();
  for (const point of points) days.set(new Date(point.at).toISOString().slice(0, 10), point.score);
  return { recent, daily: [...days].map(([day, score]) => ({ day, score })) };
}

function forecastOf(views, iso3, now) {
  const entry = views?.countries?.[iso3];
  if (!object(entry) || !Array.isArray(entry.months)) return null;
  const used = viewsRowFor(entry.months, now);
  return {
    run: views.run, attribution: views.attribution, license: views.license, monthUsed: used ? used.month_id : null,
    months: entry.months.filter(object).map(({ month_id: monthId, year, month, main_dich: probability, main_mean: fatalities }) => ({ monthId, year, month, probability, fatalities })),
  };
}

function baselineOf(inform, iso3) {
  const entry = inform?.countries?.[iso3];
  if (!object(entry) || !Number.isFinite(entry.score)) return null;
  return { score: entry.score, release: inform.release, published: inform.published, attribution: inform.attribution, license: inform.license };
}

// The U.S. State Department advisory of a country (context; its level is also the `advisory` score component).
function advisoryOf(advisories, iso3) {
  const entry = advisories?.countries?.[iso3];
  if (!object(entry) || !Number.isInteger(entry.level) || entry.level < 1 || entry.level > 4) return null;
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  return { level: entry.level, label: text(entry.label, 60), updated: text(entry.updated, 10) || null, url: /^https:\/\/travel\.state\.gov\//.test(entry.url) ? text(entry.url, 400) : null,
    observedAt: text(advisories.observedAt, 40) || null, attribution: text(advisories.attribution, 300), license: text(advisories.license, 120) };
}

// The adversary groups the MISP galaxy attributes to a country (context, a suspicion and not a finding): the count and at most 12 names with aliases.
function actorsOf(actors, iso3) {
  const entry = actors?.countries?.[iso3];
  if (!object(entry) || !Number.isInteger(entry.count) || !Array.isArray(entry.groups)) return null;
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const groups = entry.groups.slice(0, 12).filter(object).map(group => ({ name: text(group.name, 60), aliases: (Array.isArray(group.aliases) ? group.aliases : []).slice(0, 4).map(alias => text(alias, 40)).filter(Boolean) })).filter(group => group.name);
  return { count: entry.count, groups, release: actors.release, attribution: actors.attribution, license: actors.license };
}

/**
 * @param {import('express').Express} app
 * @param {{store: import('./entities.mjs').EntityStore, journal: import('./predictions.mjs').PredictionJournal|null,
 *          getSnapshot: () => object|null, getState: () => ({at: number, scores: object[], inputs: object}|null),
 *          history?: {getMany: (ids: string[]) => Map<string, object>}|null, briefing?: {generate: (scope: string) => Promise<object>}|null,
 *          security?: {publicUrl?: string|null, allowedHosts?: string[]}, language?: string}} options `getState` gives the last successful risk
 *          step (its full score list and the VIEWS/INFORM inputs); `security` is passed to requireSameOriginJson; `language`
 *          (the server's) sets the `displayName` of every country row.
 */
export function installRiskRoutes(app, { store, journal = null, getSnapshot = () => null, getState = () => null, history = null, briefing = null, security, language = 'en' } = {}) {
  const guard = requireSameOriginJson(security);
  const displayOf = (iso3, name) => countryDisplayName(iso3, language) ?? name;
  const handle = fn => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof RiskRequestError) return res.status(error.status).json({ error: error.message, code: error.code, field: error.field });
      console.error('[Risk] Request failed:', messageOf(error));
      if (!res.headersSent) res.status(503).json({ error: 'Country risk temporarily unavailable' });
    }
  };

  app.get('/api/countries', handle((req, res) => {
    noQuery(req);
    const state = getState();
    const scored = (state?.scores ?? []).filter(row => row.score > 0);
    res.json({ version: RISK_MODEL_VERSION, at: iso(state?.at), total: scored.length, countries: scored.slice(0, MAX_LIST).map(summaryRow(language)) });
  }));

  app.get('/api/countries/:iso3', handle((req, res) => {
    noQuery(req);
    const code = req.params.iso3;
    if (!ISO3.test(code)) throw bad('INVALID_COUNTRY', 'Invalid country code (ISO 3166-1 alpha-3, upper case)', 'iso3');
    const country = countryByIso3(code);
    if (!country) return res.status(404).json({ error: 'Country not found' });
    const state = getState();
    const now = state?.at ?? Date.now();
    const row = state?.scores?.find(item => item.iso3 === code) ?? null;
    const snapshotEvents = getSnapshot()?.events;
    const current = new Map(Array.isArray(snapshotEvents) ? snapshotEvents.filter(object).map(event => [event.id, event]) : []);
    const refs = store.countryEvents(code).slice(0, MAX_EVENTS);
    // The events the current snapshot no longer holds come from the history store in ONE lookup (one expiry pass), not one per record.
    let stored = new Map();
    const missing = refs.map(ref => ref.id).filter(key => !current.has(key));
    if (history && missing.length) { try { stored = history.getMany(missing); } catch { stored = new Map(); } }
    const titleOf = id => {
      const event = current.get(id) ?? stored.get(id);
      return typeof event?.title === 'string' ? event.title.slice(0, 300) : null;
    };
    res.json({
      iso3: country.iso3, name: country.name, displayName: displayOf(country.iso3, country.name), version: RISK_MODEL_VERSION, at: iso(state?.at),
      score: row ? row.score : null, coverage: row ? row.coverage : null, change24h: row ? row.change24h : null,
      convergence: row ? row.convergence : null,
      components: row ? Object.entries(row.components).map(([key, { value, weight }]) => ({ key, value, weight, available: value !== null })) : null,
      series: seriesOf(store.series(code), now),
      forecast: forecastOf(state?.inputs?.views, code, now),
      baseline: baselineOf(state?.inputs?.inform, code),
      advisory: advisoryOf(state?.inputs?.advisories, code),
      exposure: exposureOf(code, getSnapshot()?.liveSources),
      actors: actorsOf(state?.inputs?.actors, code),
      events: refs.map(ref => ({
        id: ref.id, title: titleOf(ref.id), kind: ref.k || null, level: ref.l, firstSeen: iso(ref.t), observedAt: iso(ref.o),
        relation: ref.m === 'l' ? 'located' : 'mentioned',
      })),
      linked: store.linked(code, MAX_LINKED, now).map(item => ({ ...item, displayName: displayOf(item.iso3, item.name) })),
    });
  }));

  app.get('/api/predictions', handle((req, res) => {
    noQuery(req);
    const recent = journal ? journal.recent(MAX_PREDICTIONS) : [];
    res.json({ calibration: journal ? journal.calibration() : null, recent: recent.map(row => { const name = countryByIso3(row.iso3)?.name ?? row.iso3; return { ...row, name, displayName: displayOf(row.iso3, name) }; }) });
  }));

  app.post('/api/briefing', guard, handle(async (req, res) => {
    noQuery(req);
    const length = Number(req.get('content-length'));
    let size = 0;
    try { size = Buffer.byteLength(JSON.stringify(req.body ?? {})); } catch { size = Infinity; }
    if ((Number.isFinite(length) && length > BODY_LIMIT) || size > BODY_LIMIT) throw new RiskRequestError(413, 'BODY_TOO_LARGE', 'The request body is larger than 1 KB');
    const body = req.body === undefined ? {} : req.body;
    if (!object(body)) throw bad('INVALID_BODY', 'The body must be a JSON object', 'body');
    if (Object.keys(body).some(key => key !== 'scope')) throw bad('INVALID_BODY', 'Only "scope" is accepted', 'body');
    const scope = body.scope === undefined ? 'global' : briefingScope(body.scope);
    if (!scope) throw bad('INVALID_SCOPE', 'scope must be "global" or a known ISO 3166-1 alpha-3 code', 'scope');
    if (!briefing) throw new Error('no briefing service');
    res.json(await briefing.generate(scope));
  }));
}
