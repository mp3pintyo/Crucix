import { createHash } from 'node:crypto';
import { LEVELS, levelRank } from './levels.mjs';
import { ruleMessage, validateRule } from './rules.mjs';
import { MAX_DEDUP_KEY, MAX_LOG, cleanText } from './store.mjs';

// Helpers of the alert engine: errors, ordering, ids, logs, input checks, and the routines that bound the baseline and
// clamp stored times (they change only the state passed in). No clock of their own, no I/O.

export const MINUTE_MS = 60 * 1000;
const SNOOZE_MIN_MINUTES = 15;
const SNOOZE_MAX_MINUTES = 7 * 24 * 60;
const MAX_REASON = 120;
const MAX_COOLDOWN_MINUTES = 1440;
const UNSAFE_REASON = new RegExp('[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]');
const OVERRIDE_FIELDS = Object.freeze(['enabled', 'notify', 'severity', 'forSweeps', 'cooldownMinutes', 'params', 'scope']);
const PATH_UNSAFE = /[^A-Za-z0-9_.[\]-]/g;

/**
 * An API-level error: `status` 400 or 404, `code` INVALID_RULE | INVALID_SNOOZE | NOT_FOUND | INVALID_STATE, `field` or null.
 * `messageKey` (a RULE_MESSAGES key, or null) and `messageValues` let the API answer in the dashboard language; `message` is English.
 */
export class AlertError extends Error {
  constructor(status, code, message, field = null, messageKey = null, messageValues = {}) {
    super(message);
    this.name = 'AlertError';
    this.status = status;
    this.code = code;
    this.field = field;
    this.messageKey = messageKey;
    this.messageValues = messageValues;
  }
}

/** A 400 INVALID_RULE for `field` with the RULE_MESSAGES text `key`. */
export const invalidRule = (field, key, values = {}) => new AlertError(400, 'INVALID_RULE', ruleMessage(key, values), field, key, values);
/** A rule error of another code (INVALID_STATE, NOT_FOUND) with the RULE_MESSAGES text `key`. */
export const ruleStateError = (status, code, key, values = {}) => new AlertError(status, code, ruleMessage(key, values), 'id', key, values);

// ─── small helpers ───────────────────────────────────────────────────────────

export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isOpen = alert => alert.state !== 'resolved';
export const countOf = (dict, key) => Object.hasOwn(dict, key) ? dict[key] : 0;
export const copy = value => structuredClone(value);
export const integerIn = (value, min, max, fallback) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;
export const ruleKeyPrefix = ruleId => `${ruleId}|`;
export const ruleOfKey = key => { const end = key.indexOf('|'); return end < 0 ? '' : key.slice(0, end); };
// What a hit is about, whichever rule saw it: the kind of rule and the part of the dedupKey after the rule id (an event
// id, a metric key, a source name, a grid cell or a delta signal key).
export const subjectOf = (rule, dedupKey) => `${rule.kind}|${dedupKey.slice(rule.id.length + 1)}`;

// The keys of a counter table grouped by the rule id in front of them.
export function indexByRule(table) {
  const index = new Map();
  for (const key of Object.keys(table)) {
    const ruleId = ruleOfKey(key);
    if (!index.has(ruleId)) index.set(ruleId, []);
    index.get(ruleId).push(key);
  }
  return index;
}

// The value of a snapshot field, or the error its getter threw; a hostile snapshot must not end the evaluation early.
export function readField(snapshot, name) {
  try { return { value: snapshot[name] }; } catch (error) { return { error }; }
}

export const messageOf = error => cleanText(error instanceof Error ? error.message : String(error), 200) || 'unknown error';

export function alertId(dedupKey, firstSeenAt, episode) {
  return `alert-${createHash('sha256').update(`${dedupKey}|${firstSeenAt}|${episode}`).digest('hex').slice(0, 32)}`;
}

export function addLog(alert, at, action, note) {
  alert.log.push(note === undefined ? { at, action } : { at, action, note });
  if (alert.log.length > MAX_LOG) alert.log.splice(0, alert.log.length - MAX_LOG);
}

// Most severe first, then the most recently seen, then the newest, then by id so the order is stable.
export const bySeverity = (a, b) => levelRank(b.severity) - levelRank(a.severity)
  || b.lastSeenAt - a.lastSeenAt || b.firstSeenAt - a.firstSeenAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const stateRank = alert => alert.state === 'firing' ? 0 : alert.state === 'resolved' ? 2 : 1;
export const byListOrder = (a, b) => stateRank(a) - stateRank(b)
  || (a.state === 'resolved' && b.state === 'resolved' ? b.resolvedAt - a.resolvedAt : 0)
  || bySeverity(a, b);

export const compactAlert = alert => ({
  id: alert.id, ruleId: alert.ruleId, ruleName: alert.ruleName, severity: alert.severity, state: alert.state,
  title: alert.title, firstSeenAt: alert.firstSeenAt, lastSeenAt: alert.lastSeenAt, count: alert.count, silent: alert.silent,
});

