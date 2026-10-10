// Cursor Agent CLI Provider — uses the local `agent` CLI (Cursor Agent)
// Runs `agent -p --trust --mode ask --model <model>` with stdin input.
// Defaults to model 'auto'.

import { spawn } from 'child_process';
import { LLMProvider } from './provider.mjs';

export class CursorProvider extends LLMProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'cursor';
    this.model = config.model || 'auto';
  }

  get isConfigured() {
    return true;
  }

  async complete(systemPrompt, userMessage, opts = {}) {
    const budget = this.requestOptions(opts, { timeout: 90000 });
    const isWin = process.platform === 'win32';
    const [cmd, args] = isWin
      ? [process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', 'agent', '-p', '--trust', '--mode', 'ask', '--model', this.model]]
      : ['agent', ['-p', '--trust', '--mode', 'ask', '--model', this.model]];

    const input = systemPrompt ? `${systemPrompt}\n\n${userMessage}` : userMessage;

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        return reject(new Error(`Failed to spawn Cursor Agent CLI: ${err.message}`));
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        reject(new Error(`Cursor Agent CLI timed out after ${budget.timeout}ms`));
      }, budget.timeout);

      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Cursor Agent CLI error: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return;

        if (code !== 0) {
          const errMsg = stderr.trim() || stdout.trim() || `exited with code ${code}`;
          return reject(new Error(`Cursor Agent CLI error: ${errMsg}`));
        }

        resolve({
          text: stdout.trim(),
          usage: { inputTokens: 0, outputTokens: 0 },
          model: this.model,
        });
      });

      child.stdin.end(input);
    });
  }
}
