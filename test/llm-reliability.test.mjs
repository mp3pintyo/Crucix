import test from 'node:test';
import assert from 'node:assert/strict';
import { getLLMBudget, requestOptions } from '../lib/llm/budgets.mjs';
import { createLLMProvider } from '../lib/llm/index.mjs';
import { GeminiProvider } from '../lib/llm/gemini.mjs';
import { OllamaProvider } from '../lib/llm/ollama.mjs';
import { OpenAICompatibleProvider, chatCompletionsUrl } from '../lib/llm/openai-compatible.mjs';
import { normalizeIdeas, parseIdeasResponse } from '../lib/llm/idea-schema.mjs';
import { compactSweepForLLM, generateLLMIdeas, ideasSystemPrompt } from '../lib/llm/ideas.mjs';
import { generateRuleBasedIdeas, resolveIdeas } from '../lib/llm/rule-ideas.mjs';
import { DiscordAlerter } from '../lib/alerts/discord.mjs';
import { normalizeAlertEvaluation } from '../lib/llm/alert-schema.mjs';

const idea = (overrides = {}) => ({ title: 'Energy observation', type: 'LONG', confidence: 'HIGH', ticker: 'USO', rationale: 'WTI moved with confirmed source data.', risk: 'A reversal can invalidate the observation.', horizon: 'Days', signals: ['WTI'], ...overrides });
const fixture = () => ({ fred: [{ id: 'VIXCLS', value: 30 }], health: [{ n: 'FRED', err: false }], energy: {}, tg: { urgent: [] } });

function mockResponse(t, data, capture = () => {}) {
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    capture(url, opts);
    return { ok: true, json: async () => data };
  });
}

test('validated budgets preserve defaults and accept explicitly bounded local budgets', () => {
  assert.deepEqual(getLLMBudget({}, 'ideas'), { maxTokens: 4096, timeout: 90000 });
  assert.deepEqual(getLLMBudget({}, 'alerts'), { maxTokens: 800, timeout: 30000 });
  assert.deepEqual(getLLMBudget({ ideasMaxTokens: '16384', ideasTimeoutMs: 360000 }, 'ideas'), { maxTokens: 16384, timeout: 360000 });
  assert.deepEqual(getLLMBudget({ alertMaxTokens: 4096, alertTimeoutMs: 180000 }, 'alerts'), { maxTokens: 4096, timeout: 180000 });
});

test('invalid budget strings, fractions, zero and excessive values fail closed', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, '4096oops', '1e4', ' 4096', true, {}, 16385]) {
    assert.throws(() => getLLMBudget({ ideasMaxTokens: value }), /integer/);
  }
  for (const value of [0, 999, 360001, '30000ms']) assert.throws(() => getLLMBudget({ alertTimeoutMs: value }, 'alerts'), /integer/);
  assert.throws(() => requestOptions({ maxTokens: 0 }), /maxTokens/);
  assert.throws(() => createLLMProvider({ provider: 'ollama', alertMaxTokens: 4097 }), /alertMaxTokens/);
});

