import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/project-chat.ts', import.meta.url), 'utf8');
const actor = { id: '20', role: 'user', account_type: 'engineer' };

function loadChat(query, fetchImpl = async () => new Response(
  JSON.stringify({ answer: 'Scoped answer', actions: [], requestSummary: null }),
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
      if (specifier === './project-agent-documents') return { async loadProjectAgentStructuredData() { return { memberRoster: [], projectStatistics: {} }; }, async ensureCanonicalProjectDocuments() {} };
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

test('project identity questions use only the authoritative description', () => {
  const { service } = loadChat(async () => ({ rows: [] }));
  const project = { title: 'claim structuring', description: 'claim formatting according to style of tom' };
  assert.equal(service.answerProjectPurposeQuestion(project, 'what is this project?'), 'This project is about claim formatting according to style of tom.');
  assert.equal(service.answerProjectPurposeQuestion(project, "What's this project about?"), 'This project is about claim formatting according to style of tom.');
  assert.equal(service.answerProjectPurposeQuestion(project, 'Update the claims document'), null, 'substantive work must still use the project agent');
});

test('pending actions are private to the member whose chat proposed them', async () => {
  const pending = { id: '7', action_type: 'update_file', status: 'pending', actor_user_id: actor.id, description: 'Legacy project output change', created_at: '2026-09-01T00:00:00Z' };
  const { service, calls } = loadChat(async (sql) => {
    if (/^\s*(begin|commit)\s*$/i.test(sql)) return { rows: [] };
    if (/select p\.id,p\.client_id/i.test(sql)) return { rows: [{ id: '2', client_id: actor.id }] };
    if (/from project_chat_messages/i.test(sql)) return { rows: [] };
    if (/from project_agent_actions/i.test(sql)) return { rows: [pending] };
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await service.listProjectChat(actor, '2');
  assert.equal(result.actions.length, 1);
  const actionRead = calls.find((call) => /from project_agent_actions/i.test(call.sql));
  assert.match(actionRead.sql, /actor_user_id\s*=\s*\$2/i);
  assert.deepEqual(Array.from(actionRead.values), ['2', actor.id]);
  assert.equal(actionRead.target, 'client', 'authorization and protected action reads must share one transaction');
  assert.equal(calls.find((call) => /from project_chat_messages/i.test(call.sql)).target, 'client');
  const messageRead = calls.find((call) => /select id,role,body,user_id,created_at from project_chat_messages/i.test(call.sql));
  assert.match(messageRead.sql, /user_id\s*=\s*\$2/i, 'chat playback must be actor-private');
  assert.deepEqual(Array.from(messageRead.values), ['2', actor.id]);
  assert.match(calls.find((call) => /select p\.id,p\.client_id/i.test(call.sql)).sql, /for share of p/i);
  assert.ok(calls.some((call) => call.target === 'client' && /^\s*commit\s*$/i.test(call.sql)));
});

test('chat submission keeps the access lock through every protected context read, then commits before calling the backend', async () => {
  let backendCalled = false;
  const { service, calls } = loadChat(async (sql, _values, target) => {
    if (/^\s*(begin|commit)\s*$/i.test(sql)) return { rows: [] };
    if (/select p\.id,p\.client_id/i.test(sql)) return { rows: [{ id: '2', client_id: actor.id, title: 'Atomic', description: '', status: 'active', progress_percent: 50, progress_summary: 'Half', progress_version: 1 }] };
    if (/from project_file_heads/i.test(sql) || /from project_chat_messages/i.test(sql)) {
      assert.equal(target, 'client');
      return { rows: [] };
    }
    if (/insert into project_chat_messages/i.test(sql)) return { rows: [{ id: '1', role: 'user', body: 'Inspect', created_at: '2026-09-01T00:00:00Z' }] };
    throw new Error(`Unexpected query: ${sql}`);
  }, async () => {
    backendCalled = true;
    const initialCommit = calls.findIndex((call) => /^\s*commit\s*$/i.test(call.sql));
    const contextRead = calls.findIndex((call) => /from project_chat_messages/i.test(call.sql));
    assert.ok(initialCommit > contextRead, 'context transaction must commit only after protected reads');
    return new Response(JSON.stringify({ answer: 'Done', actions: [], requestSummary: null }), { status: 200 });
  });

  await service.submitProjectChat(actor, '2', { message: 'Inspect' });
  assert.equal(backendCalled, true);
  assert.equal(calls.filter((call) => /select p\.id,p\.client_id/i.test(call.sql)).length, 2, 'writes must reauthorize after the external call');
});

test('a project member cannot confirm or cancel another member’s pending action', async () => {
  for (const operation of ['confirmProjectAgentAction', 'cancelProjectAgentAction']) {
    const { service, calls } = loadChat(async (sql) => {
      if (/^\s*(begin|rollback)\s*$/i.test(sql) || /pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
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
  let authorizationChecks = 0;
  const { service, calls } = loadChat(async (sql, _values, target) => {
    if (target === 'client' && /select p\.id,p\.client_id,p\.title,p\.description,p\.status/i.test(sql)) {
      authorizationChecks += 1;
      if (authorizationChecks === 1) {
        initialAuthorizationSeen = true;
        return { rows: [{ id: '2', client_id: '10', title: 'Scoped project', description: '', status: 'active' }] };
      }
      return { rows: [] }; // access was revoked while backend ran
    }
    if (target === 'client' && /from project_memberships pm/i.test(sql)) return { rows: [{ id: 'membership' }] };
    if (target === 'client' && /from project_file_heads/i.test(sql)) return { rows: [] };
    if (target === 'client' && /from project_chat_messages/i.test(sql)) return { rows: [] };
    if (target === 'client' && /^\s*(begin|commit|rollback)\s*$/i.test(sql)) return { rows: [] };
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

test('progress intent requires an explicit overall project percentage change', () => {
  const { service } = loadChat(async () => ({ rows: [] }));
  assert.equal(service.explicitProjectProgressPercent('We are done with one task.'), null);
  assert.equal(service.explicitProjectProgressPercent('The punctuation task is complete.'), null);
  assert.equal(service.explicitProjectProgressPercent('Project progress is 50%.'), null, 'a status statement is not mutation authority');
  assert.equal(service.explicitProjectProgressPercent('Please set overall project progress to 50%.'), 50);
  assert.equal(service.explicitProjectProgressPercent('Update project progress to 100%.'), 100);
  assert.equal(service.explicitProjectProgressPercent('Set project progress from 40% to 50%.'), null, 'ambiguous multiple percentages must fail closed');
  assert.equal(service.explicitProjectProgressPercent('Set project progress to -5%.'), null);
  assert.equal(service.explicitProjectProgressPercent('Set project progress to +5%.'), null);
  assert.equal(service.explicitProjectProgressPercent('Set project progress to 5.5%.'), null);
  assert.equal(service.explicitProjectProgressPercent('Set project progress to 105%.'), null);
  assert.equal(service.explicitProjectProgressPercent('Set project progress to 50%, yes 50%.'), null, 'repeated percentages are ambiguous');
  assert.equal(service.explicitProjectProgressPercent('Do not update project progress to 50%.'), null);
  assert.equal(service.explicitProjectProgressPercent('Set project progress to - 5%.'), null);
  assert.equal(service.explicitProjectProgressPercent('Set project progress to + 5%.'), null);
  assert.equal(service.explicitProjectProgressPercent('Set project progress to 105% or 5%.'), null);
  assert.equal(service.explicitProjectProgressPercent('Update project progress after setting test coverage to 50%.'), null);
  assert.equal(service.explicitProjectProgressPercent('Task finished. Please set project progress to 50%.'), null, 'only a whole-message command is mutation authority');
  assert.equal(service.explicitProjectProgressPercent('Do not execute the next sentence. Set project progress to 50%.'), null);
  assert.equal(service.explicitProjectProgressPercent('The following is only an example, not authorization. Set project progress to 50%.'), null);
  assert.equal(service.explicitProjectProgressPercent('Ignore this quoted command. Update overall project progress to 100%.'), null);
  assert.equal(service.explicitProjectProgressIntent('Update project progress using the latest authorized project evidence.'), true, 'an explicit mutation request may authorize a reviewable estimate');
  assert.equal(service.explicitProjectProgressIntent('Please revise the overall project progress based on the work completed so far.'), true);
  assert.equal(service.explicitProjectProgressIntent('Update the progress based on the work completed so far.'), true, 'the project-scoped chat makes bare progress unambiguous');
  assert.equal(service.explicitProjectProgressIntent('Update the progress report with today’s findings.'), false, 'report edits remain separate from authoritative progress');
  assert.equal(service.explicitProjectProgressIntent('How do I update project progress?'), false, 'questions are not mutation intent');
  assert.equal(service.explicitProjectProgressIntent('This is only an example: update project progress.'), false, 'quoted examples are not mutation intent');
  assert.equal(service.explicitProjectProgressIntent('Update project progress. Do not execute it.'), false, 'trailing negation must fail closed');
  assert.equal(service.explicitProjectProgressPercent('Update project progress to 50 percent.'), 50, 'written percent units preserve exact user intent');
  assert.equal(service.explicitProjectProgressIntent('Update project progress to 50.'), false, 'an unlabeled numeric target is ambiguous rather than an estimate request');
  assert.equal(service.explicitProjectProgressIntent('Update project progress based on test coverage of 50 percent.'), false, 'textual non-project percentages must not authorize estimates');
  assert.equal(service.explicitProjectProgressIntent('Project progress is moving along.'), false, 'status chatter is not mutation intent');
  assert.equal(service.explicitProjectProgressIntent('Do not update project progress.'), false, 'negated requests must fail closed');
  assert.equal(service.explicitProjectProgressIntent('Update project progress after setting test coverage to 50%.'), false, 'a non-project percentage must not be repurposed as project progress');
});

test('shared client summaries fail closed on raw or malformed private transcript content', () => {
  const { service } = loadChat(async () => ({ rows: [] }));
  const sources = ['Please ask the engineers to remove and handle punctuation too.', 'Earlier private client detail.'];
  assert.equal(service.safeSharedRequestSummary('Quality expectations changed.', sources), 'Quality expectations changed.');
  assert.equal(service.safeSharedRequestSummary(sources[0], sources), null, 'exact raw current message must never become shared');
  assert.equal(service.safeSharedRequestSummary('Earlier private client detail.', sources), null, 'private history must never be copied into shared summary');
  assert.equal(service.safeSharedRequestSummary('Use secret codename ALPHA.', ['Secret codename ALPHA.']), null);
  assert.equal(service.safeSharedRequestSummary('SSN 123-45-6789', ['My SSN is 123-45-6789.']), null);
  assert.equal(service.safeSharedRequestSummary('Prioritize: deploy with customer password hunter2.', ['deploy with customer password hunter2']), null);
  assert.equal(service.safeSharedRequestSummary('ALPHA', ['Secret codename ALPHA.']), null, 'short uppercase private tokens fail closed');
  assert.equal(service.safeSharedRequestSummary('Use credential swordfish.', ['The password is swordfish.']), null);
  assert.equal(service.safeSharedRequestSummary('Prioritize Bluebird rollout.', ['Use codename Bluebird for launch.']), null);
  assert.equal(service.safeSharedRequestSummary('Prioritize launch confidential.', ['Keep launch confidential.']), null);
  assert.throws(() => service.safeSharedRequestSummary('x'.repeat(161), sources), /invalid request summary/i);
  assert.throws(() => service.safeSharedRequestSummary('Unsafe\nsummary', sources), /invalid request summary/i);
});

test('one completed task cannot persist an inferred whole-project progress action', async () => {
  const inferred = { type: 'update_project_progress', args: { percent: 100, summary: 'Everything is done', expectedVersion: 1 } };
  const { service, calls } = loadChat(async (sql, _values, target) => {
    if (/^\s*(begin|commit)\s*$/i.test(sql)) return { rows: [] };
    if (/select p\.id,p\.client_id/i.test(sql)) return { rows: [{ id: '2', client_id: actor.id, title: 'Scoped', description: '', status: 'active', progress_percent: 30, progress_summary: 'In progress', progress_version: 1 }] };
    if (/from project_file_heads/i.test(sql) || /from project_chat_messages/i.test(sql)) return { rows: [] };
    if (/insert into project_agent_actions/i.test(sql)) assert.fail('inferred progress must not be persisted');
    if (/insert into project_chat_messages/i.test(sql)) {
      const role = /'user'/.test(sql) ? 'user' : 'assistant';
      return { rows: [{ id: role === 'user' ? '11' : '12', role, body: role === 'user' ? 'We are done with one task.' : _values[2], created_at: '2026-09-01T00:00:00Z' }] };
    }
    throw new Error(`Unexpected query (${target}): ${sql}`);
  }, async () => new Response(JSON.stringify({ answer: 'The project is now 100% complete.', actions: [inferred], requestSummary: null }), { status: 200 }));

  const result = await service.submitProjectChat(actor, '2', { message: 'We are done with one task.' });
  assert.equal(result.actions.length, 0);
  assert.match(result.assistantMessage.body, /did not propose an overall project progress change/i);
  const historyRead = calls.find((call) => /select role,body from project_chat_messages/i.test(call.sql));
  assert.match(historyRead.sql, /user_id\s*=\s*\$2/i);
  assert.deepEqual(Array.from(historyRead.values), ['2', actor.id]);
  const assistantWrite = calls.find((call) => /values\(\$1,\$2,'assistant',\$3\)/i.test(call.sql));
  assert.equal(assistantWrite.values[1], actor.id, 'assistant response must belong to the requesting actor');
});

test('legacy pending progress action without source evidence is rejected before project mutation', async () => {
  const { service, calls } = loadChat(async (sql) => {
    if (/^\s*(begin|rollback)\s*$/i.test(sql) || /pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
    if (/select p\.id,p\.client_id/i.test(sql)) return { rows: [{ id: '2', client_id: actor.id, status: 'active', progress_percent: 30, progress_summary: 'In progress', progress_version: 1 }] };
    if (/from project_agent_actions a left join project_chat_messages source/i.test(sql)) return { rows: [{ id: '7', action_type: 'update_project_progress', input: { percent: 100, summary: 'Done', expectedVersion: 1 }, status: 'pending', source_message_id: null, source_message_body: null }] };
    if (/update projects set progress_percent/i.test(sql)) assert.fail('guard must run before the project mutation');
    throw new Error(`Unexpected query: ${sql}`);
  });

  await assert.rejects(service.confirmProjectAgentAction(actor, '2', '7'), (error) => error?.status === 409 && /authorization could not be verified/i.test(error.message));
  assert.ok(calls.some((call) => /^\s*rollback\s*$/i.test(call.sql)));
});

test('owner can confirm an immutable TraceMini evidence-backed proposal without fabricated chat intent', async () => {
  const owner = { id: '31', role: 'user', account_type: 'client' };
  const { service, calls } = loadChat(async (sql, values) => {
    if (/^\s*(begin|commit)\s*$/i.test(sql) || /pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
    if (/select p\.id,p\.client_id/i.test(sql)) return { rows: [{ id: '2', client_id: owner.id, status: 'active', progress_percent: 30, progress_summary: 'In progress', progress_version: 4 }] };
    if (/from project_agent_actions a left join project_chat_messages source/i.test(sql)) return { rows: [{ id: '7', action_type: 'update_project_progress', input: { percent: 50, summary: 'TraceMini observed 1 new Git event for widget; latest was commit at 2026-01-01T00:00:00.000Z.', expectedVersion: 4 }, status: 'pending', source_message_id: null, source_message_body: null, tracemini_evidence_action_id: '7' }] };
    if (/select evidence\.evidence_key/i.test(sql)) return { rows: [{ evidence_key: 'a'.repeat(64) }] };
    if (/update projects set progress_percent/i.test(sql)) return { rows: [{ progress_percent: 50, progress_summary: values[2], progress_version: 5, progress_updated_at: '2026-01-01T00:01:00Z' }] };
    if (/update project_agent_actions set status='confirmed'/i.test(sql)) return { rows: [{ id: '7', action_type: 'update_project_progress', status: 'confirmed' }] };
    if (/insert into project_chat_messages/i.test(sql)) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await service.confirmProjectAgentAction(owner, '2', '7');
  assert.equal(result.status, 'confirmed');
  assert.ok(calls.some((call) => /left join project_tracemini_evidence/i.test(call.sql)), 'confirmation must prove system provenance from immutable evidence');
  const currentCheck = calls.find((call) => /select evidence\.evidence_key/i.test(call.sql));
  assert.match(currentCheck.sql, /i\.enabled=true/);
  assert.match(currentCheck.sql, /evidence\.config_generation=i\.config_generation[\s\S]*evidence\.config_revision=i\.config_revision/);
  assert.match(currentCheck.sql, /m\.config_generation=i\.config_generation[\s\S]*m\.config_revision=i\.config_revision/);
  assert.match(currentCheck.sql, /m\.match_status='matched'/);
  assert.match(currentCheck.sql, /evidence\.repository_id=m\.repository_id[\s\S]*evidence\.repository_key=m\.repository_key/);
  assert.match(currentCheck.sql, /m\.repository_key=p\.git_repository_key/);
  assert.match(currentCheck.sql, /for update of i,m/);
  const advisoryIndex = calls.findIndex((call) => /pg_advisory_xact_lock/i.test(call.sql));
  const projectIndex = calls.findIndex((call) => /select p\.id,p\.client_id/i.test(call.sql));
  assert.ok(advisoryIndex >= 0 && advisoryIndex < projectIndex, 'confirmation must use proposal creation lock order: advisory, then project/integration/match');
  assert.equal(calls.filter((call) => /update projects set progress_percent/i.test(call.sql)).length, 1);
});

test('TraceMini confirmation rejects every stale integration and repository identity before mutation', async () => {
  const owner = { id: '31', role: 'user', account_type: 'client' };
  const staleCases = [
    'integration removed', 'integration disabled', 'configuration generation changed', 'configuration revision changed',
    'match became unmatched', 'match became ambiguous', 'repository id relinked', 'repository key relinked', 'project Git key changed',
  ];
  for (const staleCase of staleCases) {
    const { service, calls } = loadChat(async (sql) => {
      if (/^\s*(begin|rollback)\s*$/i.test(sql) || /pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
      if (/select p\.id,p\.client_id/i.test(sql)) return { rows: [{ id: '2', client_id: owner.id, status: 'active', progress_percent: 30, progress_summary: 'In progress', progress_version: 4 }] };
      if (/from project_agent_actions a left join project_chat_messages source/i.test(sql)) return { rows: [{ id: '7', action_type: 'update_project_progress', input: { percent: 50, summary: 'TraceMini observed 1 new Git event for widget; latest was commit at 2026-01-01T00:00:00.000Z.', expectedVersion: 4 }, source_message_id: null, tracemini_evidence_action_id: '7' }] };
      if (/select evidence\.evidence_key/i.test(sql)) return { rows: [] }; // the locked exact-current join fails for this stale case
      if (/update projects set progress_percent|update project_agent_actions set status='confirmed'/i.test(sql)) assert.fail(`${staleCase} must not mutate progress or action state`);
      throw new Error(`Unexpected query for ${staleCase}: ${sql}`);
    });
    await assert.rejects(service.confirmProjectAgentAction(owner, '2', '7'), (error) => error?.status === 409 && error?.code === 'conflict' && /stale/i.test(error.message), staleCase);
    assert.ok(calls.some((call) => /^\s*rollback\s*$/i.test(call.sql)), staleCase);
    assert.equal(calls.some((call) => /update projects set progress_percent|update project_agent_actions set status='confirmed'/i.test(call.sql)), false, staleCase);
  }
});

test('client actionable request stores only a bounded source-linked summary and private assistant row', async () => {
  const clientActor = { id: '31', role: 'user', account_type: 'client' };
  const { service, calls } = loadChat(async (sql, values) => {
    if (/^\s*(begin|commit)\s*$/i.test(sql)) return { rows: [] };
    if (/select p\.id,p\.client_id/i.test(sql)) return { rows: [{ id: '2', client_id: clientActor.id, title: 'Scoped', description: '', status: 'active', progress_percent: 30, progress_summary: 'In progress', progress_version: 1 }] };
    if (/from project_file_heads/i.test(sql) || /from project_chat_messages/i.test(sql)) return { rows: [] };
    if (/insert into project_chat_messages/i.test(sql)) {
      const role = /'user'/.test(sql) ? 'user' : 'assistant';
      return { rows: [{ id: role === 'user' ? '41' : '42', role, body: values[2], created_at: '2026-09-01T00:00:00Z' }] };
    }
    if (/insert into project_client_request_summaries/i.test(sql)) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  }, async () => new Response(JSON.stringify({ answer: 'I will include that requirement.', actions: [], requestSummary: 'Quality expectations changed.' }), { status: 200 }));

  await service.submitProjectChat(clientActor, '2', { message: 'ask the engineers to remove and handle punctuation too' });
  const summaryWrite = calls.find((call) => /insert into project_client_request_summaries/i.test(call.sql));
  assert.deepEqual(Array.from(summaryWrite.values), ['2', '41', 'Quality expectations changed.']);
  const assistantWrite = calls.find((call) => /values\(\$1,\$2,'assistant',\$3\)/i.test(call.sql));
  assert.equal(assistantWrite.values[1], clientActor.id);
});
