import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const url = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFileSync(url(path), 'utf8');

const servicePath = 'lib/project-chat.ts';
const chatRoutePath = 'app/api/projects/[projectId]/chat/route.ts';
const actionRoutePath = 'app/api/projects/[projectId]/agent-actions/[actionId]/route.ts';
assert.ok(existsSync(url(servicePath)), 'project chat service must exist');
assert.ok(existsSync(url(chatRoutePath)), 'project chat endpoint must exist');
assert.ok(existsSync(url(actionRoutePath)), 'agent action endpoint must exist');

const service = read(servicePath);
const chatRoute = read(chatRoutePath);
const actionRoute = read(actionRoutePath);
const migration = read('migrations/006_project_agent_actions.sql');
const db = read('lib/db.ts');

assert.match(service, /CHAT_BACKEND_URL/);
assert.match(service, /CHAT_BACKEND_TOKEN/);
assert.match(service, /Boolean\(url\)\s*!==\s*Boolean\(token\)/, 'backend URL/token must be an atomic pair');
assert.match(service, /NODE_ENV\s*===\s*['"]production['"][\s\S]*protocol\s*!==\s*['"]https:['"]/, 'production backend must require HTTPS');
assert.match(service, /AbortSignal\.timeout\(30_000\)|setTimeout\([\s\S]*30_000/, 'backend requests must time out');
assert.match(service, /MAX_CONCURRENCY\s*=\s*2/);
assert.match(service, /CHAT_MESSAGE_MAX\s*=\s*4000/);
assert.match(service, /CHAT_ANSWER_MAX\s*=\s*8000/);
assert.match(service, /CHAT_HISTORY_LIMIT\s*=\s*20/);
assert.match(service, /MAX_ACTIONS\s*=\s*5/);
assert.match(service, /create_record[\s\S]*update_record[\s\S]*register_artifact[\s\S]*delete_record/);
assert.doesNotMatch(service, /child_process|execSync|spawn\(|storageKey|\bCodex\b/, 'chat service must expose no process or storage-key capability');
assert.match(service, /JSON\.parse/);
assert.match(service, /Object\.keys[\s\S]*allowed|allowed[\s\S]*Object\.keys/i, 'action arguments must reject unknown keys');
assert.match(service, /projectAccessSql/, 'chat authorization must use centralized project access');
assert.match(service, /select distinct p\.id,p\.title,p\.description/, 'context project fields must be explicitly selected');
assert.match(service, /project_records/);
assert.match(service, /project_artifacts/);
assert.match(service, /project_chat_messages/);
assert.match(service, /role:\s*['"]system['"]/);
assert.match(service, /PROJECT CONTEXT|untrusted/i, 'trusted prompt must delimit untrusted project context');
assert.match(service, /status[^\n]*pending/i, 'proposals must be stored pending');
assert.doesNotMatch(service.slice(service.indexOf('export async function submitProjectChat'), service.indexOf('export async function listProjectChat')), /delete from project_records|insert into project_records|insert into project_artifacts/, 'chat submission must not execute proposals');
assert.match(service, /begin[\s\S]*for update[\s\S]*status='pending'[\s\S]*commit/i, 'confirmation must claim and execute pending actions transactionally');
assert.match(service, /expectedVersion/);
assert.match(service, /max\(version\)[\s\S]*expectedVersion|expectedVersion[\s\S]*max\(version\)/i, 'updates must use optimistic version checks');
assert.match(service, /delete_record[\s\S]*delete from project_records/i);
assert.match(service, /cancelProjectAgentAction/);

for (const route of [chatRoute, actionRoute]) {
  assert.match(route, /assertSameOrigin/, `${route} must protect mutations with same-origin checks`);
  assert.match(route, /apiErrorResponse/, `${route} must use safe error mapping`);
  assert.match(route, /requireApiSession/, `${route} must require an approved session`);
}
assert.match(chatRoute, /export async function GET/);
assert.match(chatRoute, /export async function POST/);
assert.match(actionRoute, /confirm/);
assert.match(actionRoute, /cancel/);

assert.match(migration, /status text[\s\S]*pending[\s\S]*confirmed[\s\S]*cancelled/i);
assert.match(migration, /confirmed_by/);
assert.match(migration, /result jsonb/);
assert.match(migration, /old\.status='pending'[\s\S]*new\.status in \('confirmed','cancelled'\)/i, 'audit lifecycle must only allow one terminal transition');
assert.match(db, /add column if not exists status/);
