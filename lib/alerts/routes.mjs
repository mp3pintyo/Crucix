import { requireSameOriginJson } from '../http-security.mjs';
import { getLocaleForLanguage } from '../i18n.mjs';
import { LEVELS } from './levels.mjs';
import { AlertError, invalidRule, isObject, messageOf } from './lifecycle.mjs';
import { RULE_KINDS } from './rules.mjs';
import { cleanText } from './store.mjs';

// The alert API. Installed after the application's authentication middleware; every state-changing route also passes
// requireSameOriginJson. Errors are JSON: an AlertError keeps its status as {error, code, field}, anything else is
// logged (message only) and answered 503 without details.

const ALERT_ID = /^alert-[0-9a-f]{32}$/;
const RULE_ID = /^[a-z0-9-]{1,40}$/;
const LIMIT = /^[0-9]{1,3}$/;
const MAX_LIMIT = 200;
const LIST_STATES = Object.freeze(['active', 'all', 'resolved']);
const FIELD_UNSAFE = /[^A-Za-z0-9_.[\]-]/g;

const badRequest = (code, message, field) => new AlertError(400, code, message, field);
// A field path can carry a key the client sent; only its safe characters are echoed.
const fieldOf = field => typeof field === 'string' ? field.slice(0, 120).replace(FIELD_UNSAFE, '?') : null;

/**
 * The message of an AlertError in `language`: a rule message (it has a messageKey) through locales/*.json alerts.errors, its
 * {name} slots filled from messageValues; English, a missing key or any other error keep the English message.
 */
export function alertErrorMessage(error, language = 'en') {
  const key = error?.messageKey;
  if (typeof key !== 'string' || /^en(?:-|$)/i.test(String(language))) return error?.message;
  const errors = getLocaleForLanguage(language).alerts?.errors;
  const template = errors !== null && typeof errors === 'object' && Object.hasOwn(errors, key) ? errors[key] : undefined;
  if (typeof template !== 'string' || template === '') return error.message;
  const values = isObject(error.messageValues) ? error.messageValues : {};
  return template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
}

// The query, which may hold only `allowed` keys, each once.
function queryOf(req, allowed) {
  const query = req.query ?? {};
  for (const key of Object.keys(query)) {
    if (!allowed.includes(key)) throw badRequest('INVALID_QUERY', 'Unknown query parameter', 'query');
    if (typeof query[key] !== 'string') throw badRequest('INVALID_QUERY', 'A query parameter may appear only once', key);
  }
  return query;
}

// GET /api/alerts filters: state, severity, rule and limit (1-200); an empty value is no filter.
function listOptions(req) {
  const query = queryOf(req, ['state', 'severity', 'rule', 'limit']);
  const options = {};
  const take = (key, valid) => {
    if (!Object.hasOwn(query, key) || query[key] === '') return;
    if (!valid(query[key])) throw badRequest('INVALID_QUERY', `Invalid ${key}`, key);
    options[key] = query[key];
  };
  take('state', value => LIST_STATES.includes(value));
  take('severity', value => LEVELS.includes(value));
  take('rule', value => RULE_ID.test(value));
  take('limit', value => LIMIT.test(value) && Number(value) >= 1 && Number(value) <= MAX_LIMIT);
  if (options.limit !== undefined) options.limit = Number(options.limit);
  return options;
}

// The JSON body as an object with only `allowed` keys; no body is an empty one.
function bodyOf(req, allowed) {
  const body = req.body === undefined ? {} : req.body;
  if (!isObject(body)) throw badRequest('INVALID_BODY', 'The body must be a JSON object', 'body');
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw badRequest('INVALID_BODY', 'is not a known field', key);
  return body;
}

// A rule as the client sent it, minus the `source` that GET adds to every rule; the id comes from the path.
function ruleBody(req) {
  if (req.body === undefined) return {};
  if (!isObject(req.body)) return req.body;
  const rule = { ...req.body };
  delete rule.source;
  return rule;
}

function alertIdOf(req) {
  if (!ALERT_ID.test(req.params.id)) throw badRequest('INVALID_ID', 'Invalid alert ID', 'id');
  return req.params.id;
}

