import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('public shell is a simple files product rather than an operations route directory', async () => {
  const layout = await read('app/layout.tsx');
  const home = await read('app/page.tsx');

  assert.match(layout, /Trace/);
  assert.match(layout, /href="\/login"[^>]*>Sign in/);
  for (const noisyRoute of ['Company registration', 'Employee signup', 'Employee setup', 'Health']) {
    assert.doesNotMatch(layout, new RegExp(noisyRoute, 'i'));
  }
  assert.doesNotMatch(layout, />\s*Approve\s*</i);

  assert.match(home, /Every AI edit/i);
  assert.match(home, /Nothing else/i);
  assert.match(home, /currentSession/);
  assert.match(home, /account_type\s*===\s*'admin'[\s\S]*\/admin\/approve/);
  assert.match(home, /else if \(session\)[\s\S]*\/projects/);
  assert.doesNotMatch(home, /href="\/dashboard">Open dashboard/i);
  assert.match(home, /changePreview/);
  assert.match(home, /Hermes|Codex/);
  for (const noisyConcept of ['Database', 'DNS', 'register company', 'first admin', 'Operations']) {
    assert.doesNotMatch(home, new RegExp(noisyConcept, 'i'));
  }
});

test('dashboard prioritizes a compact file-change feed', async () => {
  const dashboard = await read('app/dashboard/DashboardClient.tsx');
  assert.match(dashboard, /dashboardShell/);
  assert.match(dashboard, /changeFeed/);
  assert.match(dashboard, /Recent changes/);
  assert.match(dashboard, /Connected agents/);
  assert.doesNotMatch(dashboard, /Daily files-only summary/);
  assert.doesNotMatch(dashboard, /Files-agent devices/);
});

test('responsive visual system includes simple mobile navigation and feed rows', async () => {
  const css = await read('app/globals.css');
  assert.match(css, /--canvas:\s*#f4f2ed/i);
  assert.match(css, /\.changePreview/);
  assert.match(css, /\.changeFeed/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /prefers-reduced-motion/);
}
);
