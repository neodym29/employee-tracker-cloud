import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const url = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFile(url(path), 'utf8');

test('public header and role signup expose the new account journey', async () => {
  const [layout, signup] = await Promise.all([read('app/layout.tsx'), read('app/signup/page.tsx')]);
  assert.match(layout, /href="\/signup"[^>]*>Sign up/);
  assert.match(layout, /currentSession/);
  assert.match(signup, /Client/);
  assert.match(signup, /Engineer/);
  assert.match(signup, /displayName/);
  assert.match(signup, /accountType/);
  assert.match(signup, /pending approval/i);
  assert.doesNotMatch(signup, /company and first admin|Employee signup/i);
});

test('admin approval UI uses platform approval routes for both decisions', async () => {
  const [page, client] = await Promise.all([read('app/admin/approve/page.tsx'), read('app/admin/approve/ApprovalClient.tsx')]);
  assert.match(page, /requirePlatformAdminSession/);
  assert.match(client, /\/api\/admin\/approvals/);
  assert.match(client, /Approve/);
  assert.match(client, /Reject/);
  assert.match(client, /account_type/);
});

test('role-aware projects matching UI supports client and engineer flows', async () => {
  assert.ok(existsSync(url('app/projects/page.tsx')));
  assert.ok(existsSync(url('app/projects/ProjectsClient.tsx')));
  const [page, client] = await Promise.all([read('app/projects/page.tsx'), read('app/projects/ProjectsClient.tsx')]);
  assert.match(page, /requireApprovedSession/);
  assert.match(client, /Create project/);
  assert.match(client, /Available engineers/);
  assert.match(client, /Invite/);
  assert.match(client, /Open projects/);
  assert.match(client, /Request to join/);
  assert.match(client, /Accept/);
  assert.match(client, /Decline/);
});

test('project workspace includes records, artifact metadata and confirmable chat', async () => {
  for (const path of ['app/projects/[projectId]/page.tsx', 'app/projects/[projectId]/WorkspaceClient.tsx']) assert.ok(existsSync(url(path)));
  const workspace = await read('app/projects/[projectId]/WorkspaceClient.tsx');
  assert.match(workspace, /Project records/);
  assert.match(workspace, /Create record/);
  assert.match(workspace, /Update record/);
  assert.match(workspace, /Artifact metadata/);
  assert.match(workspace, /sha256/i);
  assert.match(workspace, /Project chat/);
  assert.match(workspace, /Confirm/);
  assert.match(workspace, /Cancel/);
  assert.match(workspace, /Chat is unavailable/);
  assert.doesNotMatch(workspace, /CHAT_BACKEND_URL|CHAT_BACKEND_TOKEN/);
});

test('login redirects by account type and project CSS is responsive', async () => {
  const [login, css] = await Promise.all([read('app/login/page.tsx'), read('app/globals.css')]);
  assert.match(login, /account_type/);
  assert.match(login, /\/projects/);
  assert.match(login, /\/admin\/approve/);
  assert.match(css, /\.projectGrid/);
  assert.match(css, /\.workspaceGrid/);
  assert.match(css, /\.chatPanel/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
});