function ruleIdOf(req) {
  if (!RULE_ID.test(req.params.id)) throw invalidRule('id', 'idPattern');
  return req.params.id;
}

/**
 * @param {import('express').Express} app
 * @param {{engine: import('./engine.mjs').AlertEngine, getSnapshot: () => object|null,
 *          onChange?: (summary: object, newIds: string[]) => void,
 *          security?: {publicUrl?: string|null, allowedHosts?: string[]}, language?: string}} options `onChange` runs after every
 *          change made through the API (operator actions open no alerts, so `newIds` is empty); its failure is only logged.
 *          `security` is passed to requireSameOriginJson (ALERT_PUBLIC_URL, ALERT_ALLOWED_HOSTS). `language` (the server's) is
 *          the language of the rule messages in `error`; `code` and `field` stay the same in every language.
 */
export function installAlertRoutes(app, { engine, getSnapshot, onChange, security, language = 'en' }) {
  const guard = requireSameOriginJson(security);
  const handle = fn => (req, res) => {
    try {
      fn(req, res);
    } catch (error) {
      if (error instanceof AlertError) {
        return res.status(error.status).json({ error: cleanText(alertErrorMessage(error, language), 200) || 'Invalid request', code: error.code, field: fieldOf(error.field) });
      }
      console.error('[Alerts] Request failed:', messageOf(error));
      res.status(503).json({ error: 'Alerts temporarily unavailable' });
    }
  };
  // A change: the response carries its result and the summary after it, which onChange gets too.
  const change = fn => handle((req, res) => {
    queryOf(req, []);
    const result = fn(req);
    const summary = engine.summary();
    res.json({ ...result, summary });
    try {
      onChange?.(summary, []);
    } catch (error) {
      console.error('[Alerts] Change listener failed:', messageOf(error));
    }
  });

  app.get('/api/alerts', handle((req, res) => {
    const options = listOptions(req);
    const { counts, threat, generatedAt } = engine.summary();
    res.json({ alerts: engine.list(options), counts, threat, generatedAt });
  }));
  app.get('/api/alerts/summary', handle((req, res) => {
    queryOf(req, []);
    res.json(engine.summary());
  }));
  app.get('/api/alerts/rules', handle((req, res) => {
    queryOf(req, []);
    res.json({ rules: engine.rules(), metrics: engine.metricsCatalog(getSnapshot?.() ?? null), kinds: [...RULE_KINDS] });
  }));

  app.post('/api/alerts/ack-all', guard, change(req => {
    const { severity } = bodyOf(req, ['severity']);
    return { alerts: engine.ackAll(severity === undefined ? {} : { severity }) };
  }));
  app.post('/api/alerts/:id/ack', guard, change(req => {
    const id = alertIdOf(req);
    bodyOf(req, []);
    return { alert: engine.ack(id) };
  }));
  app.post('/api/alerts/:id/snooze', guard, change(req => {
    const id = alertIdOf(req);
    const { minutes, reason } = bodyOf(req, ['minutes', 'reason']);
    return { alert: engine.snooze(id, minutes, reason) };
  }));
  app.post('/api/alerts/:id/resolve', guard, change(req => {
    const id = alertIdOf(req);
    bodyOf(req, []);
    return { alert: engine.resolve(id) };
  }));

  app.put('/api/alerts/rules/:id', guard, change(req => ({ rule: engine.putRule(ruleIdOf(req), ruleBody(req)) })));
  app.delete('/api/alerts/rules/:id', guard, change(req => {
    const id = ruleIdOf(req);
    engine.deleteRule(id);
    return { deleted: id };
  }));

  // Express's own failures on these paths (a path parameter that is not valid percent-encoding, for one) are JSON too:
  // no HTML page, no stack in the answer or the log.
  app.use('/api/alerts', (error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : null;
    console.error(`[Alerts] Request refused: HTTP ${status ?? 503} (${error instanceof Error ? error.name : 'Error'})`);
    if (status === null) return res.status(503).json({ error: 'Alerts temporarily unavailable' });
    res.status(status).json({ error: 'Invalid request', code: 'INVALID_REQUEST', field: null });
  });
}
