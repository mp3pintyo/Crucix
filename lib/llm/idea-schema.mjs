import { extractJson } from './json-extract.mjs';

const TYPES = new Set(['LONG', 'SHORT', 'HEDGE', 'WATCH', 'AVOID']);
const CONFIDENCES = new Set(['HIGH', 'MEDIUM', 'LOW']);
const HORIZONS = new Map([
  ['intraday', 'Intraday'], ['day', 'Days'], ['days', 'Days'], ['tactical', 'Days'],
  ['week', 'Weeks'], ['weeks', 'Weeks'], ['swing', 'Weeks'],
  ['month', 'Months'], ['months', 'Months'], ['strategic', 'Months'],
]);

export function ideaText(value, maxLength = 2000) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maxLength) : '';
}

export function normalizeIdeas(value, { source = 'llm', maxIdeas = 8 } = {}) {
  if (!Array.isArray(value)) return [];
  const limit = Number.isInteger(maxIdeas) ? Math.min(8, Math.max(0, maxIdeas)) : 8;
  if (!limit) return [];
  const seen = new Set();
  const ideas = [];
  for (const item of value.slice(0, 64)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const title = ideaText(item.title, 160);
    const type = ideaText(item.type, 20).toUpperCase();
    const confidence = ideaText(item.confidence, 20).toUpperCase();
    if (!title || !TYPES.has(type) || !CONFIDENCES.has(confidence)) continue;
    const ticker = ideaText(item.ticker, 80);
    const key = `${type}:${ticker}:${title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rationale = ideaText(item.rationale || item.text);
    ideas.push({
      title, type, ticker, confidence, rationale, text: rationale,
      risk: ideaText(item.risk, 800),
      horizon: HORIZONS.get(ideaText(item.horizon, 30).toLowerCase()) || '',
      signals: Array.isArray(item.signals) ? item.signals.map(s => ideaText(s, 240)).filter(Boolean).slice(0, 8) : [],
      source: source === 'rules' ? 'rules' : 'llm',
    });
    if (ideas.length >= limit) break;
  }
  return ideas;
}

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// The idea list of an answer: an array holding objects, {ideas: [...]}, or one bare idea object (a model that copies the
// single-object template literally); null for any other shape, so a prose bracket like [3] is not taken for the answer.
const ideaList = value => Array.isArray(value) ? (value.some(plainObject) ? value : null)
  : plainObject(value) ? (Array.isArray(value.ideas) ? value.ideas : typeof value.title === 'string' ? [value] : null) : null;

export function parseIdeasResponse(text) {
  const { value } = extractJson(text, { accept: value => ideaList(value) !== null });
  const ideas = normalizeIdeas(ideaList(value));
  return ideas.length ? ideas : null;
}
