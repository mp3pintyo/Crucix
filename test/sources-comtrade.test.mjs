import test from 'node:test';
import assert from 'node:assert/strict';
import { briefing, getTradeData } from '../apis/sources/comtrade.mjs';
import { runSource } from '../apis/briefing.mjs';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const HOUR = 3600000;
const PAIRS = 10; // 2 reporters x 5 commodities
const BUDGET = 25000;

const row = (partnerCode, partnerDesc, primaryValue, extra = {}) => ({
  reporterCode: 842, reporterDesc: 'USA', partnerCode, partnerDesc, cmdCode: '2709', cmdDesc: 'Crude', flowCode: 'M', flowDesc: 'Import', primaryValue, period: '2025', ...extra,
});
const page = rows => ({ elapsedTime: '0.1 secs', count: rows.length, data: rows, error: '' });
const sample = () => page([row(0, 'World', 9e9), row(124, 'Canada', 4e9), row(484, 'Mexico', 1e9)]);
const reply = (body, init) => new Response(JSON.stringify(body), { status: 200, ...init });
const limited = () => reply({ statusCode: 429, message: 'Rate limit is exceeded. Try again in 2 seconds.' }, { status: 429 });
const down = () => reply({ message: 'down' }, { status: 503 });

// Mocks globalThis.fetch, the clock, the pacing delay and the cache. The clock advances on every delay and by the
// simulated latency of each request (latency(n) for the n-th request); a request slower than its timeout times out.
// With 3 s pacing ten pairs do not fit into the 25 s production budget, so tests not about the budget widen it;
// budgetMs: null keeps the production default.
function harness(respond = () => sample(), { latency = () => 0, start = NOW, budgetMs = 60000 } = {}) {
  const calls = [], urls = [], sleeps = [], log = [];
  let now = start, runAt = start;
  const request = async options => {
    const ms = latency(calls.length + 1), at = now, spent = Math.min(ms, options.timeout);
    calls.push({ reporter: String(options.reporterCode), cmd: options.cmdCode, period: String(options.period), timeout: options.timeout, at, end: at + spent, budgetEnd: runAt + (opts.budgetMs ?? BUDGET) });
    now += spent; log.push('fetch');
    return ms > options.timeout ? { error: `Request timed out after ${options.timeout}ms` } : getTradeData(options);
  };
  const opts = { cache: new Map(), clock: () => now, sleep: async ms => { sleeps.push(ms); log.push('sleep'); now += ms; }, request, ...(budgetMs === null ? {} : { budgetMs }) };
  const impl = async url => {
    const params = new URL(url).searchParams;
    urls.push(params);
    const body = respond(params, urls.length);
    return body instanceof Response ? body : reply(body);
  };
  const run = async (fn = () => briefing(opts)) => {
    const original = globalThis.fetch; globalThis.fetch = impl; runAt = now;
    try { return await fn(); } finally { globalThis.fetch = original; }
  };
  return { calls, urls, sleeps, log, opts, run, advance: ms => { now += ms; } };
}

// No call may end after the run budget (well inside the 30 s runSource race), none starts with less than 5 s left,
// none waits longer than 10 s, and each call starts at least 3 s after the previous response (2.5 s for the one
// retry of the same request after a 429).
function assertWithinBudget(calls) {
  for (const call of calls) {
    assert.ok(call.end <= call.budgetEnd, `call at ${call.at} ends at ${call.end}, after the budget ${call.budgetEnd}`);
    assert.ok(call.timeout >= 5000 && call.timeout <= 10000, `timeout ${call.timeout}`);
  }
  calls.slice(1).forEach((call, i) => {
    const prev = calls[i];
    const retry = call.reporter === prev.reporter && call.cmd === prev.cmd && call.period === prev.period;
    if (call.budgetEnd === prev.budgetEnd) assert.ok(call.at - prev.end >= (retry ? 2500 : 3000), `paced: ${call.at - prev.end} ms`);
  });
}

test('queries the previous calendar year directly, never the current one, pinned to totals', async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(h.calls.length, PAIRS);
  assert.ok(h.calls.every(call => call.period === '2025'), JSON.stringify(h.calls));
  for (const params of h.urls) {
    assert.equal(params.get('flowCode'), 'M'); assert.equal(params.get('partnerCode'), null);
    assert.equal(params.get('partner2Code'), '0'); assert.equal(params.get('customsCode'), 'C00'); assert.equal(params.get('motCode'), '0');
  }
  assert.equal(result.status, 'ok'); assert.equal(result.tradeFlows.length, PAIRS); assert.equal('error' in result, false); assert.equal('stale' in result, false);
  assert.equal(result.tradeFlows[0].period, 2025);
});

