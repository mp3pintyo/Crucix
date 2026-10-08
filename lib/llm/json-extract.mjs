// One bounded JSON extractor for every model answer (ideas, briefing, alerts). It only locates strict JSON: no key re-quoting, quote
// swapping, comments, trailing-comma removal or nested-wrapper search, so a broken answer takes the rule fallback instead of a guess.
// The caller's `accept` decides the shape, so prose or an echoed input row that happens to be JSON does not win over the real answer.

const FENCE = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi;

/**
 * The first strict-JSON value of a model answer that `accept` takes. On failure `reason` describes the model's first JSON-looking
 * attempt (the whole text, else the first '{' or '['): 'wrong_shape' when it parsed but was not accepted, 'invalid_json' when it did
 * not parse or never closed; so a broken answer that merely contains a parsable [1] still reads as invalid JSON.
 * @returns {{value: any, reason: null|'empty'|'too_long'|'no_json'|'invalid_json'|'wrong_shape'}} never throws
 */
export function extractJson(text, { maxLength = 128000, accept = () => true, maxCandidates = 64 } = {}) {
  if (typeof text !== 'string') return { value: null, reason: 'empty' };
  if (text.length > maxLength) return { value: null, reason: 'too_long' };
  const raw = text.trim(); // trim() also drops a BOM: U+FEFF is ECMAScript whitespace
  if (!raw) return { value: null, reason: 'empty' };
  // 'accepted' with the value, 'parsed' when JSON but not accepted, null when not JSON.
  const attempt = candidate => {
    let value;
    try { value = JSON.parse(candidate); } catch { return null; }
    try { return accept(value) ? { value } : 'parsed'; } catch { return 'parsed'; }
  };
  // The whole text first: a literal <think> or fence inside a JSON string must survive.
  const whole = attempt(raw);
  if (whole?.value !== undefined) return { value: whole.value, reason: null };
  let first = whole ? 'wrong_shape' : null;
  let cleaned = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, ' ');
  // Some local templates emit the opening <think> in the prompt, so the answer starts with reasoning and a lone closing tag.
  const close = cleaned.search(/<\/think>/i);
  if (close >= 0 && !/<think\b/i.test(cleaned.slice(0, close))) cleaned = cleaned.slice(close + 8);
  cleaned = cleaned.trim();
  let fences = 0;
  for (const match of cleaned.matchAll(FENCE)) {
    if (++fences > maxCandidates) break;
    const fenced = attempt(match[1].trim());
    if (fenced?.value !== undefined) return { value: fenced.value, reason: null };
  }
  // String-aware balanced candidates; an unbalanced start (prose bracket, truncated answer) moves on to the next start rather than
  // ending the scan, and the start cap keeps a pathological '[[[[...' input linear in practice.
  let starts = 0;
  for (let start = 0; start < cleaned.length && starts < maxCandidates; start++) {
    if (cleaned[start] !== '{' && cleaned[start] !== '[') continue;
    starts++;
    let depth = 0, quoted = false, escaped = false, end = start;
    for (; end < cleaned.length; end++) {
      const char = cleaned[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if ((char === '}' || char === ']') && --depth === 0) break;
    }
    if (depth > 0) { first ??= 'invalid_json'; continue; }
    const found = attempt(cleaned.slice(start, end + 1));
    if (found?.value !== undefined) return { value: found.value, reason: null };
    first ??= found ? 'wrong_shape' : 'invalid_json';
    start = end; // a rejected candidate is skipped whole: no search inside a wrapper that did not fit
  }
  return { value: null, reason: first ?? 'no_json' };
}
