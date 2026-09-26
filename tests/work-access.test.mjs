import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('work search requires active project access and chat membership', async () => {
  const search = await readFile(new URL('../lib/work-search.ts', import.meta.url), 'utf8');
  const projects = await readFile(new URL('../lib/projects.ts', import.meta.url), 'utf8');
  assert.match(search, /projectAccessSql\('\$1'\)/);
  assert.match(search, /join chat_conversation_members mine on mine\.conversation_id=c\.id and mine\.user_id=\$1/);
  assert.match(search, /mine\.cleared_at is null or msg\.created_at>mine\.cleared_at/);
  assert.match(search, /msg\.deleted_at is null/);
  assert.match(projects, /membership_status='active'/);
});
