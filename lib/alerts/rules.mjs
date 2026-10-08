import { LEVELS, levelRank } from './levels.mjs';
import { METRICS, METRIC_KEYS } from './metrics.mjs';

// Alert rule schema, validation and the built-in pack. Pure data: no I/O, no clock.
// Validation is a strict whitelist. A rule that passes comes back as a fresh plain object holding
// only known fields, so nothing the caller keeps a reference to can change it afterwards.

export const RULE_KINDS = Object.freeze(['event', 'threshold', 'change', 'absence', 'convergence', 'delta']);
export const MAX_USER_RULES = 50;

const ID_PATTERN = /^[a-z0-9-]{1,40}$/;
const KIND_TOKEN = /^[a-z][a-z0-9-]{0,29}$/;
// Control characters, line/paragraph separators and bidi overrides: rule text ends up in headers, logs and the UI.
const UNSAFE_TEXT = new RegExp('[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]');
const UNSAFE_TEXT_GLOBAL = new RegExp(UNSAFE_TEXT, 'g');
const MAX_PATH_KEY = 40;
const SEVERITIES = Object.freeze([...LEVELS, 'auto']);
const OPERATORS = Object.freeze(['>', '>=', '<', '<=']);
const CELL_DEGREES = Object.freeze([1, 2, 4]);
const DELTA_SEVERITIES = Object.freeze(['high', 'critical']);

// ─── errors ──────────────────────────────────────────────────────────────────

// The English text of every rule message, by key; `message` is the template filled in. The alert API shows it in the dashboard
// language through locales/*.json alerts.errors.<key> (test/i18n-display.test.mjs keeps en.json equal to this table).
export const RULE_MESSAGES = Object.freeze({
  boolean: 'must be true or false',
  integerRange: 'must be an integer from {min} to {max}',
  finite: 'must be a finite number',
  numberRange: 'must be a number from {min} to {max}',
  oneOf: 'must be one of {list}',
  metricKey: 'must be a known metric key',
  string: 'must be a string',
  notEmpty: 'must not be empty',
  maxLength: 'must be at most {max} characters',
  controlChars: 'must not contain control characters',
  idPattern: 'must be 1-40 characters of a-z, 0-9 and -',
  list: 'must be a list',
  maxEntries: 'must have at most {max} entries',
  plainString: 'must be a plain string',
  eventKind: 'must be a lowercase event kind such as conflict or space-weather',
  object: 'must be an object',
  plainObject: 'must be a plain object',
  symbolKeys: 'must not have symbol keys',
  unknownField: 'is not a known field',
  plainData: 'must be plain data',
  required: 'is required',
  clearAtMost: 'must be at most the threshold value',
  clearAtLeast: 'must be at least the threshold value',
  maxBelowMin: 'must not be below params.minLevel',
  kindsTooFew: 'needs at least that many different entries in params.kinds',
  idMismatch: 'must match the rule id in the path',
  scopeEventOnly: 'is only allowed on event rules',
  builtinFixed: 'cannot be changed on a built-in rule',
  userRuleLimit: 'At most {max} user rules',
  builtinDelete: 'Built-in rules cannot be deleted; disable them instead',
  noSuchRule: 'No such rule',
});

