import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [new URL('../lib/chats.ts', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [{
    name: 'chat-test-dependencies',
    setup(plugin) {
      plugin.onResolve({ filter: /^\.\/(api|db|profiles)$/ }, ({ path }) => ({ path, namespace: 'chat-test' }));
      plugin.onLoad({ filter: /.*/, namespace: 'chat-test' }, ({ path }) => ({
        contents: path === './db'
          ? 'export function getPool() { return globalThis.__chatTestPool; }'
          : path === './profiles'
            ? 'export async function ensureProfilesSchema() {}'
            : 'export class ApiError extends Error { constructor(message,status,code) { super(message); this.status=status; this.code=code; } }',
        loader: 'js',
      }));
    },
  }],
});
const chats = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const session = { id: '12', account_type: 'engineer', company_id: '1' };

function poolFor({ kind = 'group', isAdmin = false, rows = [] } = {}) {
  const queries = [];
  globalThis.__chatTestPool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('create table if not exists chat_conversations')) return { rows: [] };
      if (sql.includes('from chat_conversations c join chat_conversation_members m')) return { rows: [{ id: '5', kind, is_admin: isAdmin }] };
      if (sql.includes('delete from chat_conversations c')) return { rows: [{ id: '5' }] };
      if (sql.includes('update chat_conversation_members set is_admin=true')) return { rows: [{ user_id: params[1] }] };
      if (sql.includes('from chat_messages msg join app_users u')) return { rows };
      return { rows: [] };
    },
  };
  return queries;
}

test('non-admin members cannot delete a group for everyone', async () => {
  const queries = poolFor();
  await assert.rejects(chats.deleteChat(session, '5'), (error) => error.status === 403);
  assert.equal(queries.some(({ sql }) => sql.includes('delete from chat_conversations')), false);
});

test('a group admin deletes the conversation for every member', async () => {
  const queries = poolFor({ isAdmin: true });
  assert.deepEqual(await chats.deleteChat(session, '5'), { id: '5', deletedForEveryone: true });
  const deletion = queries.find(({ sql }) => sql.includes('delete from chat_conversations c'));
  assert.ok(deletion);
  assert.match(deletion.sql, /m\.is_admin/);
  assert.deepEqual(deletion.params, ['5', '12']);
  assert.equal(queries.some(({ sql }) => sql.includes('set hidden_at=now()')), false);
});

test('deleting a DM only hides it for the requesting member', async () => {
  const queries = poolFor({ kind: 'dm' });
  assert.deepEqual(await chats.deleteChat(session, '5'), { id: '5', deletedForEveryone: false });
  assert.equal(queries.some(({ sql }) => sql.includes('delete from chat_conversations')), false);
  assert.ok(queries.some(({ sql }) => sql.includes('set hidden_at=now()')));
});

test('only group admins can promote another member', async () => {
  poolFor();
  await assert.rejects(chats.promoteGroupAdmin(session, '5', '77'), (error) => error.status === 403);
  const queries = poolFor({ isAdmin: true });
  assert.deepEqual(await chats.promoteGroupAdmin(session, '5', '77'), { id: '77' });
  assert.ok(queries.some(({ sql }) => sql.includes('set is_admin=true') && sql.includes('conversation_id=$1 and user_id=$2')));
});

test('group replies are returned in the main chronological message list', async () => {
  const reply = { id: '2', body: 'Reply', parent_message_id: '1' };
  const root = { id: '1', body: 'First', parent_message_id: null };
  const queries = poolFor({ rows: [reply, root] });
  assert.deepEqual(await chats.listChatMessages(session, '5'), [root, reply]);
  const listQuery = queries.find(({ sql }) => sql.includes('from chat_messages msg join app_users u'));
  assert.ok(listQuery);
  assert.doesNotMatch(listQuery.sql, /parent_message_id is null/);
  assert.deepEqual(listQuery.params, ['5', '12']);
});
