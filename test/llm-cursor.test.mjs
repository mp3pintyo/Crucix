// Cursor Agent CLI Provider — unit tests
// Uses Node.js built-in test runner (node:test) — no extra dependencies

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CursorProvider } from '../lib/llm/cursor.mjs';
import { createLLMProvider } from '../lib/llm/index.mjs';

describe('CursorProvider', () => {
  it('should set defaults correctly', () => {
    const provider = new CursorProvider({});
    assert.equal(provider.name, 'cursor');
    assert.equal(provider.model, 'auto');
    assert.equal(provider.isConfigured, true);
  });

  it('should accept custom model', () => {
    const provider = new CursorProvider({ model: 'composer-2.5' });
    assert.equal(provider.model, 'composer-2.5');
  });

  it('should create CursorProvider via createLLMProvider factory', () => {
    const p1 = createLLMProvider({ provider: 'cursor', model: 'auto' });
    assert.ok(p1 instanceof CursorProvider);
    assert.equal(p1.model, 'auto');

    const p2 = createLLMProvider({ provider: 'agent', model: 'auto' });
    assert.ok(p2 instanceof CursorProvider);
    assert.equal(p2.model, 'auto');
  });
});
