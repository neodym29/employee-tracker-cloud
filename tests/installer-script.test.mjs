import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const route = readFileSync(new URL('../app/api/installer/route.ts', import.meta.url), 'utf8');

for (const browser of ['google-chrome', 'chromium', 'brave-browser', 'microsoft-edge', 'opera']) {
  assert.match(route, new RegExp(browser), `installer should detect/install extension for ${browser}`);
}

for (const policyDir of [
  '/etc/opt/chrome/policies/managed',
  '/etc/chromium/policies/managed',
  '/etc/brave/policies/managed',
  '/etc/opt/edge/policies/managed',
  '/etc/opt/opera/policies/managed',
]) {
  assert.match(route, new RegExp(policyDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `installer should write policy to ${policyDir}`);
}

for (const expected of [
  'manifest.json',
  'background.js',
  'content.js',
  '/browser-state',
  '/browser-click',
  'ExtensionSettings',
  'external_crx',
  'external_version',
]) {
  assert.match(route, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `installer should include ${expected}`);
}
