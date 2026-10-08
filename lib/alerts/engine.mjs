import { evaluateRule } from './evaluators.mjs';
import { LEVELS, levelRank, threatOf } from './levels.mjs';
import { METRICS, metricValues } from './metrics.mjs';
import { DEFAULT_RULES, MAX_USER_RULES, mergeRules, validateRule } from './rules.mjs';
import {
  AlertError, MINUTE_MS, addLog, alertId, byListOrder, bySeverity, clampTimes, compactAlert, copy, countOf, indexByRule, integerIn,
  invalidRule, isObject, isOpen, messageOf, overrideOf, pruneBaseline, readField, ruleKeyPrefix, ruleOfKey, ruleStateError, snoozeReason, subjectOf, usableHit,
} from './lifecycle.mjs';
import { AlertStore, MAX_EVIDENCE, MAX_SUMMARY, MAX_TITLE, cleanText, dictionary } from './store.mjs';

export { AlertError };

// The alert lifecycle. Every sweep the effective rules are evaluated against the snapshot; hits open, refresh, escalate
// and (by their absence) resolve alerts. All mutable state lives in `store.state`, so a restart continues where the last
// sweep stopped. Time comes only from the injected clock. Nothing here throws into the sweep: a failing rule is logged
// and skipped, a failing save is logged by the store.

const TOP = 5;
const MAX_OVERFLOW_ROWS = 10;
const MAX_CHANNELS = 8;
const RULE_ID = /^[a-z0-9-]{1,40}$/;
const CHANNEL = /^[a-z0-9-]{1,20}$/;
const LIST_STATES = Object.freeze(['active', 'all', 'resolved']);
const BUILTINS = new Map(DEFAULT_RULES.map(rule => [rule.id, rule]));

export class AlertEngine {
  #store;
  #now;
  #logger;
  #config;
  #loaded = false;
  #rules = null;