/** A RULE_MESSAGES template with its {name} slots filled from `values` (an unknown slot stays as written). */
export function ruleMessage(key, values = {}) {
  return String(RULE_MESSAGES[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
}

class RuleError extends Error {
  constructor(field, key, values = {}) {
    super(ruleMessage(key, values));
    this.field = field;
    this.key = key;
    this.values = values;
  }
}
const fail = (field, key, values) => { throw new RuleError(field, key, values); };

// A key is echoed back in `field`, and for an unknown key it is attacker text: only path characters survive, the rest become "?".
const PATH_UNSAFE = /[^A-Za-z0-9_.[\]-]/g;
const shortKey = key => {
  const clean = key.slice(0, MAX_PATH_KEY).replace(PATH_UNSAFE, '?');
  return key.length > MAX_PATH_KEY ? `${clean}…` : clean;
};
const join = (path, key) => path === '' ? shortKey(key) : `${path}.${shortKey(key)}`;

// ─── value checks: each returns the clean value (or undefined to drop an optional list) ───

const boolean = (value, path) => typeof value === 'boolean' ? value : fail(path, 'boolean');

const integer = (min, max) => (value, path) => Number.isInteger(value) && value >= min && value <= max
  ? value
  : fail(path, 'integerRange', { min, max });

const number = (min, max) => (value, path) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
  ? value
  : min === -Infinity && max === Infinity ? fail(path, 'finite') : fail(path, 'numberRange', { min, max });

const oneOf = list => (value, path) => list.includes(value)
  ? value
  : fail(path, 'oneOf', { list: list.join(', ') });

const metricKey = (value, path) => typeof value === 'string' && METRIC_KEYS.includes(value) ? value : fail(path, 'metricKey');

function text(value, path, max, { trim = true } = {}) {
  if (typeof value !== 'string') fail(path, 'string');
  const clean = trim ? value.trim() : value;
  if (clean.trim() === '') fail(path, 'notEmpty');
  if (clean.length > max) fail(path, 'maxLength', { max });
  if (UNSAFE_TEXT.test(clean)) fail(path, 'controlChars');
  return clean;
}

const label = max => (value, path) => text(value, path, max);

const id = (value, path) => typeof value === 'string' && ID_PATTERN.test(value)
  ? value
  : fail(path, 'idPattern');

/** A list of unique strings; an empty list means "no filter" and is dropped. */
function list(maxItems, checkItem) {
  return (value, path) => {
    if (!Array.isArray(value)) fail(path, 'list');
    // Length first: a hostile 10 000-entry array is never walked.
    if (value.length > maxItems) fail(path, 'maxEntries', { max: maxItems });
    const clean = [];
    for (let index = 0; index < value.length; index += 1) {
      const itemPath = `${path}[${index}]`;
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !('value' in descriptor)) fail(itemPath, 'plainString');
      const item = checkItem(descriptor.value, itemPath);
      if (!clean.includes(item)) clean.push(item);
    }
    return clean.length > 0 ? clean : undefined;
  };
}

const kindToken = (value, path) => typeof value === 'string' && KIND_TOKEN.test(value)
  ? value
  : fail(path, 'eventKind');
const sourceName = (value, path) => text(value, path, 40);
const keyword = (value, path) => text(value, path, 40, { trim: false });

// ─── object reading ──────────────────────────────────────────────────────────

// An own property or undefined: a polluted Object.prototype must never supply a field of a rule or a stored record.
const own = (source, key) => source !== null && typeof source === 'object' && Object.hasOwn(source, key) ? source[key] : undefined;

function plainObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'plainObject');
  if (Object.getOwnPropertySymbols(value).length > 0) fail(path, 'symbolKeys');
  return value;
}

// Own enumerable string keys only, none of them outside the whitelist (which is what rejects __proto__, constructor and
// prototype); accessors are never invoked.
function checkKeys(source, path, allowed) {
  for (const key of Object.keys(source)) {
    const keyPath = join(path, key);
    if (!allowed.includes(key)) fail(keyPath, 'unknownField');
    if (!('value' in Object.getOwnPropertyDescriptor(source, key))) fail(keyPath, 'plainData');
  }
}

// A field definition is {check, default?, optional?}; a missing field takes its default,
// is skipped when optional, and is an error otherwise. `undefined` counts as missing.
function readFields(source, path, defs) {
  const clean = {};
  for (const [name, def] of Object.entries(defs)) {
    const fieldPath = join(path, name);
    const value = Object.hasOwn(source, name) ? source[name] : undefined;
    if (value === undefined) {
      if ('default' in def) clean[name] = def.default;
      else if (!def.optional) fail(fieldPath, 'required');
      continue;
    }
    const checked = def.check(value, fieldPath);
    if (checked !== undefined) clean[name] = checked;
  }
  return clean;
}

function readObject(value, path, defs) {
  const source = plainObject(value, path);
  checkKeys(source, path, Object.keys(defs));
  return readFields(source, path, defs);
}

// ─── the schema ──────────────────────────────────────────────────────────────

const nested = defs => (value, path) => readObject(value, path, defs);

const RADIUS = {
  lat: { check: number(-90, 90) },
  lon: { check: number(-180, 180) },
  km: { check: number(1, 3000) },
};

const SCOPE = {
  kinds: { check: list(20, kindToken), optional: true },
  sources: { check: list(20, sourceName), optional: true },
  keywords: { check: list(10, keyword), optional: true },
  radius: { check: nested(RADIUS), optional: true },
};

