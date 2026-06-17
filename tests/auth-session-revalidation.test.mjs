import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const auth = readFileSync(new URL('../lib/auth.ts', import.meta.url), 'utf8');
const db = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8');

assert.match(auth, /getSessionUserFromDatabase/, 'sessions must be revalidated against the live database, not trusted from the cookie only');
assert.match(auth, /approval_status='approved'/, 'session revalidation must require an approved user');
assert.match(auth, /parsed\.id/, 'session revalidation should bind the cookie to the same database user id');
assert.match(auth, /parsed\.email/, 'session revalidation should bind the cookie to the same database email');
assert.match(auth, /return liveUser/, 'currentSession should return the live database user');

assert.match(db, /user\.approval_status !== 'approved'/, 'login must reject unapproved/rejected admins as well as employees');
