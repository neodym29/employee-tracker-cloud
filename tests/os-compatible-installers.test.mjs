import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const approve = readFileSync(new URL('../app/api/approve/route.ts', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../app/api/installer/route.ts', import.meta.url), 'utf8');
const client = readFileSync(new URL('../app/admin/approve/ApprovalClient.tsx', import.meta.url), 'utf8');
const system = readFileSync(new URL('../agent/src/employee_tracker/system.py', import.meta.url), 'utf8');

for (const platform of ['linux', 'macos', 'windows']) {
  assert.match(client, new RegExp(`value="${platform}"`), `approval UI should let admins select ${platform}`);
  assert.match(installer, new RegExp(`platform === '${platform}'`), `installer route should branch for ${platform}`);
}

assert.match(client, /installerPlatform/, 'approval UI should store the selected installer OS');
assert.match(client, /JSON\.stringify\(\{ email, platform:/, 'approval API call should send selected platform');
assert.match(approve, /platform = normalizeInstallerPlatform/, 'approval API should normalize requested installer platform');
assert.match(approve, /installer\?token=\$\{result\.enrollment_token\}&platform=\$\{platform\}/, 'approval API should include selected platform in installer URL');
assert.match(installer, /application\/x-msdownload/, 'Windows installer should download as a double-clickable command file');
assert.match(installer, /extension = platform === 'windows' \? \(req\.nextUrl\.searchParams\.get\('format'\) === 'ps1' \? 'ps1' : 'cmd'\) : 'sh'/, 'Windows installer should download as .cmd by default');
assert.doesNotMatch(installer, /\?\./, 'Windows PowerShell installer should avoid PowerShell 7-only optional chaining');
assert.match(installer, /\$PyLauncher = Get-Command py -ErrorAction SilentlyContinue/, 'Windows installer should support legacy Windows PowerShell while detecting py launcher');
assert.match(installer, /Python is required/, 'Windows installer should give a clear Python missing error');
assert.match(installer, /com\.neodym\.employee-tracker\.plist/, 'macOS installer should create a LaunchAgent plist');
assert.match(installer, /schtasks\.exe/, 'Windows installer should register a scheduled task');
assert.match(system, /try:\n\s+import pwd/, 'agent should not hard-crash on Windows when pwd is unavailable');
