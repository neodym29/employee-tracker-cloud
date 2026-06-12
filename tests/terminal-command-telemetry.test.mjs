import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const installer = readFileSync(new URL('../app/api/installer/route.ts', import.meta.url), 'utf8');
const collector = readFileSync(new URL('../agent/src/employee_tracker/collector.py', import.meta.url), 'utf8');
const cli = readFileSync(new URL('../agent/src/employee_tracker/cli.py', import.meta.url), 'utf8');
const terminalCommandsPath = new URL('../agent/src/employee_tracker/terminal_commands.py', import.meta.url);
assert.ok(existsSync(terminalCommandsPath), 'agent should include terminal command telemetry reader');
const terminalCommands = readFileSync(terminalCommandsPath, 'utf8');

assert.match(installer, /neodym-terminal-hook\.sh/, 'Linux installer should install a transparent shell command telemetry hook');
assert.match(installer, /terminal-commands\.tsv/, 'installer and agent should agree on terminal command log path');
assert.match(installer, /records submitted shell commands after Enter, not raw keystrokes/, 'installer should document command capture rather than raw keystrokes');
assert.match(installer, /trap '__neodym_tracker_log_bash_debug' DEBUG/, 'Linux bash hook should use DEBUG trap so Ubuntu Terminal commands are captured immediately');
assert.match(collector, /TerminalCommandReader/, 'collector should read terminal command telemetry');
assert.match(collector, /terminal_command/, 'collector should upload terminal_command rich events');
assert.match(terminalCommands, /redact_command/, 'terminal commands should be redacted before upload');
for (const sensitive of ['password', 'token', 'secret', 'api[-_]?key']) {
  assert.ok(terminalCommands.toLowerCase().includes(sensitive.toLowerCase()), `terminal command redaction should cover ${sensitive}`);
}
assert.doesNotMatch(installer, /xinput\s+test.*KeyPress/i, 'installer must not add raw keypress capture');
assert.doesNotMatch(collector, /KeyPress|keystroke/i, 'collector must not upload raw keypresses');
assert.match(cli, /smoke-upload/, 'CLI should expose smoke-upload for installer verification');
assert.match(installer, /\$Exe smoke-upload/, 'Windows installer should perform cloud smoke upload');
assert.match(installer, /employee-tracker" smoke-upload/, 'Linux installer should perform cloud smoke upload');
