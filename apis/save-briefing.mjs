#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fullBriefing } from './briefing.mjs';

function formatTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z');
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runsDir = process.env.RUNS_DIR || (existsSync(join(ROOT, 'runs')) ? join(ROOT, 'runs') : join(homedir(), '.crucix', 'runs'));
await mkdir(runsDir, { recursive: true });

const data = await fullBriefing();
const json = JSON.stringify(data, null, 2);
const timestamp = formatTimestamp(new Date(data.crucix.timestamp));
const runFile = join(runsDir, `briefing_${timestamp}.json`);
const latestFile = join(runsDir, 'latest.json');

await writeFile(runFile, json, 'utf8');
await writeFile(latestFile, json, 'utf8');

console.error(`[Crucix] Saved UTF-8 briefing to ${runFile}`);
console.log(json);