const THRESHOLD_CROSS = params => {
  if (params.clearValue === undefined) return;
  // The value that clears an alert must be on the quiet side of the threshold, or it could never clear.
  const rising = params.op === '>' || params.op === '>=';
  if (rising ? params.clearValue > params.value : params.clearValue < params.value) {
    fail('params.clearValue', rising ? 'clearAtMost' : 'clearAtLeast');
  }
};

const EVENT_CROSS = params => {
  if (params.maxLevel !== undefined && levelRank(params.maxLevel) < levelRank(params.minLevel)) {
    fail('params.maxLevel', 'maxBelowMin');
  }
};

const CONVERGENCE_CROSS = params => {
  if (params.kinds !== undefined && params.kinds.length < params.minKinds) {
    fail('params.minKinds', 'kindsTooFew');
  }
};

// Per-kind parameters. Defaults only where the spec gives one (convergence); every other parameter is required.
const KIND_SCHEMA = {
  event: {
    // maxLevel only narrows: absent means "no upper bound" and is not stored.
    params: { minLevel: { check: oneOf(LEVELS) }, maxLevel: { check: oneOf(LEVELS), optional: true } },
    cross: EVENT_CROSS,
  },
  threshold: {
    forSweeps: 2,
    params: {
      metric: { check: metricKey },
      op: { check: oneOf(OPERATORS) },
      value: { check: number(-Infinity, Infinity) },
      clearValue: { check: number(-Infinity, Infinity), optional: true },
    },
    cross: THRESHOLD_CROSS,
  },
  change: {
    params: {
      metric: { check: metricKey },
      pct: { check: number(0.1, 100) },
    },
  },
  absence: {
    params: {
      source: { check: sourceName },
      minFailSweeps: { check: integer(1, 50) },
      maxAgeMinutes: { check: integer(1, 43200), optional: true },
    },
  },
  convergence: {
    params: {
      cellDegrees: { check: oneOf(CELL_DEGREES), default: 2 },
      windowHours: { check: integer(6, 72), default: 24 },
      minKinds: { check: integer(2, 6), default: 3 },
      minLevel: { check: oneOf(LEVELS), default: 'watch' },
      kinds: { check: list(20, kindToken), optional: true },
    },
    cross: CONVERGENCE_CROSS,
  },
  delta: {
    params: { minSeverity: { check: oneOf(DELTA_SEVERITIES) } },
  },
};

const TOP_LEVEL = ['id', 'name', 'kind', 'enabled', 'severity', 'notify', 'forSweeps', 'cooldownMinutes', 'scope', 'params'];

function buildRule(input, expectedId) {
  const raw = plainObject(input, 'rule');
  checkKeys(raw, '', TOP_LEVEL);

  const rawId = own(raw, 'id');
  const rawScope = own(raw, 'scope');
  const rawParams = own(raw, 'params');

  if (expectedId !== undefined && rawId !== undefined && rawId !== expectedId) fail('id', 'idMismatch');
  const head = readFields({ ...raw, id: rawId === undefined ? expectedId : rawId }, '', {
    id: { check: id },
    name: { check: label(80) },
    kind: { check: oneOf(RULE_KINDS) },
  });
  const schema = KIND_SCHEMA[head.kind];

  const tail = readFields(raw, '', {
    enabled: { check: boolean, default: true },
    severity: { check: oneOf(head.kind === 'event' ? SEVERITIES : LEVELS), default: 'high' },
    notify: { check: boolean, default: false },
    forSweeps: { check: integer(1, 10), default: schema.forSweeps ?? 1 },
    cooldownMinutes: { check: integer(0, 1440), default: 30 },
  });

  let scope;
  if (head.kind === 'event') scope = rawScope === undefined ? {} : readObject(rawScope, 'scope', SCOPE);
  else if (rawScope !== undefined) fail('scope', 'scopeEventOnly');

  const needsParams = Object.values(schema.params).some(def => !('default' in def) && !def.optional);
  if (rawParams === undefined && needsParams) fail('params', 'required');
  const params = readObject(rawParams === undefined ? {} : rawParams, 'params', schema.params);
  schema.cross?.(params);

  return {
    id: head.id,
    name: head.name,
    kind: head.kind,
    enabled: tail.enabled,
    severity: tail.severity,
    notify: tail.notify,
    forSweeps: tail.forSweeps,
    cooldownMinutes: tail.cooldownMinutes,
    ...(scope === undefined ? {} : { scope }),
    params,
  };
}

