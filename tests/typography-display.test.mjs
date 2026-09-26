import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('the geometric display font covers headings and short UI copy, not prose', async () => {
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  const rule = css.match(/main :where\(([^)]+)\)\s*\{([^}]+)\}/);
  assert.ok(rule, 'shared display-font rule exists');
  for (const selector of ['h1', 'h2', 'h3', 'button', 'summary', 'label', '.projectUpdateSection header a', '.nexusNoSelection strong', '.nexusConversationText strong']) {
    assert.ok(rule[1].split(',').includes(selector), `${selector} uses the shared style`);
  }
  assert.ok(!rule[1].split(',').includes('p'), 'paragraphs keep their normal typography');
  assert.match(rule[2], /font-family:'Neo Nexus UI',var\(--app-font\)/);
  assert.match(css, /:is\(\.siteHeader \.brand > span:last-child,main h1,main h2,main h3\)\s*\{\s*font-family:'Neo Nexus Display'/);
  assert.match(rule[2], /text-transform:uppercase/);
  assert.doesNotMatch(css, /::first-letter/);
});

test('the display face is a real bundled font, not a screenshot', async () => {
  const [font, uiFont, css] = await Promise.all([
    readFile(new URL('../public/fonts/neo-nexus-display.ttf', import.meta.url)),
    readFile(new URL('../public/fonts/neo-nexus-ui.ttf', import.meta.url)),
    readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
  ]);
  assert.equal(font.subarray(0, 4).toString('hex'), '00010000');
  assert.equal(uiFont.subarray(0, 4).toString('hex'), '00010000');
  assert.ok(font.length > 4000);
  assert.ok(uiFont.length > 4000);
  assert.match(css, /url\('\/fonts\/neo-nexus-display\.ttf\?v=2'\)/);
  assert.match(css, /url\('\/fonts\/neo-nexus-ui\.ttf\?v=2'\)/);
});
