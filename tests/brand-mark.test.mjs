import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('the shared header is the only logo on the homepage', async () => {
  const [layout, home] = await Promise.all([
    readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/page.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(layout, /<NexusMark className="logo" \/>/);
  assert.doesNotMatch(home, /NexusMark|nexusLandingBrandMark|nexusLandingProjectIcon/);
});
