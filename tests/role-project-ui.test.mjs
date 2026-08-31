import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const url = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFile(url(path), 'utf8');

test('public header and role signup expose the new account journey', async () => {
  const [layout, signup, logout] = await Promise.all([read('app/layout.tsx'), read('app/signup/page.tsx'), read('app/api/logout/route.ts')]);
  assert.match(layout, /href="\/signup"[^>]*>Sign up/);
  assert.match(layout, /currentSession/);
  assert.match(signup, /Client/);
  assert.match(signup, /Engineer/);
  assert.match(signup, /displayName/);
  assert.match(signup, /accountType/);
  assert.match(signup, /pending approval/i);
  assert.match(signup, /response\.status\s*===\s*409/, 'duplicate signup should get a dedicated safe UI path');
  assert.match(signup, /An account already exists for this email\. Sign in instead\./);
  assert.match(signup, /href="\/login"[^>]*>Sign in/);
  assert.match(layout, /action="\/api\/logout\?next=\/login"[\s\S]*>Switch account</, 'authenticated users need one-click access to sign in as another account');
  assert.match(logout, /next\s*===\s*['"]\/login['"]/, 'logout redirect must be allowlisted');
  assert.doesNotMatch(signup, /company and first admin|Employee signup/i);
});

test('shared navigation highlights the current public and authenticated route', async () => {
  const [layout, activeLink, css] = await Promise.all([
    read('app/layout.tsx'),
    read('app/components/ActiveNavLink.tsx'),
    read('app/globals.css'),
  ]);
  for (const href of ['/signup', '/login', '/admin/approve', '/projects', '/dashboard']) {
    assert.match(layout, new RegExp(`ActiveNavLink[^>]*href=["']${href.replaceAll('/', '\\/')}["']`));
  }
  assert.match(activeLink, /usePathname/);
  assert.match(activeLink, /pathname\.startsWith\(`\$\{href\}\/`\)/, 'nested project pages should keep Projects active');
  assert.match(activeLink, /aria-current/);
  assert.match(activeLink, /active/);
  assert.match(css, /\.navLink\.active/);
  assert.doesNotMatch(css, /body:has\(\[data-auth-page=/, 'route-specific page markers must not control global navigation');
  assert.match(layout, /session[\s\S]*href="\/dashboard"[^>]*>Dashboard/, 'Dashboard navigation must be available to every session');
});

test('approved clients and engineers use the universal dashboard while files data keeps the platform admin pair guard', async () => {
  const dashboard = await read('app/dashboard/page.tsx');
  assert.match(dashboard, /requireApprovedSession/);
  assert.match(dashboard, /session\.role\s*===\s*'admin'\s*&&\s*session\.account_type\s*===\s*'admin'/);
  assert.match(dashboard, /readProjectDashboard/);
  assert.match(dashboard, /readFilesAgentDashboard/);
  assert.doesNotMatch(dashboard, /requireAdminSession/);
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
  assert.match(client, /Platform Admins approve accounts; project owners decide later collaboration requests\./);
  assert.match(client, /Available engineers/);
  assert.match(client, /Invite/);
  assert.match(client, /Open projects/);
  assert.match(client, /Request to join/);
  assert.match(client, /Join request sent/);
  assert.match(client, /router\.push\(`\/projects\/\$\{data\.project\.id\}`\)/);
  assert.doesNotMatch(client, /project proposal|awaiting client approval|pending project proposals|rejected project proposals/i);
  assert.match(client, /Accept/);
  assert.match(client, /Decline/);
});

test('project workspace combines analytics with a right-side agent and has no filesystem surface', async () => {
  for (const path of ['app/projects/[projectId]/page.tsx', 'app/projects/[projectId]/WorkspaceClient.tsx']) assert.ok(existsSync(url(path)));
  const workspace = await read('app/projects/[projectId]/WorkspaceClient.tsx');

  assert.match(workspace, /Project agent/);
  assert.match(workspace, /structured project data/i);
  assert.match(workspace, /Starter prompts/);
  assert.doesNotMatch(workspace, /Starter commands/);
  assert.match(workspace, /Project progress/);
  assert.match(workspace, /What the client asked/);
  assert.match(workspace, /Recent activity/);
  assert.match(workspace, /chatRail/);
  assert.doesNotMatch(workspace, /Agent documents|Generated files|\$\{base\}\/files|file\.path|formatBytes/);
  assert.doesNotMatch(workspace, /inspect project files|ask the agent to create the first file|provide remaining text/i);
  assert.match(workspace, /Conversation/);
  assert.match(workspace, /Pending changes/);
  assert.match(workspace, /Confirm/);
  assert.match(workspace, /Cancel/);
  assert.match(workspace, /await loadOverview\(\)/, 'analytics refresh after agent work');
  assert.match(workspace, /onKeyDown/, 'composer supports keyboard submission');

  assert.doesNotMatch(workspace, /Create record|Update record|Register artifact metadata|JSON body|SHA256|Size in bytes|Workspace health|Project assistant/);
  assert.doesNotMatch(workspace, /\$\{base\}\/records|\$\{base\}\/artifacts/, 'legacy collections must not be fetched by the workspace');
  assert.doesNotMatch(workspace, /JSON\.stringify\(action\.input/, 'raw action JSON must not be the primary action UX');
  assert.doesNotMatch(workspace, /CHAT_BACKEND_URL|CHAT_BACKEND_TOKEN|supabase/i);
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