test('falls back to the year before only when the previous year has no rows, at most once per pair', async () => {
  const h = harness(params => {
    const pair = `${params.get('reporterCode')}:${params.get('cmdCode')}`;
    if (pair === '842:2709') return params.get('period') === '2025' ? page([]) : sample();
    if (pair === '156:93') return page([]);
    return sample();
  });
  const result = await h.run();
  assert.equal(h.calls.length, PAIRS + 2);
  assert.deepEqual(h.calls.filter(c => c.reporter === '842' && c.cmd === '2709').map(c => c.period), ['2025', '2024']);
  assert.deepEqual(h.calls.filter(c => c.reporter === '156' && c.cmd === '93').map(c => c.period), ['2025', '2024']);
  assert.equal(result.tradeFlows.length, PAIRS - 1, 'a pair without data in either year has no flow');
  assert.equal(result.tradeFlows.find(f => f.cmdCode === '2709' && f.reporter === 'United States').period, 2024);
  assert.equal('error' in result, false, 'an empty year is not a failure');
  assertWithinBudget(h.calls);
});

test('calls are paced three seconds after the previous response through the injectable delay', async () => {
  const h = harness(() => sample(), { latency: () => 700 });
  await h.run();
  assert.equal(h.sleeps.length, PAIRS - 1); assert.ok(h.sleeps.every(ms => ms >= 3000));
  assert.deepEqual(h.log, ['fetch', ...Array(PAIRS - 1).fill(['sleep', 'fetch']).flat()], 'a delay between every two calls, none before the first');
  assertWithinBudget(h.calls);
});

test('a successful sweep is cached for 24 hours: the next sweep makes no request', async () => {
  const h = harness();
  const first = await h.run();
  h.advance(23 * HOUR);
  const second = await h.run();
  assert.equal(h.calls.length, PAIRS, 'no request inside the TTL');
  assert.deepEqual(second.tradeFlows, first.tradeFlows); assert.equal(second.status, 'ok'); assert.equal('stale' in second, false);
  assert.equal(second.timestamp, new Date(NOW + 9 * 3000 + 23 * HOUR).toISOString());
  h.advance(HOUR);
  await h.run();
  assert.equal(h.calls.length, 2 * PAIRS, 'refreshed after 24 hours');
});

test('when every call fails the source reports an error and caches nothing', async () => {
  const h = harness(down);
  const result = await h.run();
  assert.equal(h.calls.length, PAIRS, 'one call per pair, no retry');
  assert.match(result.error, /Comtrade unavailable for all 10 pairs: HTTP 503/); assert.equal(result.status, 'error');
  assert.deepEqual(result.tradeFlows, []); assert.equal(result.pairErrors.length, PAIRS);
  const health = await h.run(() => runSource('Comtrade', briefing, h.opts));
  assert.equal(health.status, 'error'); assert.equal(h.calls.length, 2 * PAIRS, 'failures are asked again next sweep');
});

test('a partial failure is surfaced and only the failed pair is asked again', async () => {
  const h = harness(params => params.get('reporterCode') === '156' && params.get('cmdCode') === '8542' ? reply({}, { status: 500 }) : sample());
  const result = await h.run();
  assert.equal(result.error, 'Comtrade unavailable for 1/10 pairs');
  assert.deepEqual(result.pairErrors, [{ reporter: 'China', commodity: 'Semiconductors (Electronic Integrated Circuits)', cmdCode: '8542', error: 'HTTP 500' }]);
  assert.equal(result.tradeFlows.length, PAIRS - 1); assert.equal(result.status, 'ok');
  await h.run();
  assert.equal(h.calls.length, PAIRS + 1);
});

test('a 429 is retried once after a wait and the pair succeeds', async () => {
  const h = harness((params, n) => n === 3 ? limited() : sample());
  const result = await h.run();
  assert.equal(h.calls.length, PAIRS + 1, 'one retry');
  assert.deepEqual([h.calls[2], h.calls[3]].map(c => `${c.reporter}:${c.cmd}:${c.period}`), ['842:7108:2025', '842:7108:2025'], 'the same request again');
  assert.equal(h.sleeps[2], 2500, 'retry-after is not exposed by the fetch helper: a fixed 2.5 s wait');
  assert.equal(result.tradeFlows.length, PAIRS); assert.equal('error' in result, false); assert.doesNotMatch(result.note, /deferred/);
  assertWithinBudget(h.calls);
});

