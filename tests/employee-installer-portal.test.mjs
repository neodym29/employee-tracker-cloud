import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const employeePage = readFileSync(new URL('../app/employee/page.tsx', import.meta.url), 'utf8');
const db = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8');

assert.match(employeePage, /Download your tracker app/, 'employee portal should show installer downloads to employees');
for (const platform of ['windows', 'macos', 'linux']) {
  assert.match(employeePage, new RegExp(`platform=\\$\\{platform.key\\}`), 'employee installer links should include platform selection');
  assert.match(employeePage, new RegExp(platform), `employee portal should mention ${platform}`);
}
assert.match(employeePage, /approvedEmployeeInstallerToken/, 'employee page should fetch approved employee installer token');
assert.match(employeePage, /not approved yet/, 'employee page should explain approval pending state');
assert.match(employeePage, /Refresh existing app/, 'employee portal should expose a refresh package action for already-installed agents');
assert.match(employeePage, /updateCommandFor/, 'employee portal should generate update commands without requiring a manual redownload');
assert.match(employeePage, /refresh-neodym-tracker/, 'employee update commands should save a clearly named refresh script');
assert.match(db, /approvedEmployeeInstallerToken/, 'db should expose approved employee installer token lookup');
assert.match(db, /approval_status='approved'/, 'employee installer token lookup should require approval');
