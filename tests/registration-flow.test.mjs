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
assert.match(db, /'admin','approved'[\s\S]*'client'/, 'registration should create the first approved company admin as a client account');
const employeeSignup = db.slice(db.indexOf('export async function signupEmployee'), db.indexOf('export async function listEventStatsForSetup'));
assert.match(employeeSignup, /on conflict\s*\(email\)\s*do nothing/i, 'employee signup must not demote or overwrite existing users');
assert.doesNotMatch(employeeSignup, /on conflict\s*\(email\)\s*do update|password_hash\s*=/i, 'employee signup must never replace credentials');
assert.match(db, /restoreAdminAccess/, 'database layer should expose a setup-key admin recovery helper');
assert.match(db, /role='admin'[\s\S]*account_type='admin'[\s\S]*approval_status='approved'/, 'setup-key admin recovery should explicitly restore platform authority and approved status');
assert.doesNotMatch(db, /hello@neodym\.ai|ibrahim@neodym\.ai/, 'fresh installs must not seed demo users');
assert.doesNotMatch(db, /select id from companies where domain=\$1`, \['neodym\.ai'\]/, 'runtime paths must not hard-code neodym.ai company lookups');

assert.match(registerRoute, /registerCompanyWithAdmin/, 'register API must use company registration flow');
assert.match(bootstrapRoute, /restoreAdminAccess/, 'setup-key bootstrap route should allow emergency admin recovery');
assert.match(bootstrapRoute, /listUsersForSetup/, 'setup-key bootstrap route should allow admin-only account diagnostics without exposing hashes');
assert.match(registerPage, /Company registration/, 'first public signup should be company registration');
assert.match(signupRoute, /signupAccount/, 'public signup API must use the new client/engineer account workflow');
assert.match(db, /export async function signupEmployee/, 'legacy company-domain employee signup contract must remain available to telemetry callers');
assert.match(signupPage, /Client[\s\S]*Engineer/, 'public signup page must offer both project account roles');
assert.match(signupPage, /accountType[\s\S]*displayName/, 'public signup page must submit role and display name');
assert.doesNotMatch(signupPage, /company and first admin|Employee signup/i, 'public signup must not retain company-only employee copy');