  /**
   * @param {string} runsDir the runs directory; state lives in `<runsDir>/alerts/`.
   * @param {{now?: () => number, logger?: object,
   *          config?: {maxActivePerRule?: number, resolveAfterSweeps?: number, retentionDays?: number, maxAlerts?: number}}} [options]
   */
  constructor(runsDir, { now = Date.now, config, logger = console } = {}) {
    const settings = isObject(config) ? config : {};
    this.#now = now;
    this.#logger = logger;
    this.#config = {
      maxActivePerRule: integerIn(settings.maxActivePerRule, 1, 1000, 50),
      resolveAfterSweeps: integerIn(settings.resolveAfterSweeps, 1, 50, 2),
      maxAlerts: integerIn(settings.maxAlerts, 1, 100000, 1000),
    };
    this.#store = new AlertStore(runsDir, {
      now: () => this.#now(),
      maxAlerts: this.#config.maxAlerts,
      retentionDays: integerIn(settings.retentionDays, 1, 3650, 30),
      logger,
    });
  }

  #warn(message) {
    try { (this.#logger?.warn ?? this.#logger?.log)?.call(this.#logger, `[Alerts] ${message}`); } catch { /* never breaks the engine */ }
  }

  get #state() {
    if (!this.#loaded) this.load();
    return this.#store.state;
  }

  /** Load the stored alerts and rules. Returns the load status of both files; never throws. */
  load() {
    const status = this.#store.load();
    this.#loaded = true;
    this.#rules = null;
    return status;
  }

  // The effective rules (built-ins, overrides, user rules), rebuilt only when the stored records change.
  #effectiveRules() {
    const state = this.#state;
    this.#rules ??= mergeRules(DEFAULT_RULES, state.userRules);
    return this.#rules;
  }

  #rule(id) {
    return this.#effectiveRules().find(rule => rule.id === id);
  }

  // ─── evaluation ────────────────────────────────────────────────────────────

  /**
   * Evaluate every enabled rule against `snapshot` (the delta result can be passed as `options.delta`). A value that is
   * not an object snapshot is never evaluated: the current summary comes back with empty lists. The returned alerts are
   * copies; `silent` is true on the bootstrap evaluation (nothing stored yet), whose alerts must not notify. The
   * bootstrap lasts until an evaluation could read `snapshot.events` as a list.
   */
  evaluate(snapshot, options) {
    const state = this.#state;
    if (!isObject(snapshot)) return { summary: this.summary(), created: [], escalated: [], resolved: [], silent: false };
    const now = this.#now();
    clampTimes(state, this.#effectiveRules(), now);
    const { engine } = state;
    const bootstrap = !engine.initialized;
    const delta = isObject(options) && Object.hasOwn(options, 'delta') ? options.delta : undefined;
    // A view with the delta attached; the caller's snapshot is not modified and its getters are not run here.
    const view = delta === undefined ? snapshot : Object.create(snapshot, { delta: { value: delta, enumerable: true } });
    const events = readField(view, 'events');
    const health = readField(view, 'health');
    const metrics = metricValues(view);
    this.#updateFailStreaks(health);

    const open = new Map();
    for (const alert of state.alerts) if (isOpen(alert)) open.set(alert.dedupKey, alert);
    const ctx = {
      snapshot: view,
      get events() { if ('error' in events) throw events.error; return events.value; },
      get health() { if ('error' in health) throw health.error; return health.value; },
      metrics,
      previousMetrics: engine.metrics,
      failStreak: name => typeof name === 'string' ? countOf(engine.failStreaks, name) : 0,
      isActive: dedupKey => open.has(dedupKey),
      now,
    };

    const batch = { created: [], escalated: [], resolved: [] };
    // Built once, so each rule visits only its own pending keys.
    const pending = indexByRule(engine.pending);
    const overflow = dictionary();
    // Every subject some rule hit in this evaluation; a baseline subject no rule hits any more stops being one.
    const subjects = new Set();
    let complete = true;
    const enabled = new Map(this.#effectiveRules().filter(rule => rule.enabled).map(rule => [rule.id, rule]));
    for (const alert of open.values()) {
      if (enabled.has(alert.ruleId)) continue;
      this.#close(alert, now, this.#rule(alert.ruleId) ? 'rule disabled' : 'rule removed', 0);
      open.delete(alert.dedupKey);
      batch.resolved.push(alert);
    }
    for (const rule of enabled.values()) {
      let hits;
      try {
        hits = evaluateRule(rule, ctx);
      } catch (error) {
        // Its alerts and counters stay as they were: a rule that could not look is not a rule that saw nothing.
        this.#warn(`rule ${rule.id} failed: ${messageOf(error)}`);
        if (Object.hasOwn(engine.overflow, rule.id)) overflow[rule.id] = countOf(overflow, rule.id) + engine.overflow[rule.id];
        complete = false;
        continue;
      }
      this.#apply(rule, Array.isArray(hits) ? hits : [], { now, bootstrap, open, batch, pending, overflow, subjects });
    }
    this.#expireSnoozes(now, batch.resolved);
    this.#tidyCounters(enabled, now);
    const eventsRead = 'value' in events && Array.isArray(events.value);
    pruneBaseline(engine, subjects, complete && eventsRead, this.#config.resolveAfterSweeps);

    // A snapshot without a readable event list cannot be the baseline: the bootstrap goes on.
    if (eventsRead) engine.initialized = true;
    engine.overflow = overflow;
    engine.lastEvaluatedAt = now;
    engine.metrics = metrics;
    this.#store.save();
    return {
      summary: this.summary(),
      created: batch.created.map(copy),
      escalated: batch.escalated.map(copy),
      resolved: batch.resolved.map(copy),
      silent: bootstrap,
    };
  }

  // Consecutive err/stale sweeps per source. A source that recovered, is disabled or is gone loses its streak; when
  // the health block cannot be read the streaks are kept as they were.
  #updateFailStreaks(health) {
    if (!('value' in health) || !Array.isArray(health.value)) return;
    const { engine } = this.#store.state;
    try {
      const next = dictionary();
      for (const row of health.value) {
        if (!isObject(row) || typeof row.n !== 'string' || row.n === '' || row.n.length > 200) continue;
        if (row.disabled || !(row.err || row.stale)) continue;
        next[row.n] = Math.min(countOf(engine.failStreaks, row.n) + 1, 1e6);
      }
      engine.failStreaks = next;
    } catch (error) {
      this.#warn(`source health unreadable: ${messageOf(error)}`);
    }
  }

  #apply(rule, hits, { now, bootstrap, open, batch, pending, overflow, subjects }) {
    const { engine } = this.#store.state;
    const { maxActivePerRule, maxAlerts } = this.#config;
    const seen = new Set();
    const fresh = [];
    for (const hit of hits) {
      if (!usableHit(hit, rule) || seen.has(hit.dedupKey)) continue;
      seen.add(hit.dedupKey);
      subjects.add(subjectOf(rule, hit.dedupKey));
      const alert = open.get(hit.dedupKey);
      if (alert === undefined) fresh.push(hit);
      else this.#refresh(alert, hit, rule, now, batch);
    }

    // Open alerts this rule did not hit: resolve after resolveAfterSweeps consecutive misses.
    let active = 0;
    for (const alert of open.values()) {
      if (alert.ruleId !== rule.id) continue;
      if (seen.has(alert.dedupKey)) { active += 1; continue; }
      const misses = countOf(engine.misses, alert.dedupKey) + 1;
      if (misses < this.#config.resolveAfterSweeps) {
        engine.misses[alert.dedupKey] = misses;
        active += 1;
        continue;
      }
      this.#close(alert, now, 'condition cleared', rule.cooldownMinutes);
      open.delete(alert.dedupKey);
      batch.resolved.push(alert);
    }

    // A pending streak needs consecutive sweeps: a key this rule did not hit now starts again from zero.
    for (const key of pending.get(rule.id) ?? []) if (!seen.has(key)) delete engine.pending[key];

    // A hit in its cooldown cannot open: it takes no rank and builds no streak (#close cleared it; after the cooldown it
    // starts from zero), so it never crowds out hits that can open.
    const openable = [];
    for (const hit of fresh) {
      if (countOf(engine.cooldowns, hit.dedupKey) > now) {
        if (bootstrap) engine.baseline[subjectOf(rule, hit.dedupKey)] = now;
      } else {
        openable.push(hit);
      }
    }

    // The hits that can open: the most severe first, then the longest streak (a streak that has started keeps its place
    // whatever the order of the feed), then the evaluator's order. Only the first maxActivePerRule are tracked, so
    // pending holds at most rules x maxActivePerRule keys and those streaks keep advancing; the rest are held back.
    const ranked = openable
      .map((hit, order) => ({ hit, order, streak: countOf(engine.pending, hit.dedupKey) }))
      .sort((a, b) => levelRank(b.hit.severity) - levelRank(a.hit.severity) || b.streak - a.streak || a.order - b.order);
    let held = 0;
    for (let rank = 0; rank < ranked.length; rank += 1) {
      const { hit, streak } = ranked[rank];
      const key = hit.dedupKey;
      const subject = subjectOf(rule, key);
      let full = rank >= maxActivePerRule;
      if (full) {
        delete engine.pending[key];
      } else {
        engine.pending[key] = Math.min(streak + 1, rule.forSweeps);
        if (engine.pending[key] < rule.forSweeps) {
          if (bootstrap) engine.baseline[subject] = now;
          continue;
        }
        if (active >= maxActivePerRule) full = true;
        else if (open.size >= maxAlerts) {
          // The global ceiling: a more severe hit takes the place of the least severe open alert.
          const displaced = this.#displace(hit.severity, now, open, batch, overflow, bootstrap);
          if (displaced === null) full = true;
          else if (displaced.ruleId === rule.id) active -= 1;
        }
      }
      if (full) {
        // Present at bootstrap: whenever it opens, it is part of the baseline and stays silent.
        if (bootstrap) engine.baseline[subject] = now;
        held += 1;
        continue;
      }
      const alert = this.#open(rule, hit, now, bootstrap || Object.hasOwn(engine.baseline, subject));
      open.set(key, alert);
      active += 1;
      batch.created.push(alert);
    }
    if (held > 0) {
      overflow[rule.id] = countOf(overflow, rule.id) + held;
      this.#warn(`rule ${rule.id}: ${held} more hits held back by the cap of ${maxActivePerRule} per rule or ${maxAlerts} open alerts`);
    }
  }

  // Resolve the least severe (then least recently seen) open alert when it is less severe than `severity`. It goes into
  // its rule's cooldown, so it does not come straight back, and counts as held back (at bootstrap its subject joins the
  // baseline like any other held hit). Returns it, or null.
  #displace(severity, now, open, batch, overflow, bootstrap) {
    let weakest = null;
    for (const alert of open.values()) if (weakest === null || bySeverity(alert, weakest) > 0) weakest = alert;
    if (weakest === null || levelRank(weakest.severity) >= levelRank(severity)) return null;
    if (bootstrap) this.#store.state.engine.baseline[subjectOf({ id: weakest.ruleId, kind: weakest.kind }, weakest.dedupKey)] = now;
    this.#close(weakest, now, 'displaced by a more severe alert', this.#rule(weakest.ruleId)?.cooldownMinutes ?? 0);
    open.delete(weakest.dedupKey);
    batch.resolved.push(weakest);
    overflow[weakest.ruleId] = countOf(overflow, weakest.ruleId) + 1;
    return weakest;
  }

  // A hit for an open alert: only lastSeenAt, count and evidence follow the hit (the title and summary stay those of the
  // first hit); a more severe hit escalates and brings an acknowledged or snoozed alert back to firing.
  #refresh(alert, hit, rule, now, batch) {
    const { engine } = this.#store.state;
    delete engine.misses[alert.dedupKey];
    // Times are never in the future, so no age is negative whichever way the clock moved.
    alert.lastSeenAt = now;
    alert.firstSeenAt = Math.min(alert.firstSeenAt, now);
    alert.count = Math.min(alert.count + 1, Number.MAX_SAFE_INTEGER);
    if (Array.isArray(hit.evidence)) alert.evidence = copy(hit.evidence.slice(0, MAX_EVIDENCE));
    alert.ruleName = rule.name;
    alert.notify = rule.notify;
    if (levelRank(hit.severity) <= levelRank(alert.severity)) return;
    addLog(alert, now, 'escalated', `${alert.severity} to ${hit.severity}`);
    alert.severity = hit.severity;
    alert.state = 'firing';
    delete alert.ack;
    delete alert.snooze;
    // A new notification per channel is due for the escalated episode.
    delete alert.notified;
    batch.escalated.push(alert);
  }

  #open(rule, hit, now, silent) {
    const { alerts, engine } = this.#store.state;
    const key = hit.dedupKey;
    let episode = alerts.filter(alert => alert.dedupKey === key).length + 1;
    let id = alertId(key, now, episode);
    while (alerts.some(alert => alert.id === id)) id = alertId(key, now, ++episode);
    const alert = {
      id,
      ruleId: rule.id,
      ruleName: rule.name,
      dedupKey: key,
      kind: rule.kind,
      severity: hit.severity,
      state: 'firing',
      title: cleanText(hit.title, MAX_TITLE) || 'Untitled alert',
      summary: cleanText(hit.summary, MAX_SUMMARY),
      entity: isObject(hit.entity) ? copy(hit.entity) : { type: 'unknown', id: key },
      evidence: Array.isArray(hit.evidence) ? copy(hit.evidence.slice(0, MAX_EVIDENCE)) : [],
      ...(isObject(hit.metric) ? { metric: copy(hit.metric) } : {}),
      firstSeenAt: now,
      lastSeenAt: now,
      count: 1,
      notify: rule.notify,
      silent,
      log: [{ at: now, action: 'created' }],
    };
    if (silent) addLog(alert, now, 'silent', 'initial baseline: not notified');
    delete engine.pending[key];
    delete engine.misses[key];
    alerts.push(alert);
    return alert;
  }

  // Resolve an alert. With a cooldown the same dedupKey cannot open a new episode before it ends.
  #close(alert, now, note, cooldownMinutes) {
    const { engine } = this.#store.state;
    alert.state = 'resolved';
    // Never in the future and never before lastSeenAt, even when the clock went back.
    alert.resolvedAt = now;
    alert.lastSeenAt = Math.min(alert.lastSeenAt, now);
    alert.firstSeenAt = Math.min(alert.firstSeenAt, alert.lastSeenAt);
    delete alert.ack;
    delete alert.snooze;
    addLog(alert, now, 'resolved', note);
    delete engine.misses[alert.dedupKey];
    delete engine.pending[alert.dedupKey];
    if (cooldownMinutes > 0) engine.cooldowns[alert.dedupKey] = alert.resolvedAt + cooldownMinutes * MINUTE_MS;
  }

  // A snooze whose deadline has passed: back to firing when the last evaluation of its rule still hit it, otherwise
  // resolved. Returns true when anything changed.
  #expireSnoozes(now, resolved = []) {
    const { alerts, engine } = this.#store.state;
    let changed = false;
    for (const alert of alerts) {
      if (alert.state !== 'snoozed' || !(alert.snooze.until <= now)) continue;
      changed = true;
      if (countOf(engine.misses, alert.dedupKey) > 0) {
        this.#close(alert, now, 'snooze expired; condition cleared', this.#rule(alert.ruleId)?.cooldownMinutes ?? 0);
        resolved.push(alert);
      } else {
        alert.state = 'firing';
        delete alert.snooze;
        addLog(alert, now, 'unsnoozed', 'snooze expired');
      }
    }
    return changed;
  }

  // Counters only for rules that are still enabled, misses only for open alerts, cooldowns only while they last.
  #tidyCounters(enabled, now) {
    const { alerts, engine } = this.#store.state;
    const open = new Set(alerts.filter(isOpen).map(alert => alert.dedupKey));
    for (const key of Object.keys(engine.pending)) if (!enabled.has(ruleOfKey(key))) delete engine.pending[key];
    for (const key of Object.keys(engine.misses)) if (!open.has(key)) delete engine.misses[key];
    for (const key of Object.keys(engine.cooldowns)) if (!(engine.cooldowns[key] > now)) delete engine.cooldowns[key];
  }

  // ─── reading ───────────────────────────────────────────────────────────────

  // Clock clamps and due snooze expiries happen on reads too; the store is written only when something changed.
  #current() {
    const state = this.#state;
    const now = this.#now();
    const clamped = clampTimes(state, this.#effectiveRules(), now);
    if (this.#expireSnoozes(now) || clamped) this.#store.save();
    return state;
  }

  /** Counts, threat level and the most important firing alerts. Cheap; safe to call between sweeps. */
  summary() {
    const { alerts, engine } = this.#current();
    const counts = { critical: 0, high: 0, watch: 0, info: 0, total: 0, acked: 0, snoozed: 0 };
    const firing = [];
    for (const alert of alerts) {
      if (!isOpen(alert)) continue;
      counts.total += 1;
      if (alert.state === 'firing') {
        counts[alert.severity] += 1;
        firing.push(alert);
      } else {
        counts[alert.state] += 1;
      }
    }
    firing.sort(bySeverity);
    const leading = firing.slice(0, TOP);
    const rules = this.#effectiveRules();
    return {
      generatedAt: this.#now(),
      lastEvaluatedAt: engine.lastEvaluatedAt,
      counts,
      threat: {
        level: firing.length === 0 ? 1 : threatOf(firing[0].severity),
        drivers: leading.map(alert => ({ alertId: alert.id, ruleId: alert.ruleId, severity: alert.severity, title: alert.title })),
      },
      top: leading.map(compactAlert),
      // The "+N more" per rule: hits of the last evaluation held back by the per-rule cap or the open-alert ceiling.
      overflow: Object.keys(engine.overflow).map(ruleId => ({ ruleId, count: engine.overflow[ruleId] }))
        .sort((a, b) => b.count - a.count || (a.ruleId < b.ruleId ? -1 : 1)).slice(0, MAX_OVERFLOW_ROWS),
      rules: { enabled: rules.filter(rule => rule.enabled).length, total: rules.length },
      status: { ...this.#store.status },
    };
  }

  /** Alerts by state (`active` = not resolved; default), optionally one severity and one rule, firing first. Copies. */
  list(options) {
    const { state = 'active', severity, rule, limit = 200 } = isObject(options) ? options : {};
    const { alerts } = this.#current();
    const wanted = LIST_STATES.includes(state) ? state : 'active';
    const max = integerIn(limit, 1, 100000, 200);
    return alerts
      .filter(alert => wanted === 'all' || (wanted === 'resolved') === (alert.state === 'resolved'))
      .filter(alert => severity === undefined || alert.severity === severity)
      .filter(alert => rule === undefined || alert.ruleId === rule)
      .sort(byListOrder)
      .slice(0, max)
      .map(copy);
  }

  /** A copy of one alert, or null. */
  get(id) {
    const alert = this.#find(id);
    return alert === undefined ? null : copy(alert);
  }

  #find(id) {
    return typeof id === 'string' ? this.#current().alerts.find(alert => alert.id === id) : undefined;
  }

  #require(id) {
    const alert = this.#find(id);
    if (alert === undefined) throw new AlertError(404, 'NOT_FOUND', 'No such alert', 'id');
    if (alert.state === 'resolved') throw new AlertError(400, 'INVALID_STATE', 'The alert is already resolved', 'id');
    return alert;
  }

  // ─── operator actions ──────────────────────────────────────────────────────

  /** Acknowledge an open alert (idempotent). */
  ack(id) {
    const alert = this.#require(id);
    if (alert.state !== 'acked') {
      const now = this.#now();
      alert.state = 'acked';
      alert.ack = { at: now };
      delete alert.snooze;
      addLog(alert, now, 'acked');
      this.#store.save();
    }
    return copy(alert);
  }

  /** Snooze an open alert for 15 minutes to 7 days, with an optional reason of up to 120 characters. */
  snooze(id, minutes, reason) {
    const note = snoozeReason(minutes, reason);
    const alert = this.#require(id);
    const now = this.#now();
    alert.state = 'snoozed';
    alert.snooze = note === '' ? { at: now, until: now + minutes * MINUTE_MS } : { at: now, until: now + minutes * MINUTE_MS, reason: note };
    delete alert.ack;
    addLog(alert, now, 'snoozed', `${minutes} min`);
    this.#store.save();
    return copy(alert);
  }

  /** Resolve an open alert by hand; if its condition persists it reopens as a new alert after the rule's cooldown. */
  resolve(id) {
    const alert = this.#require(id);
    this.#close(alert, this.#now(), 'resolved manually', this.#rule(alert.ruleId)?.cooldownMinutes ?? 0);
    this.#store.save();
    return copy(alert);
  }

  /** Acknowledge every firing alert, or every firing alert of one severity. Returns the acknowledged alerts. */
  ackAll(options) {
    const severity = isObject(options) ? options.severity : undefined;
    if (severity !== undefined && !LEVELS.includes(severity)) {
      throw new AlertError(400, 'INVALID_STATE', `severity must be one of ${LEVELS.join(', ')}`, 'severity');
    }
    const { alerts } = this.#current();
    const now = this.#now();
    const acked = alerts.filter(alert => alert.state === 'firing' && (severity === undefined || alert.severity === severity));
    for (const alert of acked) {
      alert.state = 'acked';
      alert.ack = { at: now };
      addLog(alert, now, 'acked');
    }
    if (acked.length > 0) this.#store.save();
    return acked.map(copy);
  }

  /** Record that an alert was sent on these channels. Unknown ids are ignored (the alert may have been pruned). */
  markNotified(id, channels) {
    const alert = this.#find(id);
    const fresh = Array.isArray(channels) ? channels.filter(channel => typeof channel === 'string' && CHANNEL.test(channel)) : [];
    if (alert === undefined || fresh.length === 0) return;
    const known = alert.notified?.channels ?? [];
    alert.notified = { at: this.#now(), channels: [...new Set([...known, ...fresh])].slice(0, MAX_CHANNELS) };
    this.#store.save();
  }

  // ─── rules ─────────────────────────────────────────────────────────────────

  /** The effective rules, each with `source`: builtin | override | user. Copies. */
  rules() {
    return this.#effectiveRules().map(copy);
  }

  /**
   * Create or replace a user rule, or set the override of a built-in (PUT semantics: the stored override is replaced).
   * For a built-in the body holds the override fields; `id`, `name` and `kind` may be sent along but must not differ.
   * Throws AlertError 400 INVALID_RULE with the failing field.
   */
  putRule(id, input) {
    const state = this.#state;
    if (typeof id !== 'string' || !RULE_ID.test(id)) throw invalidRule('id', 'idPattern');
    let record;
    if (BUILTINS.has(id)) {
      const override = overrideOf(BUILTINS.get(id), input);
      record = Object.keys(override).length === 0 ? null : { id, override };
    } else {
      const result = validateRule(input, { id });
      if (!result.ok) throw invalidRule(result.error.field, result.error.key, result.error.values);
      const others = state.userRules.filter(item => !BUILTINS.has(item.id) && item.id !== id).length;
      if (others >= MAX_USER_RULES) throw ruleStateError(400, 'INVALID_STATE', 'userRuleLimit', { max: MAX_USER_RULES });
      record = { id, rule: result.rule };
    }
    const index = state.userRules.findIndex(item => item.id === id);
    const rest = state.userRules.filter(item => item.id !== id);
    if (record !== null) rest.splice(index < 0 ? rest.length : index, 0, record);
    state.userRules = rest;
    this.#rules = null;
    const rule = this.#rule(id);
    this.#syncRule(rule);
    this.#store.save();
    return copy(rule);
  }

  /** Delete a user rule (its alerts are resolved) or reset a built-in's override. A built-in itself cannot be deleted. */
  deleteRule(id) {
    const state = this.#state;
    const exists = typeof id === 'string' && state.userRules.some(item => item.id === id);
    if (!exists) {
      if (BUILTINS.has(id)) throw ruleStateError(400, 'INVALID_STATE', 'builtinDelete');
      throw ruleStateError(404, 'NOT_FOUND', 'noSuchRule');
    }
    state.userRules = state.userRules.filter(item => item.id !== id);
    this.#rules = null;
    if (BUILTINS.has(id)) this.#syncRule(this.#rule(id));
    else this.#retire(id, 'rule deleted');
    this.#store.save();
  }

  // After a rule changed: a disabled rule's alerts are resolved; an enabled one's open alerts take its name and notify flag.
  #syncRule(rule) {
    if (!rule.enabled) {
      this.#retire(rule.id, 'rule disabled');
      return;
    }
    for (const alert of this.#store.state.alerts) {
      if (alert.ruleId !== rule.id || !isOpen(alert)) continue;
      alert.ruleName = rule.name;
      alert.notify = rule.notify;
    }
  }

  // Resolve the open alerts of a rule that is gone or disabled (no cooldown) and forget its counters.
  #retire(ruleId, note) {
    const { alerts, engine } = this.#store.state;
    const now = this.#now();
    for (const alert of alerts) if (alert.ruleId === ruleId && isOpen(alert)) this.#close(alert, now, note, 0);
    const prefix = ruleKeyPrefix(ruleId);
    for (const table of [engine.pending, engine.misses]) {
      for (const key of Object.keys(table)) if (key.startsWith(prefix)) delete table[key];
    }
  }

  /** Every metric of the registry with its value in `snapshot`, or the last evaluated value without one. */
  metricsCatalog(snapshot) {
    const values = isObject(snapshot) ? metricValues(snapshot) : this.#state.engine.metrics;
    return METRICS.map(({ key, label, unit, kind }) => ({ key, label, unit, kind, value: Object.hasOwn(values, key) ? values[key] : null }));
  }
}
