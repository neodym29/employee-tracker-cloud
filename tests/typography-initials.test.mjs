import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('enlarged initials cover headings and short UI copy without styling prose', async () => {
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  const rule = css.match(/main :where\(([^)]+)\)::first-letter\s*\{([^}]+)\}/);
  assert.ok(rule, 'shared initial-letter rule exists');
  for (const selector of ['h1', 'h2', 'h3', 'button', 'summary', 'label', '.projectUpdateSection header a']) {
    assert.ok(rule[1].split(',').includes(selector), `${selector} uses the shared style`);
  }
  assert.ok(!rule[1].split(',').includes('p'), 'paragraphs keep their normal typography');
  assert.match(rule[2], /text-transform:uppercase/);
});
