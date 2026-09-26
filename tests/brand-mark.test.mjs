import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('the shared header is the only logo on the homepage', async () => {
  const [layout, home] = await Promise.all([
    readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/page.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(layout, /<NexusMark className="logo" \/>/);
  assert.match(layout, /className="brandGyro"/);
  assert.doesNotMatch(home, /NexusMark|nexusLandingBrandMark|nexusLandingProjectIcon/);
});

test('the mark has 3D gyro motion that respects reduced-motion settings', async () => {
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.brandGyro\s*\{[^}]*perspective:/);
  assert.match(css, /@keyframes nexusGyro\s*\{/);
  assert.match(css, /@keyframes nexusOuterPulse\s*\{/);
  assert.match(css, /@keyframes nexusInnerPulse\s*\{/);
  assert.match(css, /62% \{ transform:rotate\(205deg\) scale\(\.14\)/);
  assert.match(css, /62% \{ transform:rotate\(-235deg\) scale\(\.2\)/);
  assert.match(css, /67% \{ transform:rotate\(245deg\) scale\(\.14\)/);
  assert.match(css, /67% \{ transform:rotate\(-270deg\) scale\(\.2\)/);
  assert.match(css, /@media \(prefers-reduced-motion:no-preference\)\s*\{[^}]*\.brandGyro \.logo\s*\{[^}]*animation: nexusGyro/);
});
