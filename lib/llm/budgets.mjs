// Explicit request budgets keep both remote costs and slow local inference bounded.
export const LLM_BUDGETS = Object.freeze({
  ideas: Object.freeze({ tokens: 4096, timeout: 90000, minTokens: 128, maxTokens: 16384 }),
  alerts: Object.freeze({ tokens: 800, timeout: 30000, minTokens: 128, maxTokens: 4096 }),
  briefing: Object.freeze({ tokens: 1200, timeout: 60000, minTokens: 128, maxTokens: 8192 }),
});

// Scraped OSINT text in the alert prompt is untrusted and unbounded at the source:
// at most maxSignals signals, each free-text field cut to maxTextChars.
export const ALERT_CONTEXT_LIMITS = Object.freeze({ maxSignals: 40, maxTextChars: 500 });

export function boundedInteger(value, fallback, name, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const validType = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value));
  const number = validType ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

export function getLLMBudget(config = {}, purpose = 'ideas') {
  const defaults = LLM_BUDGETS[purpose];
  if (!defaults) throw new RangeError(`Unknown LLM budget: ${purpose}`);
  const prefix = purpose === 'alerts' ? 'alert' : purpose;
  return {
    maxTokens: boundedInteger(config[`${prefix}MaxTokens`], defaults.tokens, `${prefix}MaxTokens`, defaults.minTokens, defaults.maxTokens),
    timeout: boundedInteger(config[`${prefix}TimeoutMs`], defaults.timeout, `${prefix}TimeoutMs`, 1000, 360000),
  };
}

export function requestOptions(opts = {}, defaults = {}) {
  return {
    maxTokens: boundedInteger(opts.maxTokens, defaults.maxTokens ?? 4096, 'maxTokens', 1, 65536),
    timeout: boundedInteger(opts.timeout, defaults.timeout ?? 60000, 'timeout', 1, 360000),
  };
}

export function reasoningEffort(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!['none', 'minimal', 'low', 'medium', 'high'].includes(value)) {
    throw new RangeError('reasoningEffort must be none, minimal, low, medium, or high');
  }
  return value;
}
