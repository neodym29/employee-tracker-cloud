import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/project-chat.ts', import.meta.url), 'utf8');
const actor = { id: '20', role: 'user', account_type: 'engineer' };

function loadChat(query, fetchImpl = async () => new Response(
  JSON.stringify({ answer: 'Scoped answer', actions: [] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
)) {
  const calls = [];
  const connection = {
    async query(sql, values = []) {
      calls.push({ target: 'client', sql, values });
      return query(sql, values, 'client');
    },
    release() {},
  };
  const pool = {
    async query(sql, values = []) {
      calls.push({ target: 'pool', sql, values });
      return query(sql, values, 'pool');
    },
    async connect() { return connection; },
  };
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === 'node:crypto') return crypto;
      if (specifier === './db') return { ensureSchema: async () => {}, getPool: () => pool };
      if (specifier === './project-files') return {
        PROJECT_FILE_TOMBSTONE_MEDIA_TYPE: 'application/x.project-tombstone',
        validateProjectFilePath(value) { return value; },
        validateProjectFileMediaType(value) { return value; },
        validateProjectFileContent(value) { return value; },
      };
      if (specifier === './projects') return {
        ProjectServiceError: class ProjectServiceError extends Error {
          constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; }
        },
        projectAccessSql(user, project = 'p', membership = 'access_membership') {
          return {
            join: `left join project_memberships ${membership} on ${membership}.project_id=${project}.id and ${membership}.user_id=${user} and ${membership}.membership_status='active'`,
            predicate: `(${project}.client_id=${user} or ${membership}.user_id=${user})`,
          };
        },
        RECORD_BODY_MAX_BYTES: 64 * 1024,
        RECORD_TITLE_MAX: 160,
      };
      throw new Error(`Unexpected import: ${specifier}`);
    },
    Buffer,
    URL,
    fetch: fetchImpl,
    AbortController,
    AbortSignal,
    TextDecoder,
    Response,
    setTimeout,
    clearTimeout,
    process: { env: { CHAT_BACKEND_URL: 'https://agent.example/chat', CHAT_BACKEND_TOKEN: 'test-token', NODE_ENV: 'test' } },
  });
  return { service: module.exports, calls };
}

test('pending actions are private to the member whose chat proposed them', async () => {
  const pending = { id: '7', action_type: 'update_file', input: {}, status: 'pending', actor_user_id: actor.id };
  const { service, calls } = loadChat(async (sql, values) => {
    if (/select p\.id from projects/i.test(sql)) return { rows: [{ id: '2' }] };
    if (/from project_chat_messages/i.test(sql)) return { rows: [] };
    if (/from project_agent_actions/i.test(sql)) return { rows: [pending] };
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await service.listProjectChat(actor, '2');
  assert.equal(result.actions.length, 1);
  const actionRead = calls.find((call) => /from project_agent_actions/i.test(call.sql));
  assert.match(actionRead.sql, /actor_user_id\s*=\s*\$2/i);
  assert.deepEqual(Array.from(actionRead.values), ['2', actor.id]);
});

test('a project member cannot confirm or cancel another member’s pending action', async () => {
  for (const operation of ['confirmProjectAgentAction', 'cancelProjectAgentAction']) {
    const { service, calls } = loadChat(async (sql) => {
      if (/^\s*(begin|rollback)\s*$/i.test(sql)) return { rows: [] };
      if (/select p\.id,p\.client_id/i.test(sql)) return { rows: [{ id: '2', client_id: actor.id }] };
      if (/project_agent_actions/i.test(sql)) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await assert.rejects(service[operation](actor, '2', '7'), (error) => error?.status === 404);
    const scopedMutation = calls.find((call) => /project_agent_actions/i.test(call.sql));
    assert.match(scopedMutation.sql, /actor_user_id\s*=\s*\$3/i, `${operation} must bind the action to its proposing actor`);
  }
});

test('chat submission rechecks active project access in the write transaction after the backend returns', async () => {
  let initialAuthorizationSeen = false;
  const { service, calls } = loadChat(async (sql, _values, target) => {
    if (target === 'pool' && /select distinct p\.id,p\.title,p\.description,p\.status/i.test(sql)) {
      initialAuthorizationSeen = true;
      return { rows: [{ id: '2', title: 'Scoped project', description: '', status: 'active' }] };
    }
    if (target === 'pool' && /from project_file_heads/i.test(sql)) return { rows: [] };
    if (target === 'pool' && /from project_chat_messages/i.test(sql)) return { rows: [] };
    if (target === 'client' && /^\s*(begin|rollback)\s*$/i.test(sql)) return { rows: [] };
    if (target === 'client' && /select (?:distinct )?p\.id/i.test(sql)) return { rows: [] }; // access was revoked while backend ran
    if (target === 'client' && /insert into project_chat_messages|insert into project_agent_actions/i.test(sql)) {
      assert.fail('revoked member must not persist chat or proposed actions');
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  await assert.rejects(service.submitProjectChat(actor, '2', { message: 'Please inspect it' }), (error) => error?.status === 404);
  assert.equal(initialAuthorizationSeen, true);
  assert.ok(calls.some((call) => call.target === 'client' && /project_memberships/i.test(call.sql)), 'write transaction must recheck centralized access');
  assert.ok(calls.some((call) => call.target === 'client' && /^\s*rollback\s*$/i.test(call.sql)));
});
