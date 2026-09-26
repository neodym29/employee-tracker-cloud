import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('app publishes a real favicon through Next metadata', async () => {
  const svg = await readFile(new URL('app/icon.svg', root), 'utf8');

  assert.match(svg, /^<svg\b/);
  assert.match(svg, /aria-label="Neo-Nexus"/);
  assert.match(svg, /cx="32" cy="32" r="3\.5"/);
  assert.match(svg, /stroke="currentColor"/);
  assert.doesNotMatch(svg, /<rect\b|#[0-9a-f]{6}"/i);
  assert.match(svg, /prefers-reduced-motion: no-preference/);
  assert.match(svg, /animation: outerPulse 10s linear infinite/);
  assert.match(svg, /animation: innerPulse 10s linear infinite/);
  assert.doesNotMatch(svg, /<text\b/);
});

test('Epicenter theme and app logo respect reduced motion', async () => {
  const [theme, css, mark] = await Promise.all([
    readFile(new URL('lib/appearance.ts', root), 'utf8'),
    readFile(new URL('app/globals.css', root), 'utf8'),
    readFile(new URL('app/components/NexusMark.tsx', root), 'utf8'),
  ]);
  assert.match(theme, /id: 'epicenter', label: 'Epicenter'/);
  assert.match(css, /html\[data-theme='epicenter'\] \{ color-scheme:dark/);
  assert.match(css, /html\[data-theme='epicenter'\] \.projectsSidebar/);
  assert.match(css, /@media \(prefers-reduced-motion:no-preference\)/);
  assert.match(mark, /className="nexusMarkOuter"/);
  assert.match(mark, /className="nexusMarkInner"/);
  assert.match(mark, /stroke="currentColor"/);
  assert.doesNotMatch(mark, /<rect\b|#[0-9a-f]{6}"/i);
  assert.doesNotMatch(css.match(/\.logo \{[^}]*\}/)?.[0] ?? '', /box-shadow|background|border-radius/);
});
