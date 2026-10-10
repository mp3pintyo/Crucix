// Anthropic Claude Provider — raw fetch, no SDK

import { LLMProvider } from './provider.mjs';

// The Messages endpoint of ANTHROPIC_BASE_URL (an origin, a /v1 path or the full /v1/messages path); the Anthropic API by default.
export function messagesUrl(raw = 'https://api.anthropic.com') {
  let url;
  try { url = new URL(raw); } catch { throw new TypeError('ANTHROPIC_BASE_URL must be an absolute HTTP or HTTPS URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('ANTHROPIC_BASE_URL must use HTTP or HTTPS without credentials, query, or fragment');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/messages$/.test(path) ? path : /\/v1$/.test(path) ? `${path}/messages` : `${path}/v1/messages`;
  return url.toString();
}

// The text blocks of a Messages response, joined; thinking and other blocks are skipped.
export function messageText(data, model) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
  const finishReason = typeof data?.stop_reason === 'string' ? data.stop_reason : null;
  if (!text.trim() && finishReason === 'max_tokens') {
    throw new Error(`anthropic ${model}: no text generated (stop_reason=max_tokens); thinking exhausted the token budget. Increase the configured budget.`);
  }
  return { text, finishReason };
}

export class AnthropicProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.name = 'anthropic';
    this.apiKey = config.apiKey;
    // ANTHROPIC_AUTH_TOKEN is sent as a bearer token instead of x-api-key (gateways and routers in front of the Messages API).
    this.authToken = config.authToken || null;
    if (this.apiKey && this.authToken) throw new TypeError('Set either LLM_API_KEY or ANTHROPIC_AUTH_TOKEN for the anthropic provider, not both');
    this.model = config.model || 'claude-sonnet-4-6';
    this.url = messagesUrl(config.baseUrl || undefined);
  }

  get isConfigured() { return !!(this.apiKey || this.authToken); }

  async complete(systemPrompt, userMessage, opts = {}) {
    const budget = this.requestOptions(opts);
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : { 'x-api-key': this.apiKey }),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: budget.maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: AbortSignal.timeout(budget.timeout),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${err.substring(0, 200)}`);
    }

    const data = await res.json();

    return {
      ...messageText(data, this.model),
      usage: {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
      },
      model: data.model || this.model,
    };
  }
}
