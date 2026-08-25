import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const db = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8');
const registerPage = readFileSync(new URL('../app/register/page.tsx', import.meta.url), 'utf8');
const signupPage = readFileSync(new URL('../app/signup/page.tsx', import.meta.url), 'utf8');
const dashboardPage = readFileSync(new URL('../app/dashboard/page.tsx', import.meta.url), 'utf8');
const approvePage = readFileSync(new URL('../app/admin/approve/page.tsx', import.meta.url), 'utf8');
const bootstrapApi = readFileSync(new URL('../app/api/bootstrap/route.ts', import.meta.url), 'utf8');

assert.match(db, /password_hash text/, 'users table must store password hashes, not plaintext passwords');
assert.match(db, /pbkdf2Sync|scryptSync|argon2/, 'passwords must be hashed with a password KDF');
assert.match(db, /verifyPassword/, 'login must verify supplied passwords against hashes');
assert.match(db, /registerCompanyWithAdmin\([^)]*adminPassword/, 'first admin registration must require a password');
assert.match(db, /signupEmployee\([^)]*password/, 'employee signup must require a password');
assert.doesNotMatch(db, /\bpassword\s+text\b|insert into app_users\s*\([^)]*\bpassword\b/i, 'raw passwords must never be stored in or inserted into app_users');
for (const [name, end] of [['signupAccount', 'signupEmployee'], ['signupEmployee', 'listEventStatsForSetup']]) {
  const service = db.slice(db.indexOf(`export async function ${name}`), db.indexOf(`export async function ${end}`));
  assert.match(service, /on conflict\s*\(email\)\s*do nothing/i, `${name} must be insert-only on conflict`);
  assert.doesNotMatch(service, /on conflict\s*\(email\)\s*do update|password_hash\s*=/i, `${name} must never update an existing password`);
}

assert.match(registerPage, /type="password"/, 'company registration form must collect first admin password');
assert.match(signupPage, /type="password"/, 'employee signup form must collect employee password');
assert.ok(existsSync(new URL('../app/login/page.tsx', import.meta.url)), 'login page must exist');
assert.ok(existsSync(new URL('../app/api/login/route.ts', import.meta.url)), 'login API must exist');
assert.ok(existsSync(new URL('../app/api/logout/route.ts', import.meta.url)), 'logout API must exist');

assert.match(dashboardPage, /requireAdminSession|redirect\('\/login/, 'admin dashboard must require an admin session');
assert.match(approvePage, /requirePlatformAdminSession|requireAdminSession|redirect\('\/login/, 'approval page must require a platform admin session');
assert.match(db, /resetExistingUserPassword/, 'setup recovery should be able to reset existing employee/admin passwords without raw storage');
assert.match(bootstrapApi, /reset_user_password/, 'setup bootstrap should expose guarded password reset for approved existing users');
assert.match(bootstrapApi, /wipe_telemetry/, 'setup bootstrap should expose guarded telemetry wipe for deliberate resets');
assert.match(db, /wipeTelemetryForSetup/, 'database helper should wipe telemetry data without removing users/companies');
assert.match(db, /telemetryPaused/, 'database helper should expose a telemetry pause flag during destructive resets');
assert.match(db, /wipeTelemetryBatchForSetup/, 'database helper should support repeated bounded wipe batches');
assert.match(db, /delete from \$\{table\}/, 'telemetry wipe should use bounded deletes to avoid long production locks');
assert.match(bootstrapApi, /set_telemetry_pause/, 'setup bootstrap should be able to pause ingestion while wiping');
assert.match(bootstrapApi, /wipe_telemetry_batch/, 'setup bootstrap should expose bounded wipe batches');
assert.match(bootstrapApi, /x-admin-setup-key/, 'setup bootstrap password reset must require the setup key');
