// LLM Factory — creates the configured provider or returns null

import { AnthropicProvider } from "./anthropic.mjs";
import { OpenAIProvider } from "./openai.mjs";
import { OpenRouterProvider } from "./openrouter.mjs";
import { GeminiProvider } from "./gemini.mjs";
import { CodexProvider } from "./codex.mjs";
import { MiniMaxProvider } from "./minimax.mjs";
import { MistralProvider } from "./mistral.mjs";
import { OllamaProvider } from "./ollama.mjs";
import { GrokProvider } from "./grok.mjs";
import { OpenAICompatibleProvider } from "./openai-compatible.mjs";
import { CursorProvider } from "./cursor.mjs";

export { LLMProvider } from "./provider.mjs";
export { AnthropicProvider } from "./anthropic.mjs";
export { OpenAIProvider } from "./openai.mjs";
export { OpenRouterProvider } from "./openrouter.mjs";
export { GeminiProvider } from "./gemini.mjs";
export { CodexProvider } from "./codex.mjs";
export { CursorProvider } from "./cursor.mjs";
export { MiniMaxProvider } from "./minimax.mjs";
export { MistralProvider } from "./mistral.mjs";
export { OllamaProvider } from "./ollama.mjs";
export { GrokProvider } from "./grok.mjs";
export { OpenAICompatibleProvider } from "./openai-compatible.mjs";

/**
 * Create an LLM provider based on config.
 * @param {{ provider: string|null, apiKey: string|null, model: string|null }} llmConfig
 * @returns {LLMProvider|null}
 */
export function createLLMProvider(llmConfig) {
  if (!llmConfig?.provider) return null;

  const { provider } = llmConfig;

  switch (provider.toLowerCase()) {
    case "anthropic":
      return new AnthropicProvider(llmConfig);
    case "openai":
      return new OpenAIProvider(llmConfig);
    case "openai-compatible":
      return new OpenAICompatibleProvider({ ...llmConfig, baseUrl: llmConfig.compatibleBaseUrl });
    case "openrouter":
      return new OpenRouterProvider(llmConfig);
    case "gemini":
      return new GeminiProvider(llmConfig);
    case "codex":
      return new CodexProvider(llmConfig);
    case "cursor":
    case "agent":
      return new CursorProvider(llmConfig);
    case "minimax":
      return new MiniMaxProvider(llmConfig);
    case "mistral":
      return new MistralProvider(llmConfig);
    case "ollama":
      return new OllamaProvider(llmConfig);
    case 'grok':
      return new GrokProvider(llmConfig);
    default:
      console.warn(
        `[LLM] Unknown provider "${provider}". LLM features disabled.`,
      );
      return null;
  }
}
