import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const installer = readFileSync(new URL('../app/api/installer/route.ts', import.meta.url), 'utf8');
const config = readFileSync(new URL('../agent/src/employee_tracker/config.py', import.meta.url), 'utf8');
const cloud = readFileSync(new URL('../agent/src/employee_tracker/cloud.py', import.meta.url), 'utf8');

assert.match(installer, /\$RunnerTemplate = @'/, 'Windows runner should be generated from a single-quoted template so PowerShell variables are not expanded during install');
assert.match(installer, /\$_ -match '\^\(\[\^=\]\+\)=\(\.\*\)\$'/, 'runner should preserve $_ for env-file parsing');
assert.match(installer, /\$Matches\[1\]/, 'runner should preserve $Matches for env-file parsing');
assert.match(installer, /tracker\.log/, 'Windows scheduled task should write a stdout log');
assert.match(installer, /tracker\.err\.log/, 'Windows scheduled task should write an error log');
assert.match(installer, /powershell -NoProfile -ExecutionPolicy Bypass -File/, 'scheduled task should run the generated runner script');
assert.match(config, /if ';' in value:/, 'Windows file roots should support semicolon separators');
assert.match(config, /os\.name != 'nt' and ':' in value:/, 'Windows drive letters must not be split on colon');
assert.match(config, /USERPROFILE/, 'Windows config should use USERPROFILE when HOME is absent');
assert.match(cloud, /USERNAME/, 'cloud uploader should use USERNAME on Windows when USER is absent');
