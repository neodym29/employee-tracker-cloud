import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from 'esbuild';

const session = { id: '12', company_id: '7', account_type: 'engineer' };
const bundle = await build({
  entryPoints: [new URL('../lib/chats.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'node', write: false,
  plugins: [{ name: 'isolation-test-dependencies', setup(plugin) {
    plugin.onResolve({ filter: /^\.\/(api|db|profiles)$/ }, ({ path }) => ({ path, namespace: 'test' }));
    plugin.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({
      contents: path === './db' ? 'export function getPool() { return globalThis.__isolationPool; }'
        : path === './profiles' ? 'export async function ensureProfilesSchema() {}'
          : 'export class ApiError extends Error { constructor(message,status,code) { super(message); this.status=status; this.code=code; } }',
      loader: 'js',
    }));
  } }],
});
const chats = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function recordingPool() {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('from chat_conversations c join chat_conversation_members m')) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
    async connect() { return { ...db, release() {} }; },
  };
  globalThis.__isolationPool = db;
  return calls;
}

test('people and conversation lists are company-scoped', async () => {
  const calls = recordingPool();
  await chats.listChatPeople(session);
  await chats.listChats(session);
  const people = calls.find(call => call.sql.includes('from app_users u left join user_social_profiles'));
  const conversations = calls.find(call => call.sql.includes('from chat_conversations c join chat_conversation_members mine'));
  assert.match(people.sql, /u\.company_id=\$2/);
  assert.deepEqual(people.params, ['12', '7']);
  assert.match(conversations.sql, /c\.company_id=\$2/);
  assert.deepEqual(conversations.params, ['12', '7']);
});

test('a cross-company participant cannot be added to a DM', async () => {
  const calls = recordingPool();
  await assert.rejects(chats.createChat(session, { kind: 'dm', userId: '99' }), error => error.status === 400);
  const approval = calls.find(call => call.sql.includes('select id from app_users where id=any'));
  assert.match(approval.sql, /company_id=\$2/);
  assert.deepEqual(approval.params, [['99'], '7']);
  assert.equal(calls.some(call => call.sql.includes('insert into chat_conversations')), false);
});

test('project access requires the owner and actor to share a company', async () => {
  const source = await readFile(new URL('../lib/projects.ts', import.meta.url), 'utf8');
  assert.match(source, /project_owner\.company_id=project_actor\.company_id/);
  assert.match(source, /owner\.company_id=\$2 and p\.status<>'archived'/);
  assert.match(source, /where id=\$1 and company_id=\$10 and account_type='client'/);
});