// A hit the engine can store: evaluators only produce these, but the engine does not depend on it.
export const usableHit = (hit, rule) => isObject(hit) && typeof hit.dedupKey === 'string' && hit.dedupKey.length <= MAX_DEDUP_KEY
  && hit.dedupKey.startsWith(ruleKeyPrefix(rule.id)) && LEVELS.includes(hit.severity);

/** The cleaned snooze reason ('' for none) after checking minutes (15 min - 7 days) and reason; throws INVALID_SNOOZE. */
export function snoozeReason(minutes, reason) {
  if (!Number.isInteger(minutes) || minutes < SNOOZE_MIN_MINUTES || minutes > SNOOZE_MAX_MINUTES) {
    throw new AlertError(400, 'INVALID_SNOOZE', `minutes must be an integer from ${SNOOZE_MIN_MINUTES} to ${SNOOZE_MAX_MINUTES}`, 'minutes');
  }
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.trim().length > MAX_REASON || UNSAFE_REASON.test(reason))) {
    throw new AlertError(400, 'INVALID_SNOOZE', `reason must be a single line of at most ${MAX_REASON} characters`, 'reason');
  }
  return typeof reason === 'string' ? reason.trim().toWellFormed() : '';
}

/**
 * The override a PUT body sets on a built-in: only the override fields (`id`, `name` and `kind` may be sent along but
 * must not differ), validated as part of the merged rule and stored as the validated values. Throws INVALID_RULE.
 */
export function overrideOf(builtin, input) {
  if (!isObject(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalidRule('rule', 'object');
  const changes = {};
  for (const key of Object.keys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    const field = key.slice(0, 40).replace(PATH_UNSAFE, '?');
    if (!('value' in descriptor)) throw invalidRule(field, 'plainData');
    if (key === 'id' || key === 'name' || key === 'kind') {
      if (descriptor.value !== builtin[key]) throw invalidRule(field, 'builtinFixed');
    } else if (OVERRIDE_FIELDS.includes(key)) {
      changes[key] = descriptor.value;
    } else {
      throw invalidRule(field, 'unknownField');
    }
  }
  const result = validateRule({ ...builtin, ...changes });
  if (!result.ok) throw invalidRule(result.error.field, result.error.key, result.error.values);
  // Store the validated, normalised values only.
  const override = {};
  for (const key of Object.keys(changes)) if (result.rule[key] !== undefined) override[key] = result.rule[key];
  return override;
}


// The baseline (subjects present at bootstrap, see the engine's #apply) forgets a subject only after
// max(3 x resolveAfterSweeps, 6) consecutive complete evaluations (no rule failed, the event list was read) in which no
// rule hit it, so a feed hiccup or a source missing for a sweep does not turn pre-existing events into notifications. A hit resets the count; an
// incomplete evaluation counts nothing. Because the baseline is keyed by subject, a rule created after the bootstrap
// also opens silently for a subject that is still in it: the event was there before (accepted by design).
export function pruneBaseline(engine, subjects, complete, resolveAfterSweeps) {
  const limit = Math.max(3 * resolveAfterSweeps, 6);
  for (const subject of Object.keys(engine.baselineMisses)) {
    if (!Object.hasOwn(engine.baseline, subject)) delete engine.baselineMisses[subject];
  }
  for (const subject of Object.keys(engine.baseline)) {
    if (subjects.has(subject)) {
      delete engine.baselineMisses[subject];
    } else if (complete) {
      const misses = countOf(engine.baselineMisses, subject) + 1;
      if (misses >= limit) {
        delete engine.baseline[subject];
        delete engine.baselineMisses[subject];
      } else {
        engine.baselineMisses[subject] = misses;
      }
    }
  }
}

// After a forward clock jump that was corrected, stored deadlines would last far too long. No cooldown can end later
// than now plus its rule's cooldown, no snooze later than now plus its own length (at most 7 days), and an open
// alert is never seen in the future. Returns true when anything changed.
export function clampTimes({ alerts, engine }, rules, now) {
  let changed = false;
  const cooldownOf = new Map(rules.map(rule => [rule.id, rule.cooldownMinutes]));
  for (const key of Object.keys(engine.cooldowns)) {
    const limit = now + (cooldownOf.get(ruleOfKey(key)) ?? MAX_COOLDOWN_MINUTES) * MINUTE_MS;
    if (engine.cooldowns[key] > limit) { engine.cooldowns[key] = limit; changed = true; }
  }
  for (const alert of alerts) {
    if (!isOpen(alert)) continue;
    if (alert.lastSeenAt > now) { alert.lastSeenAt = now; changed = true; }
    if (alert.firstSeenAt > alert.lastSeenAt) { alert.firstSeenAt = alert.lastSeenAt; changed = true; }
    if (alert.state !== 'snoozed') continue;
    const { at, until } = alert.snooze;
    const length = Math.min(Math.max(until - at, 0), SNOOZE_MAX_MINUTES * MINUTE_MS);
    const nextUntil = Math.min(at > now ? now + length : until, now + SNOOZE_MAX_MINUTES * MINUTE_MS);
    if (at > now || nextUntil !== until) {
      alert.snooze.at = Math.min(at, now);
      alert.snooze.until = nextUntil;
      changed = true;
    }
  }
  return changed;
}
