import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (relativePath) => readFile(path.join(root, relativePath), 'utf8');
const exists = (relativePath) => access(path.join(root, relativePath)).then(() => true, () => false);

const activePages = [
  'app/layout.tsx',
  'app/page.tsx',
  'app/register/page.tsx',
  'app/signup/page.tsx',
  'app/login/page.tsx',
  'app/dashboard/page.tsx',
  'app/admin/approve/page.tsx',
  'app/employee/page.tsx',
];

const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx'];

async function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return null;
  const base = specifier.startsWith('@/')
    ? path.join(root, specifier.slice(2))
    : path.resolve(path.dirname(path.join(root, fromFile)), specifier);
  for (const candidate of [base, ...sourceExtensions.map((ext) => `${base}${ext}`), ...sourceExtensions.map((ext) => path.join(base, `index${ext}`))]) {
    if (await access(candidate).then(() => true, () => false)) return path.relative(root, candidate);
  }
  return null;
}

async function reachableSources(entries) {
  const pending = [...entries];
  const reached = new Map();
  while (pending.length) {
    const relativePath = pending.pop();
    if (!relativePath || reached.has(relativePath)) continue;
    const text = await source(relativePath);
    reached.set(relativePath, text);
    const imports = text.matchAll(/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g);
    for (const match of imports) {
      const resolved = await resolveImport(relativePath, match[1]);
      if (resolved && !reached.has(resolved)) pending.push(resolved);
    }
  }
  return reached;
}

const prohibitedCode = [
  [/\/api\/(?:installer|ingest|screenshot|agent-update)(?:[?'"`/]|$)/i, 'legacy tracker endpoint'],
  [/InstallManual|employee_tracker|neodym-browser-extension/i, 'legacy tracker module or browser extension'],
  [/getUserMedia|getDisplayMedia|MediaRecorder|desktopCapturer|captureVisibleTab/i, 'screen/audio capture API'],
  [/addEventListener\s*\(\s*['"](?:key(?:down|up|press)|click|input|paste|copy)['"]/i, 'input collection listener'],
  [/navigator\.clipboard\.(?:read|readText)|chrome\.(?:tabs|history)|browser\.(?:tabs|history)/i, 'clipboard/browser collection API'],
  [/download\s*=\s*['"][^'"]*(?:employee-tracker|activity-tracker|extension|screenshot)/i, 'legacy tracker download'],
];

test('all legacy tracker network routes are explicit permanent 410 tombstones', async () => {
  const routes = ['ingest', 'installer', 'screenshot', 'agent-update'];
  for (const route of routes) {
    const text = await source(`app/api/${route}/route.ts`);
    assert.match(text, /status:\s*410/, `${route} must return Gone`);
    assert.match(text, /cache-control['"]?\s*:\s*['"]no-store/i, `${route} must not be cached`);
    assert.match(text, /export const OPTIONS\s*=\s*gone/, `${route} OPTIONS must also return Gone`);
    assert.doesNotMatch(text, /getPool|activity_events|activity_screenshots|userByEnrollmentToken|installer_url|extension_url/);
  }
});

test('public health response exposes liveness only, not infrastructure or capability state', async () => {
  const text = await source('app/api/health/route.ts');
  assert.doesNotMatch(text, /health\s*\(|databaseUrlHint|hasIngestKey|configured/);
  assert.match(text, /NextResponse\.json\(\{\s*ok:\s*true,\s*service:\s*['"]neodym-tracker-cloud['"]\s*\}\)/);
});

test('active pages and their recursively reachable components stay inside the files-only privacy boundary', async () => {
  const reached = await reachableSources(activePages);
  assert.ok(reached.has('app/components/FilesAgentDownload.tsx'), 'active enrollment pages must reach the files-agent download');
  assert.ok(reached.has('lib/files-agent-dashboard.ts'), 'dashboard must reach the files-only query layer');

  for (const [relativePath, text] of reached) {
    for (const [pattern, description] of prohibitedCode) {
      assert.doesNotMatch(text, pattern, `${relativePath} contains prohibited ${description}`);
    }
    if (relativePath === 'lib/files-agent-dashboard.ts') {
      assert.doesNotMatch(text, /activity_events|activity_screenshots|readDashboard/);
      assert.match(text, /files_agent_events/);
      assert.match(text, /files_agent_devices/);
      assert.match(text, /company_id\s*=\s*\$1/);
    }
  }
});

test('dead invasive implementation surfaces are removed, without deleting historical database schema', async () => {
  assert.equal(await exists('agent'), false, 'legacy invasive Python agent must not remain shippable');
  assert.equal(await exists('app/components/InstallManual.tsx'), false, 'legacy install manual must be removed');
  const db = await source('lib/db.ts');
  assert.match(db, /activity_events/);
  assert.match(db, /activity_screenshots/);
});

test('public copy clearly promises approved-agent file metadata only', async () => {
  const landing = await source('app/page.tsx');
  assert.match(landing, /Files only/i);
  assert.match(landing, /Hermes and Codex/);
  assert.match(landing, /without tracking screens, clicks, browsers, text/i);
  assert.match(landing, /No file contents/i);

  const signup = await source('app/signup/page.tsx');
  assert.match(signup, /files-only|file-change metadata/i);
  assert.match(signup, /Hermes, Codex, or Claude/);
  assert.match(signup, /never/i);
});
