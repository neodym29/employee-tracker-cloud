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

test('the default font is a lightweight self-hosted geometric face', async () => {
  const [layout, appearance, css] = await Promise.all([
    readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../lib/appearance.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
  ]);

  assert.match(layout, /import \{ Outfit \} from 'next\/font\/google'/);
  assert.match(layout, /className=\{outfit\.variable\}/);
  assert.match(appearance, /id: 'system', label: 'Geometric'/);
  assert.match(css, /--app-font: var\(--font-outfit\)/);
  assert.match(css, /font-weight:200;/);
  assert.match(css, /\.nexusChatSidebar h1 \{ text-shadow:none; \}/);
});

test('navigation floats as a centered glass capsule and initials remain semantic text', async () => {
  const [css, home, menu] = await Promise.all([
    readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
    readFile(new URL('../app/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/components/AccountMenu.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(css, /\.siteHeader \{\s*width:min\(1080px,calc\(100% - 32px\)\)/);
  assert.match(css, /\.siteHeader::before \{/);
  assert.match(css, /@media \(max-width:900px\) \{\s*\.siteHeader/);
  assert.match(home, /<span className="heroInitial">K<\/span>now/);
  assert.match(home, /<span className="heroInitial">K<\/span>eep/);
  assert.match(menu, /<span>Profile<\/span>/);
});
