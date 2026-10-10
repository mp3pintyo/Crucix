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

// Scan balanced arrays instead of a greedy regex that also consumes surrounding prose.
export function parseIdeasResponse(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 128000) return null;
  const raw = text.trim();
  try {
    const parsed = JSON.parse(raw);
    // A model that copies the single-object template literally returns one bare idea object.
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.ideas) ? parsed.ideas : parsed && typeof parsed === 'object' ? [parsed] : null;
    const ideas = normalizeIdeas(list);
    if (ideas.length) return ideas;
  } catch { /* Try fenced or prose-wrapped JSON below. */ }
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  for (let start = 0; start < cleaned.length; start++) {
    if (cleaned[start] !== '[') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < cleaned.length; end++) {
      const char = cleaned[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '[') depth++;
      else if (char === ']' && --depth === 0) {
        try {
          const ideas = normalizeIdeas(JSON.parse(cleaned.slice(start, end + 1)));
          if (ideas.length) return ideas;
        } catch { /* A prose bracket or malformed candidate is not an idea array. */ }
        start = end;
        break;
      }
    }
    if (depth > 0) return null;
  }
  return null;
}