test('a 429 on the retry too stops the run and defers the pair; the next sweep completes it', async () => {
  const h = harness((params, n) => n === 3 || n === 4 ? limited() : sample());
  const result = await h.run();
  assert.equal(h.calls.length, 4, 'no further calls after the second 429');
  assert.equal(result.tradeFlows.length, 2); assert.equal('error' in result, false, 'rate limiting is not a provider failure');
  assert.equal('pairErrors' in result, false); assert.equal(result.status, 'ok');
  assert.match(result.note, /8\/10 pairs deferred to the next sweep \(rate limited, HTTP 429\)/);
  const rest = await h.run();
  assert.equal(h.calls.length, 4 + 8, 'only the deferred pairs are asked again'); assert.equal(rest.tradeFlows.length, PAIRS);
  assertWithinBudget(h.calls);
  const cold = harness(() => limited());
  const none = await cold.run(() => runSource('Comtrade', briefing, cold.opts));
  assert.equal(cold.calls.length, 2); assert.equal(none.status, 'stale', 'a rate-limited cold sweep has no data: deferred, never ok and not an error');
  assert.deepEqual(none.data.tradeFlows, []); assert.equal(none.data.status, 'no_data'); assert.equal(none.data.stale, true); assert.equal('error' in none.data, false);
  assert.match(none.data.note, /10\/10 pairs deferred/);
  assert.equal('stale' in result, false, 'a partial result with flows stays as it is');
});

test('a 429 is not retried when the budget has no room for the wait and a call', async () => {
  const slow = [9000, 9000];
  const h = harness((params, n) => n === 2 ? limited() : sample(), { budgetMs: null, latency: n => slow[n - 1] ?? 0 });
  const result = await h.run();
  assert.equal(h.calls.length, 2); assert.equal('error' in result, false); assert.match(result.note, /9\/10 pairs deferred/);
  assertWithinBudget(h.calls);
});

test('the run stops starting calls near the 25 s budget and the next sweeps complete the rest', async () => {
  const h = harness(() => sample(), { budgetMs: null, latency: () => 3000 });
  const result = await h.run();
  assert.equal(h.calls.length, 4); assert.equal(result.tradeFlows.length, 4);
  assertWithinBudget(h.calls);
  assert.equal('error' in result, false, 'running out of time is not a provider failure');
  assert.match(result.note, /6\/10 pairs deferred to the next sweep \(time budget\)/);
  h.advance(15 * 60000);
  assert.equal((await h.run()).tradeFlows.length, 8);
  h.advance(15 * 60000);
  const rest = await h.run();
  assert.equal(h.calls.length, PAIRS); assert.equal(rest.tradeFlows.length, PAIRS); assert.doesNotMatch(rest.note, /deferred/);
  assertWithinBudget(h.calls);
  const fast = harness(() => sample(), { budgetMs: null });
  await fast.run();
  assert.equal(fast.calls.length, 7, 'a cold run with instant responses fills seven pairs');
});

test('no call starts after the pacing delay with less than 5 s of the budget left', async () => {
  const slow = [9000, 6500];
  const h = harness(() => sample(), { budgetMs: null, latency: n => slow[n - 1] ?? 0 });
  const result = await h.run();
  assertWithinBudget(h.calls);
  assert.equal(h.calls.length, 2); assert.match(result.note, /8\/10 pairs deferred/);
});

test('a call aborted by the budget cap is deferred, a timeout at the full per-call limit is a failure', async () => {
  const slow = [9000, 4000, Infinity];
  const h = harness(() => sample(), { budgetMs: null, latency: n => slow[n - 1] ?? 0 });
  const result = await h.run();
  assertWithinBudget(h.calls);
  assert.equal(h.calls.length, 3); assert.equal(h.calls[2].timeout, 6000, 'the timeout is capped by the remaining budget');
  assert.equal('error' in result, false, 'our own budget cap is not a provider failure'); assert.equal(result.tradeFlows.length, 2);
  assert.match(result.note, /8\/10 pairs deferred/);
  const hung = harness(() => sample(), { latency: n => n === 1 ? Infinity : 0 });
  const failed = await hung.run();
  assert.equal(hung.calls[0].timeout, 10000); assert.match(failed.error, /1\/10 pairs/); assert.match(failed.pairErrors[0].error, /timed out/);
  assertWithinBudget(hung.calls);
});

