import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const route = readFileSync(new URL('../app/api/installer/route.ts', import.meta.url), 'utf8');
const manual = readFileSync(new URL('../app/components/InstallManual.tsx', import.meta.url), 'utf8');

for (const browser of ['google-chrome', 'chromium', 'brave-browser', 'microsoft-edge', 'opera', 'vivaldi']) {
  assert.match(route, new RegExp(browser), `installer should detect/install extension for ${browser}`);
}

for (const policyDir of [
  '/etc/opt/chrome/policies/managed',
  '/etc/chromium/policies/managed',
  '/etc/brave/policies/managed',
  '/etc/opt/edge/policies/managed',
  '/etc/opt/opera/policies/managed',
  '/etc/opt/vivaldi/policies/managed',
]) {
  assert.match(route, new RegExp(policyDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `installer should write policy to ${policyDir}`);
}

for (const expected of [
  'manifest.json',
  'background.js',
  'content.js',
  '/browser-state',
  '/browser-click',
  'ExtensionSettings',
  'external_crx',
  'external_version',
  'EMPLOYEE_TRACKER_UPDATE_CHECK_URL',
  'EMPLOYEE_TRACKER_AUTO_UPDATE=1',
  'EMPLOYEE_TRACKER_AGENT_VERSION',
  '/api/agent-update',
  'TRACKER_PYTHON="/usr/bin/python3"',
  'apt_install_tracker_dependencies',
  'sudo -v',
  'python_minor',
  'apt-cache show "$python_minor"',
  'Skipping unavailable apt package $python_minor; using python3-venv instead.',
  'create_tracker_venv',
  '$TRACKER_PYTHON venv creation failed; reinstalling Python venv support and retrying',
]) {
  assert.match(route, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `installer should include ${expected}`);
}

for (const expected of [
  'Full installation manual',
  'Download the tracker package',
  'Run the installer',
  'Allow admin/sudo prompts',
  'Restart all open browsers',
  'Verify browser extensions',
  'Google Chrome',
  'Brave',
  'Microsoft Edge',
  'Chromium',
  'Opera',
  'Vivaldi',
  'Firefox / LibreWolf',
  'Incognito / private windows',
  'Portable or unknown browsers',
  'browser-compliance warning',
  'Already installed? Refresh/update instead',
  'How to add the browser extension',
  'Load unpacked',
  'Developer mode',
]) {
  assert.match(manual, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `install manual should explain: ${expected}`);
}

for (const page of ['../app/employee/page.tsx', '../app/admin/approve/ApprovalClient.tsx']) {
  const source = readFileSync(new URL(page, import.meta.url), 'utf8');
  assert.match(source, /InstallManual/, `${page} should render the full install manual instead of only a command snippet`);
}

assert.doesNotMatch(route, /Skipping apt dependency install because passwordless sudo is unavailable/, 'installer must not skip dependency installation just because sudo needs a password');
assert.match(route, /sudo apt-get install -y \$packages/, 'installer should install Linux dependencies with interactive sudo when not root');
assert.match(route, /python\{sys\.version_info\.major\}\.\{sys\.version_info\.minor\}-venv/, 'installer should detect the OS python3.x-venv package name when available');
assert.match(route, /apt-cache show "\$python_minor"/, 'installer should only install versioned python venv package when apt knows about it');
assert.match(route, /"\$TRACKER_PYTHON" -m venv "\$VENV_DIR"/, 'installer should create the venv with the OS tracker Python instead of shell PATH python3');