/**
 * Validate and normalise a rule. `opts.id` is the id from the request path: it fills in a missing id and must match a given one.
 * Returns {ok: true, rule} with defaults applied, or {ok: false, error: {code: 'INVALID_RULE', field, message, key, values}} for the
 * first failing field (a dotted path such as `params.value` or `scope.keywords[3]`; `rule` for a non-object input). `message` is
 * English; `key` (a RULE_MESSAGES key) and `values` let the API show it in the dashboard language.
 */
export function validateRule(input, opts) {
  try {
    const expectedId = own(opts, 'id');
    return { ok: true, rule: buildRule(input, typeof expectedId === 'string' ? expectedId : undefined) };
  } catch (error) {
    if (!(error instanceof RuleError)) throw error;
    return { ok: false, error: { code: 'INVALID_RULE', field: error.field, message: error.message, key: error.key, values: error.values } };
  }
}

// ─── the built-in pack ───────────────────────────────────────────────────────

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function builtin(input) {
  const result = validateRule(input);
  if (!result.ok) throw new Error(`Invalid built-in alert rule "${input.id}": ${result.error.field} ${result.error.message}`);
  return deepFreeze(result.rule);
}

/** The rules every installation starts with. A user can override or disable them by id. */
export const DEFAULT_RULES = Object.freeze([
  { id: 'events-critical', name: 'Critical events', kind: 'event', severity: 'auto', notify: true, params: { minLevel: 'critical' } },
  // Capped at high: a critical event already raises an alert through events-critical, not a second one here.
  { id: 'events-high', name: 'High-severity events', kind: 'event', severity: 'auto', notify: true, forSweeps: 1, params: { minLevel: 'high', maxLevel: 'high' } },
  { id: 'convergence-default', name: 'Event convergence', kind: 'convergence', severity: 'high', notify: true, params: { cellDegrees: 2, windowHours: 24, minKinds: 3, minLevel: 'watch' } },
  { id: 'source-stale', name: 'Source gone quiet', kind: 'absence', severity: 'watch', notify: false, params: { source: 'any', minFailSweeps: 3 } },
  { id: 'vix-spike', name: 'VIX spike', kind: 'threshold', severity: 'high', notify: true, params: { metric: 'vix', op: '>', value: 30 } },
  { id: 'hy-spread-wide', name: 'High-yield spread wide', kind: 'threshold', severity: 'watch', params: { metric: 'hy_spread', op: '>', value: 5 } },
  // Telegram/Discord already announce delta signals, so this one only shows up in the dashboard.
  { id: 'delta-critical', name: 'Critical delta signals', kind: 'delta', severity: 'critical', notify: false, params: { minSeverity: 'critical' } },
  { id: 'hungary-region', name: 'Hungary region', kind: 'event', severity: 'auto', notify: false, scope: { radius: { lat: 47.5, lon: 19, km: 500 } }, params: { minLevel: 'watch' } },
].map(builtin));

// ─── merging built-ins with the stored user state ────────────────────────────

const OVERRIDE_FIELDS = Object.freeze(['enabled', 'notify', 'severity', 'forSweeps', 'cooldownMinutes', 'params', 'scope']);

// The built-in with the whitelisted override fields replaced wholesale (params and scope are not merged field by field,
// so an optional parameter can be removed again). null when nothing applies or the result would be invalid.
function applyOverride(rule, override) {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) return null;
  const changes = {};
  for (const field of OVERRIDE_FIELDS) {
    if (Object.hasOwn(override, field) && override[field] !== undefined) changes[field] = override[field];
  }
  if (Object.keys(changes).length === 0) return null;
  const result = validateRule({ ...rule, ...changes });
  return result.ok ? result.rule : null;
}

/**
 * The effective rules: every built-in (marked `override` when a stored override applies), then the valid user rules.
 * Corrupt or hostile stored records are skipped instead of throwing: the first record per id wins, a user rule cannot
 * take a built-in's id, its own id must match the record's, and at most MAX_USER_RULES user rules are kept.
 * Results are fresh, mutable copies; the built-ins are never aliased.
 */