test('top partners are sorted by value with the World aggregate excluded, and anomalies use those rows', async () => {
  const partners = [[36, 'Australia', 1.2e9], [124, 'Canada', 50e9], [484, 'Mexico', 1.1e9], [682, 'Saudi Arabia', 1.5e9], [368, 'Iraq', 1.3e9], [170, 'Colombia', 0.9e9],
    [218, 'Ecuador', 0.8e9], [566, 'Nigeria', 1.0e9], [76, 'Brazil', 1.4e9], [32, 'Argentina', 0.5e9], [328, 'Guyana', 0.7e9], [578, 'Norway', 0.6e9], [826, 'United Kingdom', 0.4e9], [434, 'Libya', 0.3e9]];
  const rows = [row(0, 'World', 70e9), ...partners.map(p => row(...p))];
  const h = harness(() => page(rows));
  const result = await h.run();
  const flow = result.tradeFlows[0];
  assert.equal(flow.totalRecords, 15); assert.equal(flow.capped, false);
  assert.deepEqual(flow.topPartners.map(p => p.partner), ['Canada', 'Saudi Arabia', 'Brazil', 'Iraq', 'Australia', 'Mexico', 'Nigeria', 'Colombia', 'Ecuador', 'Guyana']);
  assert.ok(result.signals.some(s => /Canada/.test(s))); assert.ok(result.signals.every(s => !/World/.test(s)));
  const coded = harness(() => page([row(0, 'Total', 9e9), row(124, 'Canada', 1e9)]));
  assert.deepEqual((await coded.run()).tradeFlows[0].topPartners.map(p => p.partner), ['Canada'], 'partner code 0 is the aggregate whatever its label');
});

test('breakdown rows of one partner (transport mode, customs procedure) count once, as the largest total', async () => {
  const rows = [
    row(124, 'Canada', 1e9, { motCode: 2100, customsCode: 'C01' }), row(124, 'Canada', 4e9, { motCode: 0, customsCode: 'C00' }), row(124, 'Canada', 3e9, { motCode: 9000, customsCode: 'C00' }),
    row(484, 'Mexico', 2e9, { motCode: 0, customsCode: 'C00' }),
  ];
  const h = harness(() => page(rows));
  const flow = (await h.run()).tradeFlows[0];
  assert.deepEqual(flow.topPartners.map(p => [p.partner, p.value]), [['Canada', 4e9], ['Mexico', 2e9]]);
});

test('a status inside a successful response body is not trusted as a rate limit', async () => {
  const h = harness(() => ({ error: 'x', status: 429 }));
  const result = await h.run();
  assert.equal(h.calls.length, PAIRS, 'a 200 body claiming 429 does not stop the run');
  assert.match(result.error, /all 10 pairs: x/); assert.doesNotMatch(result.error, /rate limited/);
});

test('malformed rows and values are skipped instead of breaking the source', async () => {
  const h = harness(() => page([null, 'row', 7, [], row(124, 'Canada', 4e9)]));
  const result = await h.run();
  assert.equal(result.tradeFlows.length, PAIRS); assert.deepEqual(result.tradeFlows[0].topPartners.map(p => p.partner), ['Canada']);
  const huge = harness(() => new Response(`{"data":[${JSON.stringify(row(1, 'A', 1)).replace('"primaryValue":1', '"primaryValue":1e400')},`
    + `${JSON.stringify(row(484, 'Mexico', 2e9))},${JSON.stringify(row(2, 'B', 1)).replace('"primaryValue":1', '"primaryValue":1e400')},${JSON.stringify(row(76, 'Brazil', 3e9))}],"error":""}`));
  assert.deepEqual((await huge.run()).tradeFlows[0].topPartners.map(p => p.partner), ['Brazil', 'Mexico', 'A', 'B'], 'a non-finite value sorts as no value');
  const world = harness(() => page([row('000', 'World total', 9e9), row(999, ' WORLD ', 9e9), row(null, 'Canada', 1e9)]));
  assert.deepEqual((await world.run()).tradeFlows[0].topPartners.map(p => p.partner), ['Canada'], 'aggregate code and label variants are excluded, a missing code is not the aggregate');
});

