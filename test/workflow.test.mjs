import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Checkouts on Windows use CRLF line endings; normalise so the patterns are platform independent.
const workflow = readFileSync(new URL('../.github/workflows/docker-publish.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('workflow actions are pinned to full commit SHAs with an exact version comment', () => {
  const uses = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)[ \t]*(?:#[ \t]*(\S+))?/gm)];
  assert.ok(uses.length >= 7, 'Every action step is inspected');
  for (const [, reference, comment] of uses) {
    assert.match(reference, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${reference} must be pinned to a commit SHA`);
    assert.match(comment ?? '', /^v\d+\.\d+\.\d+$/, `${reference} needs an exact version comment`);
  }
});

test('runner images are pinned so a -latest migration cannot change release builds', () => {
  assert.doesNotMatch(workflow, /-latest\b/);
  const runners = [...workflow.matchAll(/\b(?:ubuntu|windows)-\d{2,4}(?:\.\d+)?\b/g)].map(match => match[0]);
  assert.ok(runners.length >= 3, 'Matrix and publish runners are explicit');
});

test('the Linux-only dependency audit targets a runner that exists in the matrix', () => {
  const matrix = workflow.match(/^\s*os:\s*\[([^\]]+)\]/m)?.[1].split(',').map(label => label.trim());
  const audit = workflow.match(/if:\s*matrix\.os == '([^']+)'/)?.[1];
  assert.ok(matrix?.length >= 2, 'The OS matrix is declared inline');
  assert.ok(matrix.includes(audit), `npm audit must run on one of: ${matrix.join(', ')}`);
});

test('releases and the default branch still trigger the workflow itself', () => {
  assert.match(workflow, /^on:\s*\n(?:.*\n)*?\s+push:\s*\n\s+branches:\s*\[master\]\s*\n\s+tags:\s*\['v\*'\]/m);
  assert.match(workflow, /^\s+workflow_dispatch:/m);
});

test('standalone executable build and verification run in quality matrix', () => {
  assert.match(workflow, /npm run build:exe/);
  assert.match(workflow, /npm run verify:exe/);
});
