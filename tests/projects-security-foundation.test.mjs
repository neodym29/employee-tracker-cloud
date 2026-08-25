import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const db = read('lib/db.ts');
const auth = read('lib/auth.ts');
const projects = read('lib/projects.ts');
const migration = read('migrations/005_project_platform.sql');
const signup = read('app/api/signup/route.ts');
const login = read('app/api/login/route.ts');
const legacyApproval = read('app/api/approve/route.ts');

assert.match(migration, /account_type[\s\S]*admin[\s\S]*client[\s\S]*engineer/i);
for (const table of ['projects', 'project_memberships', 'project_records', 'project_artifacts', 'project_chat_messages', 'project_agent_actions']) {
  assert.match(migration, new RegExp(`create table(?: if not exists)? ${table}`, 'i'), `${table} must exist in migration 005`);
  assert.match(db, new RegExp(`create table if not exists ${table}`, 'i'), `${table} must exist in ensureSchema compatibility`);
}
assert.match(migration, /project_records[\s\S]*version integer/i, 'records must be versioned');
assert.match(migration, /project_artifacts[\s\S]*sha256/i, 'artifact metadata must include sha256');
assert.doesNotMatch(migration, /project_artifacts[\s\S]*(file_bytes|bytea|image_base64)/i, 'artifact table must never store file bytes');
assert.match(migration, /project_agent_actions[\s\S]*prevent_project_agent_action/i, 'agent action audit rows must be immutable');
assert.match(migration, /create index[\s\S]*project_memberships/i, 'project access paths must be indexed');

assert.match(db, /signupAccount/);
const signupService = db.slice(db.indexOf('export async function signupAccount'), db.indexOf('export async function signupEmployee'));
assert.match(signupService, /insert into app_users[\s\S]*on conflict\s*\(email\)\s*do nothing/i, 'signup conflict must not modify existing credentials');
assert.doesNotMatch(signupService, /on conflict\s*\(email\)\s*do update|password_hash\s*=/i, 'signup must never overwrite an existing password');
assert.match(signupService, /Account could not be created/, 'signup conflicts must use a generic error');
const employeeSignupService = db.slice(db.indexOf('export async function signupEmployee'), db.indexOf('export async function listEventStatsForSetup'));
assert.match(employeeSignupService, /select id, domain from companies where domain=\$1/i, 'legacy employee signup must remain company-domain scoped');
assert.match(employeeSignupService, /insert into app_users[\s\S]*account_type[\s\S]*'engineer'/i, 'legacy employee signup must create pending engineers in the registered company');
assert.match(employeeSignupService, /on conflict\s*\(email\)\s*do nothing/i, 'legacy signup conflicts must be insert-only');
assert.doesNotMatch(employeeSignupService, /on conflict\s*\(email\)\s*do update|password_hash\s*=/i, 'legacy signup must never overwrite an existing password');
assert.match(signup, /accountType/);
assert.match(signup, /displayName/);
assert.match(signup, /assertSameOrigin/);
assert.match(login, /account_type/);
assert.match(auth, /account_type: 'admin' \| 'client' \| 'engineer'/);
assert.match(auth, /approval_status='approved'/, 'session database revalidation must fail closed');
assert.match(auth, /app_users\.account_type=\$4/, 'session cookie account type must be revalidated');
assert.match(auth, /session\.role !== 'admin'[\s\S]*session\.account_type !== 'admin'|session\.account_type !== 'admin'[\s\S]*session\.role !== 'admin'/, 'platform admin guards must require both legacy role and platform account type');

const registrationService = db.slice(db.indexOf('export async function registerCompanyWithAdmin'), db.indexOf('export async function signupAccount'));
assert.match(registrationService, /'admin','approved'[\s\S]*'client'/i, 'new company admins must be clients, not platform admins');
assert.doesNotMatch(registrationService, /'admin'\)\s*\n\s*returning/i, 'company registration must not mint platform authority');

assert.match(projects, /TITLE_MAX\s*=\s*120/);
assert.match(projects, /DESCRIPTION_MAX\s*=\s*4000/);
assert.match(projects, /RECORD_TITLE_MAX\s*=\s*160/);
assert.match(projects, /RECORD_BODY_MAX_BYTES\s*=\s*64 \* 1024/);
assert.match(projects, /export (?:function|const) projectAccess/i, 'project authorization policy/query helpers must be centralized and exported');
assert.match(projects, /join project_memberships/i, 'project authorization must use membership joins');
assert.match(projects, /membership_status='active'/i, 'only active memberships authorize project access');
assert.match(projects, /account_type='engineer'[\s\S]*approval_status='approved'/i, 'available engineer discovery must require approved engineers');
assert.match(projects, /status='open'/i, 'engineer discovery must only expose open projects');
assert.match(projects, /sha256[\s\S]*\^\[a-f0-9\]\{64\}\$/i, 'sha256 metadata must be validated');
assert.match(projects, /JSON\.stringify[\s\S]*Buffer\.byteLength/i, 'record bodies must be bounded by UTF-8 JSON bytes');
assert.doesNotMatch(projects, /select \* from projects/i, 'project reads should be explicit and authorization-scoped');
assert.doesNotMatch(projects, /if \(session\.account_type === 'admin'\)[\s\S]{0,500}from projects p order by/i, 'project listing must not have an implicit global admin fallback');
assert.match(projects, /session\.role !== 'admin'[\s\S]*session\.account_type !== 'admin'|session\.account_type !== 'admin'[\s\S]*session\.role !== 'admin'/, 'global approval services must require role admin and account type admin');

const mutationRoutes = [
  'app/api/projects/route.ts',
  'app/api/projects/[projectId]/invitations/route.ts',
  'app/api/projects/[projectId]/requests/route.ts',
  'app/api/projects/[projectId]/memberships/[membershipId]/route.ts',
  'app/api/projects/[projectId]/records/route.ts',
  'app/api/projects/[projectId]/records/[recordId]/route.ts',
  'app/api/projects/[projectId]/artifacts/route.ts',
  'app/api/admin/approvals/[userId]/route.ts',
];
for (const route of mutationRoutes) {
  assert.ok(existsSync(new URL(`../${route}`, import.meta.url)), `${route} must exist`);
  assert.match(read(route), /assertSameOrigin/, `${route} mutation must enforce same-origin`);
  assert.match(read(route), /apiErrorResponse/, `${route} must use centralized safe error mapping`);
}
assert.match(legacyApproval, /assertSameOrigin/, 'legacy company approval mutation must enforce same-origin');
assert.match(legacyApproval, /apiErrorResponse/, 'legacy company approval must safely map unexpected errors');
for (const route of ['app/api/admin/approvals/route.ts', 'app/api/admin/approvals/[userId]/route.ts']) {
  assert.match(read(route), /requirePlatformAdminApiSession/, `${route} must require both admin role and platform account type`);
}
assert.ok(existsSync(new URL('../app/api/admin/approvals/route.ts', import.meta.url)));
assert.ok(existsSync(new URL('../app/api/engineers/route.ts', import.meta.url)));
assert.ok(existsSync(new URL('../app/api/projects/[projectId]/route.ts', import.meta.url)));
