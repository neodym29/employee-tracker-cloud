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
assert.doesNotMatch(db, /insert into app_users[\s\S]*[,\s]password[,\s)]/i, 'raw passwords must never be inserted into app_users');

assert.match(registerPage, /type="password"/, 'company registration form must collect first admin password');
assert.match(signupPage, /type="password"/, 'employee signup form must collect employee password');
assert.ok(existsSync(new URL('../app/login/page.tsx', import.meta.url)), 'login page must exist');
assert.ok(existsSync(new URL('../app/api/login/route.ts', import.meta.url)), 'login API must exist');
assert.ok(existsSync(new URL('../app/api/logout/route.ts', import.meta.url)), 'logout API must exist');

assert.match(dashboardPage, /requireAdminSession|redirect\('\/login/, 'admin dashboard must require an admin session');
assert.match(approvePage, /requireAdminSession|redirect\('\/login/, 'approval page must require an admin session');
assert.match(db, /resetExistingUserPassword/, 'setup recovery should be able to reset existing employee/admin passwords without raw storage');
assert.match(bootstrapApi, /reset_user_password/, 'setup bootstrap should expose guarded password reset for approved existing users');
assert.match(bootstrapApi, /wipe_telemetry/, 'setup bootstrap should expose guarded telemetry wipe for deliberate resets');
assert.match(db, /wipeTelemetryForSetup/, 'database helper should wipe telemetry data without removing users/companies');
assert.match(db, /delete from activity_events/, 'telemetry wipe should clear cloud activity events');
assert.match(bootstrapApi, /x-admin-setup-key/, 'setup bootstrap password reset must require the setup key');
