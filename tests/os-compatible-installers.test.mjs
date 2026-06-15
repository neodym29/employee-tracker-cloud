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
assert.match(client, /Refresh existing app/, 'approval UI should also show refresh package commands for already-installed employees');
assert.match(client, /refresh-neodym-tracker/, 'approval refresh commands should be clearly named');
assert.match(client, /JSON\.stringify\(\{ email, platform:/, 'approval API call should send selected platform');
assert.match(approve, /platform = normalizeInstallerPlatform/, 'approval API should normalize requested installer platform');
assert.match(approve, /installer\?token=\$\{result\.enrollment_token\}&platform=\$\{platform\}/, 'approval API should include selected platform in installer URL');
assert.match(installer, /application\/x-msdownload/, 'Windows installer should download as a double-clickable command file');
assert.match(installer, /extension = platform === 'windows' \? \(req\.nextUrl\.searchParams\.get\('format'\) === 'ps1' \? 'ps1' : 'cmd'\) : 'sh'/, 'Windows installer should download as .cmd by default');
assert.doesNotMatch(installer, /\?\./, 'Windows PowerShell installer should avoid PowerShell 7-only optional chaining');
assert.match(installer, /function Ensure-Python/, 'Windows installer should validate Python instead of trusting Microsoft Store aliases');
assert.match(installer, /WindowsApps\\\\python\.exe/, 'Windows installer should ignore Microsoft Store python aliases');
assert.match(installer, /winget install --exact --id Python\.Python\.3\.12/, 'Windows installer should try to install Python automatically with winget');
assert.match(installer, /\$LASTEXITCODE -ne 0/, 'Windows installer should stop on failed native commands');
assert.match(installer, /Python 3\.10\+ is required/, 'Windows installer should give a clear Python missing error');
assert.match(installer, /com\.neodym\.employee-tracker\.plist/, 'macOS installer should create a LaunchAgent plist');
assert.match(installer, /schtasks\.exe/, 'Windows installer should register a scheduled task');
assert.match(installer, /GetFolderPath\('Startup'\)/, 'Windows installer should create a Startup folder fallback');
assert.match(installer, /Start-Process -FilePath 'powershell'/, 'Windows installer should start the collector immediately without requiring schtasks /Run');
assert.match(system, /try:\n\s+import pwd/, 'agent should not hard-crash on Windows when pwd is unavailable');
