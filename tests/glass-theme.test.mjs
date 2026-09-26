import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('glass surfaces stay theme-aware and keep dark sidebar inputs legible', async () => {
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

  assert.match(css, /--glass-surface: color-mix\(in srgb, var\(--paper\)/);
  assert.match(css, /\.siteHeader \{[\s\S]*?backdrop-filter: blur\(24px\)/);
  assert.match(css, /\.nexusChatSearch input:not\(\[type='checkbox'\]\):not\(\[type='radio'\]\):not\(\[type='file'\]\) \{ color:#fff; background:rgba\(255,255,255,\.08\)/);
  assert.match(css, /@media \(prefers-reduced-transparency: reduce\)/);
  assert.match(css, /h1,\.nexusLandingCopy h1 \{ font-weight: 380/);
});