test('Gemini joins answer parts while excluding thinking and nontext parts', async t => {
  mockResponse(t, { candidates: [{ content: { parts: [
    { thought: true, text: 'private reasoning' }, { text: '[{"title":"An' },
    { inlineData: {} }, { text: 'swer","type":"WATCH","confidence":"LOW"}]' },
  ] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 20 } });
  const result = await new GeminiProvider({ apiKey: 'synthetic-key' }).complete('system', 'data');
  assert.doesNotMatch(result.text, /private reasoning/);
  assert.equal(parseIdeasResponse(result.text)[0].title, 'Answer');
  assert.equal(result.usage.outputTokens, 20);
  assert.equal(result.finishReason, 'STOP');
});

test('Gemini reports a thinking-only exhausted response as an error', async t => {
  mockResponse(t, { candidates: [{ content: { parts: [{ thought: true, text: 'thinking' }] }, finishReason: 'MAX_TOKENS' }] });
  await assert.rejects(new GeminiProvider({ apiKey: 'synthetic-key' }).complete('system', 'data'), /MAX_TOKENS/);
});

test('OpenAI-compatible URL supports origin, /v1 and full endpoint without duplicated path', () => {
  for (const path of ['', '/', '/v1', '/v1/', '/v1/chat/completions']) {
    assert.equal(chatCompletionsUrl(`http://127.0.0.1:1234${path}`), 'http://127.0.0.1:1234/v1/chat/completions');
  }
  assert.equal(chatCompletionsUrl('https://example.test/llm/v1'), 'https://example.test/llm/v1/chat/completions');
  for (const url of ['file:///tmp/model', 'ftp://example.test', 'localhost:8080', 'https://user:pass@example.test', 'https://example.test/?key=secret', 'https://example.test/#x']) {
    assert.throws(() => chatCompletionsUrl(url), /HTTP/);
  }
});

test('keyless compatible provider sends max_tokens and configured deadline to a mock only', async t => {
  let request, timeout;
  t.mock.method(AbortSignal, 'timeout', ms => { timeout = ms; return new AbortController().signal; });
  mockResponse(t, { choices: [{ message: { content: 'local answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 8 } }, (url, opts) => { request = { url, opts }; });
  const provider = createLLMProvider({ provider: 'openai-compatible', compatibleBaseUrl: 'http://127.0.0.1:1234/v1', model: 'loaded-model' });
  const result = await provider.complete('system', 'data', { maxTokens: 1024, timeout: 360000 });
  assert.equal(request.url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(request.opts.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(request.opts.body).messages, [{ role: 'system', content: 'system' }, { role: 'user', content: 'data' }]);
  assert.equal(JSON.parse(request.opts.body).max_tokens, 1024);
  assert.equal(JSON.parse(request.opts.body).max_completion_tokens, undefined);
  assert.equal(timeout, 360000);
  assert.equal(result.text, 'local answer');
  assert.equal(result.finishReason, 'stop');
});

test('compatible endpoint is separate from existing OpenAI and Ollama configuration', async t => {
  const urls = [];
  mockResponse(t, { choices: [{ message: { content: 'answer' } }] }, (url, opts) => urls.push([url, opts.headers.Authorization]));
  const config = { compatibleBaseUrl: 'http://127.0.0.1:1234', baseUrl: 'http://127.0.0.1:11435' };
  await createLLMProvider({ ...config, provider: 'openai', apiKey: 'synthetic-key' }).complete('s', 'u');
  await createLLMProvider({ ...config, provider: 'ollama' }).complete('s', 'u');
  await createLLMProvider({ ...config, provider: 'openai-compatible' }).complete('s', 'u');
  assert.deepEqual(urls, [
    ['https://api.openai.com/v1/chat/completions', 'Bearer synthetic-key'],
    ['http://127.0.0.1:11435/v1/chat/completions', undefined],
    ['http://127.0.0.1:1234/v1/chat/completions', undefined],
  ]);
});

test('Ollama thinking budget exhaustion is explicit, optional effort is preserved', async t => {
  let body;
  mockResponse(t, { choices: [{ message: { content: ' ', reasoning: 'not an answer' }, finish_reason: 'length' }] }, (_url, opts) => { body = JSON.parse(opts.body); });
  await assert.rejects(new OllamaProvider({ reasoningEffort: 'none' }).complete('s', 'u'), /finish_reason=length/);
  assert.equal(body.reasoning_effort, 'none');
  assert.throws(() => new OllamaProvider({ reasoningEffort: 'unbounded' }), /reasoningEffort/);
});

test('compatible provider accepts a supplied key and typed text parts, excluding reasoning', async t => {
  mockResponse(t, { choices: [{ message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'answer' }] }, finish_reason: 'stop' }] }, (_url, opts) => assert.equal(opts.headers.Authorization, 'Bearer synthetic-key'));
  assert.equal((await new OpenAICompatibleProvider({ apiKey: 'synthetic-key' }).complete('s', 'u')).text, 'answer');
});

test('OpenAI-format providers surface exhausted reasoning instead of a silent empty success', async t => {
  mockResponse(t, { choices: [{ message: { content: '', reasoning: 'hidden' }, finish_reason: 'length' }] });
  for (const provider of ['openai', 'openrouter', 'minimax', 'mistral', 'grok', 'openai-compatible']) {
    await assert.rejects(createLLMProvider({ provider, apiKey: 'synthetic-key' }).complete('s', 'u'), /finish_reason=length/);
  }
});

test('alert normalization validates controls and prevents malformed signals from breaking formatting', () => {
  const alert = { shouldAlert: true, tier: ' priority ', confidence: ' high ', headline: 'Market change', reason: 'Confirmed signals moved.', signals: ['WTI', {}, 3], actionable: null };
  const result = normalizeAlertEvaluation(alert);
  assert.equal(result.tier, 'PRIORITY');
  assert.equal(result.confidence, 'HIGH');
  assert.equal(result.actionable, 'Monitor');
  assert.deepEqual(result.signals, ['WTI']);
  assert.deepEqual(normalizeAlertEvaluation({ shouldAlert: false }), { shouldAlert: false, reason: 'No qualifying signals.' });
  for (const value of [null, [], { ...alert, shouldAlert: 'true' }, { ...alert, tier: 'URGENT' }, { ...alert, headline: {} }, { ...alert, reason: '' }, { ...alert, confidence: 'CERTAIN' }]) {
    assert.equal(normalizeAlertEvaluation(value), null);
  }
});

test('normalization enforces enums, text fields, deduplication and bounded output', () => {
  const input = idea({ type: ' long ', confidence: ' high ', horizon: 'swing', signals: ['WTI', 1, null, { text: 'bad' }], unexpected: 'discard' });
  const normalized = normalizeIdeas([input, { ...input }, null, idea({ type: 'BUY' }), idea({ confidence: 'certain' }), idea({ title: {} })]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].type, 'LONG');
  assert.equal(normalized[0].confidence, 'HIGH');
  assert.equal(normalized[0].horizon, 'Weeks');
  assert.deepEqual(normalized[0].signals, ['WTI']);
  assert.equal(normalized[0].unexpected, undefined);
  assert.equal(normalized[0].text, normalized[0].rationale);
  assert.equal(normalizeIdeas(Array.from({ length: 20 }, (_, n) => idea({ title: `Title ${n}` }))).length, 8);
  assert.equal(normalizeIdeas(Array.from({ length: 20 }, (_, n) => idea({ title: `Title ${n}` })), { maxIdeas: 100 }).length, 8);
  const bounded = normalizeIdeas([idea({ title: 'x'.repeat(1000), rationale: 'x'.repeat(9000), risk: 'x'.repeat(2000) })])[0];
  assert.equal(bounded.title.length, 160);
  assert.equal(bounded.rationale.length, 2000);
  assert.equal(bounded.risk.length, 800);
});

test('normalization takes the first usable rationale string and strips zero-width and bidi characters', () => {
  for (const rationale of [{ note: 'object' }, 42, true, ['x'], '', '   ']) {
    assert.equal(normalizeIdeas([idea({ rationale, text: 'From text.' })])[0].rationale, 'From text.', JSON.stringify(rationale));
  }
  assert.equal(normalizeIdeas([idea({ rationale: 'Own.', text: 'From text.' })])[0].rationale, 'Own.');
  assert.equal(normalizeIdeas([idea({ rationale: undefined, text: undefined })])[0].rationale, ''); // empty rationale is still accepted
  const hidden = [0x200b, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069].map(code => String.fromCharCode(code)).join('');
  const [clean] = normalizeIdeas([idea({ title: `Gold${hidden} rally`, rationale: `Up${hidden}.`, signals: [`${hidden}WTI`] })]);
  assert.deepEqual([clean.title, clean.rationale, clean.signals], ['Gold rally', 'Up.', ['WTI']]);
  assert.equal(normalizeIdeas([idea({ horizon: 'decade' })])[0].horizon, '');
});

test('parser handles fenced/prose/wrapped JSON and brackets or escaped quotes inside text', () => {
  const json = JSON.stringify([idea({ title: 'Quoted "title" [still text]' })]);
  assert.equal(parseIdeasResponse(JSON.stringify([idea({ title: '<think>literal data</think>' })]))[0].title, '<think>literal data</think>');
  for (const text of [json, `Here [not JSON] is the answer:\n\`\`\`json\n${json}\n\`\`\`\nDone [notes]`, `<think>not output</think>\n${json}`, JSON.stringify({ ideas: [idea()] })]) {
    assert.equal(parseIdeasResponse(text)?.length, 1);
  }
  for (const text of [JSON.stringify([idea({ confidence: null })]), '[]', '{bad}', null, '['.repeat(100000)]) assert.equal(parseIdeasResponse(text), null);
});

test('parser accepts a single bare idea object, as a local model returned it for the Hungarian prompt', () => {
  const single = JSON.stringify(idea({ title: 'Long Gold on Geopolitical Stress', ticker: 'GLD', horizon: 'Weeks', signals: ['Record US debt levels'] }), null, 2);
  const ideas = parseIdeasResponse(single);
  assert.equal(ideas?.length, 1);
  assert.equal(ideas[0].type, 'LONG');
  assert.equal(ideas[0].horizon, 'Weeks');
  for (const text of [JSON.stringify({ title: 'No type' }), JSON.stringify({ ideas: 'not a list' }), '"text"', '42']) assert.equal(parseIdeasResponse(text), null);
});

test('every locale prompt shows the ideas output as an array, not a single object', () => {
  for (const lang of ['en', 'fr', 'hu']) assert.match(ideasSystemPrompt(lang), /\n\[\n  \{\n[\s\S]*\n  \}\n\]/);
});

test('prompt uses real delta fields, source health schema, and treasury object', () => {
  const data = { ...fixture(), health: [{ n: 'ok' }, { n: 'error', err: true }, { n: 'disabled', disabled: true }, { n: 'old', stale: true }], treasury: { totalDebt: '38900000000000' } };
  const context = compactSweepForLLM(data, { summary: { direction: 'escalation', totalChanges: 2, criticalChanges: 1 }, signals: {
    escalated: [{ label: 'WTI', from: 80, to: 88, pctChange: 10 }],
    deescalated: [{ label: 'VIX', from: 30, to: 24, pctChange: -20 }],
  } });
  assert.match(context, /SOURCE_HEALTH: 4 sources, 1 available/);
  assert.match(context, /WTI: 80→88 \(\+10.0%\)/);
  assert.match(context, /VIX: 30→24 \(-20.0%\)/);
  assert.match(context, /totalDebtUSD=38900000000000/);
  assert.doesNotMatch(context, /undefined|\[object Object\]/);
  for (const language of ['en', 'fr', 'hu']) {
    assert.match(ideasSystemPrompt(language, data), /4 (sources|forrásból)/);
    assert.doesNotMatch(ideasSystemPrompt(language, data), /25 (sources|forrásból)/);
  }
});

test('OSINT input and total context remain bounded while leading delta is preserved', () => {
  const context = compactSweepForLLM({ ...fixture(), tg: { urgent: Array.from({ length: 100 }, () => ({ text: 'x'.repeat(10000), channel: 'channel' })) } }, { summary: { direction: 'stable', totalChanges: 0, criticalChanges: 0 } });
  assert.match(context, /DELTA_SINCE_LAST_SWEEP/);
  assert.match(context, /UNTRUSTED_OSINT_POSTS/);
  assert.ok(context.length < 2200);
});

test('ideas call uses provider-specific budget rather than hardcoded settings', async () => {
  let captured;
  const provider = { isConfigured: true, config: { ideasMaxTokens: 8192, ideasTimeoutMs: 180000 }, complete: async (_s, _u, opts) => { captured = opts; return { text: JSON.stringify([idea()]) }; } };
  assert.equal((await generateLLMIdeas(provider, fixture(), null)).length, 1);
  assert.deepEqual(captured, { maxTokens: 8192, timeout: 180000 });
});

test('rule engine safely handles missing/null metrics, zero oil baseline and nonfinite inputs', () => {
  for (const data of [undefined, null, {}, { fred: [null, { id: 'T10Y2Y', value: null }], energy: { wtiRecent: [90, 0] }, treasury: { totalDebt: '35e12garbage' } }, { fred: [{ id: 'VIXCLS', value: Infinity }], thermal: [{ det: NaN }], energy: { wtiRecent: [NaN, 1] } }]) {
    assert.deepEqual(generateRuleBasedIdeas(data), []);
  }
});

test('volatility rule boundary, normalized contract and Hungarian fallback', () => {
  assert.deepEqual(generateRuleBasedIdeas({ fred: [{ id: 'VIXCLS', value: 20 }] }), []);
  const result = generateRuleBasedIdeas(fixture(), 'hu');
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'HEDGE');
  assert.equal(result[0].confidence, 'HIGH');
  assert.equal(result[0].horizon, 'Days');
  assert.equal(result[0].source, 'rules');
  assert.match(result[0].title, /volatilitás/);
  assert.ok(result[0].text && result[0].risk && result[0].signals.length);
});

test('rule engine preserves directional oil momentum and does not label a flat curve inverted', () => {
  assert.equal(generateRuleBasedIdeas({ energy: { wtiRecent: [110, 100] } })[0].type, 'LONG');
  assert.equal(generateRuleBasedIdeas({ energy: { wtiRecent: [90, 100] } })[0].type, 'WATCH');
  assert.equal(generateRuleBasedIdeas({ fred: [{ id: 'T10Y2Y', value: 0 }] })[0].title, 'Flat Yield Curve');
});

test('multi-domain rules work independently with optional sources and cap eight ideas', () => {
  const scenarios = [
    [{ tg: { urgent: [1, 2, 3, 4] }, energy: { wti: 90 } }, 'Conflict-Energy Nexus'],
    [{ fred: [{ id: 'VIXCLS', value: 22 }, { id: 'BAMLH0A0HYM2', value: 4 }] }, 'Safe Haven'],
    [{ treasury: { totalDebt: '38900000000000' } }, 'Fiscal Trajectory'],
    [{ thermal: [{ det: 40000 }], tg: { urgent: [1, 2, 3] } }, 'Thermal Activity'],
    [{ fred: [{ id: 'T10Y2Y', value: 0.6 }], bls: [{ id: 'UNRATE', value: 5 }, { id: 'PAYEMS', value: 100 }] }, 'Steepening Curve'],
    [{ acled: { totalEvents: 80 }, energy: { wtiRecent: [85, 80] } }, 'Conflict Fueling'],
    [{ acled: { totalFatalities: 600 }, thermal: [{ det: 25000 }] }, 'Defense Procurement'],
    [{ fred: [{ id: 'VIXCLS', value: 15 }, { id: 'BAMLH0A0HYM2', value: 4 }] }, 'Credit Stress'],
    [{ bls: [{ id: 'WPUFD49104', momChangePct: 0.8 }, { id: 'CUUR0000SA0', value: 100 }], gscpi: { value: 1 } }, 'Inflation Pipeline'],
  ];
  for (const [data, title] of scenarios) {
    assert.ok(generateRuleBasedIdeas(data).some(i => i.title.includes(title)), title);
    assert.doesNotMatch(JSON.stringify(generateRuleBasedIdeas(data)), /NaN|Infinity|undefined/);
  }
  const combined = { fred: [{ id: 'VIXCLS', value: 30 }, { id: 'BAMLH0A0HYM2', value: 4 }, { id: 'T10Y2Y', value: 0.6 }], tg: { urgent: [1, 2, 3, 4] }, energy: { wti: 90, wtiRecent: [90, 80] }, thermal: [{ det: 40000 }], treasury: { totalDebt: '38900000000000' }, acled: { totalEvents: 100, totalFatalities: 600 } };
  assert.equal(generateRuleBasedIdeas(combined).length, 8);
});

test('fallback keeps useful ideas when provider is absent, disabled, fails or returns malformed data', async () => {
  for (const provider of [null, { isConfigured: false }, { isConfigured: true, complete: async () => { throw new Error('synthetic provider failure'); } }, { isConfigured: true, complete: async () => ({ text: '{broken JSON' }) }]) {
    const result = await resolveIdeas(provider, fixture());
    assert.equal(result.ideasSource, 'rules');
    assert.equal(result.ideas[0].type, 'HEDGE');
  }
  const result = await resolveIdeas({ isConfigured: true, complete: async () => ({ text: JSON.stringify([idea()]) }) }, fixture());
  assert.equal(result.ideasSource, 'llm');
  assert.equal(result.ideas[0].title, 'Energy observation');
  assert.deepEqual(await resolveIdeas(null, {}), { ideas: [], ideasSource: 'rules' });
});

test('Discord actionable alerts filter, cap, deduplicate and leave caller data unchanged', async () => {
  const alerter = new DiscordAlerter({ webhookUrl: 'https://example.test/synthetic' });
  const sent = [];
  alerter.sendMessage = async (_text, embeds) => { sent.push(embeds); return true; };
  const first = Object.freeze(idea({ source: 'llm' }));
  const inputs = [first, idea({ title: 'Second', type: 'HEDGE' }), idea({ title: 'Third' }), idea({ title: 'Watch', type: 'WATCH' }), idea({ title: 'Long term', horizon: 'Months' }), idea({ title: 'Rule', source: 'rules' })];
  const before = JSON.stringify(inputs);
  assert.equal(await alerter.sendActionableIdeas(inputs), true);
  assert.equal(sent[0].length, 2);
  assert.equal(JSON.stringify(inputs), before);
  alerter._alertHistory = []; // Isolate per-idea dedup from shared tier cooldown.
  assert.equal(await alerter.sendActionableIdeas(inputs.slice(0, 2)), false);
  assert.equal(sent.length, 1);
  assert.equal(await alerter.sendActionableIdeas([idea({ type: 'SHORT' })]), true); // Changed direction is a distinct idea.
});

test('Discord failed send is retryable and mute/shared priority limits prevent sends', async () => {
  const alerter = new DiscordAlerter({ webhookUrl: 'https://example.test/synthetic' });
  let calls = 0;
  alerter.sendMessage = async () => ++calls > 1;
  assert.equal(await alerter.sendActionableIdeas([idea()]), false);
  assert.equal(alerter._alertedIdeas.size, 0);
  assert.equal(await alerter.sendActionableIdeas([idea()]), true);
  assert.equal(await alerter.sendActionableIdeas([idea({ title: 'Another' })]), false);
  assert.equal(calls, 2);
  alerter._alertHistory = [];
  alerter._muteUntil = Date.now() + 100000;
  assert.equal(await alerter.sendActionableIdeas([idea({ title: 'Another' })]), false);
  assert.equal(calls, 2);
});

test('Discord dedup expires and formatted embeds obey platform size limits', async () => {
  const alerter = new DiscordAlerter({ webhookUrl: 'https://example.test/synthetic' });
  let embed;
  alerter.sendMessage = async (_text, embeds) => { embed = embeds[0]; return true; };
  const input = idea({ title: 'x'.repeat(1000), rationale: 'x'.repeat(10000), risk: 'x'.repeat(10000), signals: Array(20).fill('x'.repeat(1000)) });
  await alerter.sendActionableIdeas([input]);
  assert.ok(embed.title.length <= 256);
  assert.ok(embed.description.length <= 4096);
  assert.ok(embed.fields.every(f => f.value.length <= 1024));
  const total = embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  assert.ok(total < 6000);
  alerter._alertHistory = [];
  for (const key of alerter._alertedIdeas.keys()) alerter._alertedIdeas.set(key, Date.now() - 7 * 3600000);
  assert.equal(await alerter.sendActionableIdeas([input]), true);
});
