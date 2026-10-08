import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../lib/llm/json-extract.mjs';
import { parseIdeasResponse } from '../lib/llm/idea-schema.mjs';
import { generateBriefing } from '../lib/llm/briefing.mjs';
import { TelegramAlerter } from '../lib/alerts/telegram.mjs';
import { DiscordAlerter } from '../lib/alerts/discord.mjs';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const quiet = { warn() {}, error() {}, log() {}, info() {} };
const idea = (overrides = {}) => ({ title: 'Energy observation', type: 'LONG', confidence: 'HIGH', ticker: 'USO', rationale: 'WTI moved.', risk: 'A reversal.', horizon: 'Days', signals: ['WTI'], ...overrides });
const bullets = { bullets: [{ text: 'Quake near Tokyo', refs: [1] }] };
const isBullets = value => Array.isArray(value?.bullets);

test('extractJson finds the answer in the shapes local and cloud models return', () => {
  const answer = JSON.stringify(bullets);
  const row = '[1] {"level":"high","kind":"earthquake","title":"M6.4 earthquake near Tokyo"}';
  const cases = [
    ['plain JSON', answer],
    ['BOM', String.fromCharCode(0xfeff) + answer],
    ['fence with json tag', `\`\`\`json\n${answer}\n\`\`\``],
    ['fence without tag', `\`\`\`\n${answer}\n\`\`\``],
    ['fence with uppercase JSON tag', `\`\`\`JSON\n${answer}\n\`\`\``],
    ['fence mid-text', `Here is the briefing:\n\`\`\`json\n${answer}\n\`\`\`\nHope this helps.`],
    ['prose before and after', `Sure! ${answer} Let me know.`],
    ['prose with {} and [] before the answer', `Based on rows {1,2} and [3]: ${answer}`],
    ['echoed input row before the answer', `${row}\n${answer}`],
    ['paired think block', `<think>draft {"bullets":"no"} [1]</think>\n${answer}`],
    ['lone closing think tag', `reasoning that was opened by the template {not: json}</think>\n${answer}`],
    ['unbalanced [ before the answer', `[note: see below\n${answer}`],
  ];
  for (const [name, text] of cases) assert.deepEqual(extractJson(text, { accept: isBullets }), { value: bullets, reason: null }, name);
});

test('extractJson keeps string contents intact: literal <think>, escaped quotes and brackets', () => {
  const think = JSON.stringify({ bullets: [{ text: '<think>literal</think>', refs: [1] }] });
  assert.equal(extractJson(think, { accept: isBullets }).value.bullets[0].text, '<think>literal</think>');
  const tricky = { bullets: [{ text: 'He said "stop ] }" [x', refs: [2] }] };
  assert.deepEqual(extractJson(`Answer: ${JSON.stringify(tricky)} done`, { accept: isBullets }).value, tricky);
  assert.deepEqual(extractJson('[{"a":"x\\\\"}]').value, [{ a: 'x\\' }]);
});

test('extractJson reports why nothing was found and never repairs', () => {
  const cases = [
    [null, 'empty'], [42, 'empty'], ['   ', 'empty'],
    ['no JSON here at all', 'no_json'],
    ['{bad}', 'invalid_json'],
    ['{"text": \'single quotes\'}', 'invalid_json'],
    ['{"a":1,}', 'invalid_json'],
    // A local model's pretty-printed briefing lost the opening quote of a later key: it is not repaired.
    ['{\n"bullets": [\n{\ntext": "Quake near Tokyo",\n"refs": [1]\n}\n]\n}', 'invalid_json'],
    ['[3] and {"other": true}', 'wrong_shape'],
    ['"text"', 'wrong_shape'],
  ];
  for (const [text, reason] of cases) assert.deepEqual(extractJson(text, { accept: isBullets }), { value: null, reason }, String(text));
  assert.deepEqual(extractJson('x'.repeat(200), { maxLength: 100 }), { value: null, reason: 'too_long' });
  assert.equal(extractJson('{}', { accept: () => { throw new Error('caller bug'); } }).reason, 'wrong_shape');
});

test('extractJson stays fast on a pathological bracket run', () => {
  const started = performance.now();
  const result = extractJson('['.repeat(100000), { accept: isBullets });
  assert.ok(performance.now() - started < 500);
  assert.deepEqual(result, { value: null, reason: 'invalid_json' });
  assert.equal(extractJson(`${'['.repeat(100)}${JSON.stringify(bullets)}`, { accept: isBullets, maxCandidates: 8 }).reason, 'invalid_json');
});

test('a fenced single idea object gives one idea', () => {
  const ideas = parseIdeasResponse(`\`\`\`json\n${JSON.stringify(idea(), null, 2)}\n\`\`\``);
  assert.equal(ideas?.length, 1);
  assert.equal(ideas[0].title, 'Energy observation');
});

test('the briefing accepts a bare bullet object and no longer reads the refs array of one as the bullet list', async () => {
  const snapshot = { events: [{ id: `event-${'1'.padStart(32, '0')}`, kind: 'earthquake', title: 'M6.4 earthquake near Tokyo', severity: 'high', observedAt: new Date(NOW - 3600000).toISOString() }] };
  const brief = text => generateBriefing({ scope: 'global', snapshot, provider: { isConfigured: true, config: {}, complete: async () => ({ text }) }, now: NOW, log: quiet });
  const bare = await brief('{"text":"Quake near Tokyo","refs":[1]}');
  assert.equal(bare.source, 'llm');
  assert.deepEqual(bare.bullets.map(bullet => [bullet.text, bullet.refs.map(ref => ref.n)]), [['Quake near Tokyo', [1]]]);
  const short = await brief('{"text":"x","refs":[1]}');
  assert.deepEqual([short.source, short.bullets.length, short.bullets[0].text], ['llm', 1, 'x']);
});

test('alerts take the real answer after a <think> draft, on Telegram and Discord', async t => {
  t.mock.method(console, 'log', () => {});
  const draft = JSON.stringify({ shouldAlert: false, reason: 'draft' });
  const real = JSON.stringify({ shouldAlert: true, tier: 'PRIORITY', confidence: 'HIGH', headline: 'Real headline', reason: 'Confirmed move.', actionable: 'Watch', signals: ['VIX'] });
  const provider = { isConfigured: true, config: {}, complete: async () => ({ text: `<think>${draft}</think>${real}` }) };
  const delta = () => ({ summary: { totalChanges: 1, direction: 'risk-off', criticalChanges: 1 }, signals: { new: [{ key: 'vix', label: 'VIX', severity: 'critical', from: 20, to: 35, pctChange: 75, direction: 'up' }] } });
  const memory = () => ({ getAlertedSignals: () => ({}), markAsAlerted() {} });
  const telegram = new TelegramAlerter({ botToken: '123:abc', chatId: '42' });
  const sent = [];
  telegram.sendAlert = async message => { sent.push(message); return true; };
  assert.equal(await telegram.evaluateAndAlert(provider, delta(), memory()), true);
  assert.match(sent[0], /Real headline/);
  const discord = new DiscordAlerter({ webhookUrl: 'https://discord.example.test/api/webhooks/1/token' });
  const embeds = [];
  discord.sendMessage = async (_text, list) => { embeds.push(JSON.stringify(list)); return true; };
  assert.equal(await discord.evaluateAndAlert(provider, delta(), memory()), true);
  assert.match(embeds[0], /Real headline/);
});