export function mergeRules(builtins, userRecords) {
  const base = Array.isArray(builtins) ? builtins : [];
  const records = Array.isArray(userRecords) ? userRecords : [];
  const builtinIds = new Set(base.map(rule => rule.id));
  const overrides = new Map();
  const users = [];
  const seen = new Set();

  for (const record of records) {
    const recordId = own(record, 'id');
    if (typeof recordId !== 'string' || seen.has(recordId)) continue;
    seen.add(recordId);
    if (builtinIds.has(recordId)) {
      overrides.set(recordId, own(record, 'override'));
    } else if (own(record, 'rule') !== undefined && users.length < MAX_USER_RULES) {
      const result = validateRule(own(record, 'rule'), { id: recordId });
      if (result.ok) users.push({ ...result.rule, source: 'user' });
    }
  }

  const effective = base.map(rule => {
    const overridden = applyOverride(rule, overrides.get(rule.id));
    return overridden ? { ...overridden, source: 'override' } : { ...structuredClone(rule), source: 'builtin' };
  });
  return [...effective, ...users];
}

// ─── describeRule ────────────────────────────────────────────────────────────

const METRIC_LABELS = new Map(METRICS.map(metric => [metric.key, metric.label]));

// A short, single-line rendering of a field of a possibly unvalidated rule.
function shown(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return '?';
  return value.replace(UNSAFE_TEXT_GLOBAL, ' ').slice(0, 80);
}
const shownList = values => Array.isArray(values) ? values.slice(0, 20).map(shown).join(', ') : '?';
const plural = (count, word) => `${shown(count)} ${word}${count === 1 ? '' : 's'}`;
const metricLabel = key => METRIC_LABELS.get(key) ?? shown(key);

function describeEvent(rule) {
  const scope = rule.scope !== null && typeof rule.scope === 'object' ? rule.scope : {};
  const parts = [];
  if (scope.kinds !== undefined) parts.push(`kinds ${shownList(scope.kinds)}`);
  if (scope.sources !== undefined) parts.push(`sources ${shownList(scope.sources)}`);
  if (scope.keywords !== undefined) parts.push(`keywords ${shownList(scope.keywords)}`);
  if (scope.radius !== null && typeof scope.radius === 'object') parts.push(`within ${shown(scope.radius.km)} km of ${shown(scope.radius.lat)}, ${shown(scope.radius.lon)}`);
  const { minLevel, maxLevel } = rule.params;
  // 'critical' is the top level, so a critical cap is no cap.
  const levels = maxLevel === undefined || maxLevel === 'critical' ? `at ${shown(minLevel)} or above`
    : maxLevel === minLevel ? `at exactly ${shown(minLevel)}`
      : `from ${shown(minLevel)} up to ${shown(maxLevel)}`;
  return [`Events ${levels}`, ...parts].join(', ');
}

const DESCRIBE = {
  event: describeEvent,
  threshold: ({ params }) => `${metricLabel(params.metric)} ${shown(params.op)} ${shown(params.value)}${params.clearValue === undefined ? '' : ` (clears at ${shown(params.clearValue)})`}`,
  change: ({ params }) => `${metricLabel(params.metric)} moves by ${shown(params.pct)}% or more between sweeps`,
  absence: ({ params }) => `${params.source === 'any' ? 'Any source' : shown(params.source)} failing or stale for ${plural(params.minFailSweeps, 'sweep')}${params.maxAgeMinutes === undefined ? '' : `, or older than ${shown(params.maxAgeMinutes)} min`}`,
  convergence: ({ params }) => `${shown(params.minKinds)}+ event kinds${params.kinds === undefined ? '' : ` (${shownList(params.kinds)})`} within one ${shown(params.cellDegrees)}° cell in ${shown(params.windowHours)} h at ${shown(params.minLevel)} or above`,
  delta: ({ params }) => `Delta signals at ${shown(params.minSeverity)} or above`,
};

/** A short single-line English summary of a rule, used where no localized label exists. Never throws; '' for non-rules. */
export function describeRule(rule) {
  if (rule === null || typeof rule !== 'object' || !Object.hasOwn(DESCRIBE, rule.kind)) return '';
  const withParams = rule.params !== null && typeof rule.params === 'object' ? rule : { ...rule, params: {} };
  try { return DESCRIBE[rule.kind](withParams); } catch { return ''; }
}
