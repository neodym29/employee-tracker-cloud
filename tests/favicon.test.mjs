import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('app publishes a real favicon through Next metadata', async () => {
  const svg = await readFile(new URL('app/icon.svg', root), 'utf8');

  assert.match(svg, /^<svg\b/);
  assert.match(svg, /aria-label="Neo-Nexus"/);
  assert.match(svg, /cx="32" cy="32" r="6"/);
  assert.match(svg, /a22 22 0 0 1 40 0/);
  assert.doesNotMatch(svg, /<text\b/);
});