test('a response at the 500-row preview cap is flagged instead of hidden', async () => {
  const rows = Array.from({ length: 500 }, (_, i) => row(i + 1, `P${i + 1}`, (i + 1) * 1e6));
  const h = harness(() => page(rows));
  const flow = (await h.run()).tradeFlows[0];
  assert.equal(flow.totalRecords, 500); assert.equal(flow.capped, true); assert.equal(flow.topPartners.length, 10);
  assert.equal(flow.topPartners[0].partner, 'P500');
});

test('an expired entry is served stale until a refresh succeeds; failed refreshes are noted, not errors', async () => {
  let respond = () => sample();
  const h = harness((params, n) => respond(params, n));
  await h.run();
  h.advance(25 * HOUR); respond = down;
  const failed = await h.run();
  assert.equal(h.calls.length, 2 * PAIRS, 'every expired pair is asked again');
  assert.equal(failed.tradeFlows.length, PAIRS, 'nothing vanishes'); assert.equal(failed.stale, true);
  assert.equal('error' in failed, false); assert.match(failed.note, /10\/10 pairs could not be refreshed \(HTTP 503\)/);
  assert.equal((await h.run(() => runSource('Comtrade', briefing, h.opts))).status, 'stale');
  respond = (params, n) => n === 3 * PAIRS + 3 || n === 3 * PAIRS + 4 ? limited() : sample();
  const partial = await h.run();
  assert.equal(partial.tradeFlows.length, PAIRS); assert.equal(partial.stale, true); assert.equal('error' in partial, false);
  assert.doesNotMatch(partial.note, /could not be refreshed/); assert.match(partial.note, /8\/10 pairs deferred to the next sweep \(rate limited, HTTP 429\)/);
  assert.match(partial.note, /8\/10 pairs served from an expired cache entry/);
  const refreshed = await h.run();
  assert.equal(h.calls.length, 3 * PAIRS + 4 + 8);
  assert.equal(refreshed.tradeFlows.length, PAIRS); assert.equal('stale' in refreshed, false); assert.doesNotMatch(refreshed.note, /deferred|refreshed/);
});

test('a budget-limited refresh serves the pairs it could not reach from the expired cache', async () => {
  let latency = 0;
  const h = harness(() => sample(), { latency: () => latency });
  await h.run();
  h.advance(25 * HOUR); latency = 3000; delete h.opts.budgetMs; // the production budget for the refresh
  const result = await h.run();
  assertWithinBudget(h.calls);
  assert.equal(h.calls.length, PAIRS + 4); assert.equal(result.tradeFlows.length, PAIRS); assert.equal(result.stale, true); assert.equal('error' in result, false);
  assert.match(result.note, /6\/10 pairs deferred/);
});

test('the January rollover refreshes the cache for the new previous year and serves the old data while it cannot', async () => {
  const december = Date.parse('2026-12-31T12:00:00Z');
  let respond = () => sample();
  const h = harness((params, n) => respond(params, n), { start: december });
  await h.run();
  h.advance(18 * HOUR); // 2027-01-01, still inside the 24 h TTL
  respond = (params, n) => n === PAIRS + 2 || n === PAIRS + 3 ? limited() : params.get('period') === '2026' ? page([]) : sample();
  const result = await h.run();
  assert.deepEqual(h.calls.slice(PAIRS).map(c => c.period), ['2026', '2025', '2025'], 'the new previous year is asked, then the fallback and its one retry');
  assert.equal(result.tradeFlows.length, PAIRS); assert.equal(result.stale, true); assert.equal('error' in result, false, 'a 429 on the fallback degrades to stale');
  assert.match(result.note, /10\/10 pairs deferred/);
  assertWithinBudget(h.calls);
});

test('in January a cold sweep pays two calls per pair and still stays inside the budget', async () => {
  const h = harness(params => params.get('period') === '2026' ? page([]) : sample(), { start: Date.parse('2027-01-15T12:00:00Z'), latency: () => 1000, budgetMs: null });
  const result = await h.run();
  assertWithinBudget(h.calls);
  const done = result.tradeFlows.length;
  assert.ok(done >= 1 && done < PAIRS); assert.equal('error' in result, false);
  assert.deepEqual(h.calls.slice(0, 2 * done).map(c => c.period), Array(done).fill(['2026', '2025']).flat());
  assert.ok(result.tradeFlows.every(f => f.period === 2025));
  assert.match(result.note, new RegExp(`${PAIRS - done}/10 pairs deferred`));
});
