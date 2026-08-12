import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const db = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8');
const registerRoute = readFileSync(new URL('../app/api/register/route.ts', import.meta.url), 'utf8');
const bootstrapRoute = readFileSync(new URL('../app/api/bootstrap/route.ts', import.meta.url), 'utf8');
const signupRoute = readFileSync(new URL('../app/api/signup/route.ts', import.meta.url), 'utf8');

const registerPage = readFileSync(new URL('../app/register/page.tsx', import.meta.url), 'utf8');
const signupPage = readFileSync(new URL('../app/signup/page.tsx', import.meta.url), 'utf8');

assert.match(db, /resolveMx|resolveNs|resolve4|resolve6/, 'company registration must validate that email domain has DNS records');
assert.match(db, /registerCompanyWithAdmin/, 'database layer should create the company and first admin together');
assert.match(db, /insert into companies\(name, domain\)/, 'registration should create companies dynamically');
assert.match(db, /'admin','approved'/, 'registration should create the first approved admin');
assert.match(db, /where app_users\.role='employee'/, 'employee signup conflict handling must not demote existing admins into pending employees');
assert.match(db, /restoreAdminAccess/, 'database layer should expose a setup-key admin recovery helper');
assert.match(db, /role='admin', approval_status='approved'/, 'admin recovery should promote/restore approved admin role');
assert.doesNotMatch(db, /hello@neodym\.ai|ibrahim@neodym\.ai/, 'fresh installs must not seed demo users');
assert.doesNotMatch(db, /select id from companies where domain=\$1`, \['neodym\.ai'\]/, 'runtime paths must not hard-code neodym.ai company lookups');

assert.match(registerRoute, /registerCompanyWithAdmin/, 'register API must use company registration flow');
assert.match(bootstrapRoute, /restoreAdminAccess/, 'setup-key bootstrap route should allow emergency admin recovery');
assert.match(bootstrapRoute, /listUsersForSetup/, 'setup-key bootstrap route should allow admin-only account diagnostics without exposing hashes');
assert.match(registerPage, /Company registration/, 'first public signup should be company registration');
assert.match(signupRoute, /signupEmployee/, 'employee signup API must remain available after admin setup');
assert.match(signupPage, /Employee signup/, 'employee signup page must remain separate from company registration');
