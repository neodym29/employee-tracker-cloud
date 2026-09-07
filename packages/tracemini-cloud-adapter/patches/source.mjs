import {activationPatch} from './activation.mjs';
// Explicit integration patch recipe. Applied only to disposable build staging.
export function patchSource(name, original) {
 let source = original;
 // Own every CLI, hook, state, cache and service namespace (including env vars).
 source = source.replaceAll('TRACEMINI', 'EMPLOYEE_TRACE').replaceAll('tracemini', 'employee-trace').replaceAll('TraceMini', 'Employee Trace');
 if (name === 'agent.ts') {
  source = source.replace("import {CodexRunner, HermesRunner} from './runner.js';\n", '').replace("import {startDocumentLoopbackServer} from './document-loopback.js';\n", '');
  const start = source.indexOf('export async function processJob('), end = source.indexOf('export async function tick(', start);
  if(start < 0 || end < 0) throw new Error('Upstream report seam changed');
  source = source.slice(0,start) + source.slice(end);
  source = source.replace('const unauthorizedPreferred = current.workspaceId != null && !authorized.has(current.workspaceId);', 'const unauthorizedPreferred = false; // workspaceId is an account discovery context, not a project');
  source = source.replace('if (current.workspaceId && !authorized.has(current.workspaceId)) current.workspaceId = workspaceIds[0];', '// Preserve the account discovery context.');
  source = source.replace('  if (jobs[0]) await processJob(config, jobs[0]);', "  if (jobs.length) throw new Error('Report capability disabled');");
  source = source.replace('  const documentServer = once ? undefined : startDocumentLoopbackServer(config);','').replace('} finally { documentServer?.close(); }','} finally { /* Git-only runtime: no document listener. */ }');
 }
 if (name === 'index.ts') {
  // Consume the private descriptor before guided stdin or any subprocess runs.
  source = source.replace('const config = loadConfig();', `let descriptorInstallToken: string | undefined;
function readInstallTokenDescriptor() {
  if (!args.includes('--install-token-fd')) return;
  if (flag('--install-token-fd') !== '3' || args.includes('--install-token')) throw new Error('Use only --install-token-fd 3');
  const buffer = Buffer.alloc(4097);
  try {
    const stat = fs.fstatSync(3);
    if (!stat.isFile() || stat.nlink !== 0 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.() || stat.size < 1 || stat.size > 4096) throw new Error('Invalid private install credential descriptor');
    const length = fs.readSync(3, buffer, 0, buffer.length, null);
    if (length !== stat.size) throw new Error('Invalid install credential length');
    const token = buffer.subarray(0, length).toString('utf8');
    if (/\\s/.test(token)) throw new Error('Invalid install credential');
    return token;
  } finally { buffer.fill(0); fs.closeSync(3); }
}
const config = loadConfig();`);
  source = source.replace("  const installToken = flag('--install-token');", "  const installToken = descriptorInstallToken ?? flag('--install-token');\n  descriptorInstallToken = undefined;");
  // Keep the original guided setup, transaction rollback and service lifecycle.
  source = source.replace("      let found = 0;", "      await api(config, '/api/agents/sync');\n      let found = 0;");
  source = source.replace('    bindWorkspace(workspaceId);', '// Project authorization is checked remotely; preserve account discovery context.');
  source = source.replace('Workspace ${config.workspaceId} selected', 'Project ${workspaceId} authorized; repository selection remains in the GUI');
  source = source.replace('    const response = await withStartupRestart(exchangeInstallToken);', `    if (!flag('--server') || !(descriptorInstallToken ?? flag('--install-token'))) throw new Error('sync requires generated --server and --install-token arguments');
    await api(config, '/api/agents/sync');
    const response = await withStartupRestart(exchangeInstallToken);`);
  source = source.replace('async function main() {', `async function main() {\n  descriptorInstallToken = readInstallTokenDescriptor();\n  if (command && !['--help', '-h', 'help', 'setup', 'install', 'status'].includes(command)) throw new Error('Cloud Trace integration not enabled; repository synchronization pending');`);
  // Never mutate hooks during enrollment. They remain gated until explicit cutover.
  source = source.replace('beforeRepositoryStateReplace: current => { for (const clone of current.clones) { try { removeHooks(clone.path); } catch {} } },', 'beforeRepositoryStateReplace: () => { /* Auth-only enrollment never changes hooks. */ },');
 }
 if (name === 'git.ts') {
  source = source.replace('  fs.mkdirSync(absolute, {recursive: true});', `  // Preflight ALL hooks before changing any; never chain into live upstream.\n  for (const hook of hooks) {\n    const target = path.join(absolute, hook);\n    if (fs.existsSync(target + '.tracemini-owner') || fs.existsSync(target + '.tracemini-original') || (fs.existsSync(target) && fs.readFileSync(target, 'utf8').includes('TraceMini managed hook'))) throw new Error('Upstream hook conflict; explicit migration required');\n  }\n  fs.mkdirSync(absolute, {recursive: true});`);
 }
 if (name === 'linux-installer.ts') {
  const start = source.indexOf('export function linuxInstallCommand(');
  const end = source.indexOf('export function linuxSyncCommand(', start);
  if (start < 0 || end < 0) throw new Error('Upstream installer command seam changed');
  // A fresh private cache under HOME avoids following pre-created cache/file
  // symlinks. printf is a shell builtin: the secret is never a curl argv or URL.
  // Do not follow redirects or load curlrc (either can disclose credentials).
  source = source.slice(0, start) + `export function linuxInstallCommand(origin: string, installToken: string) {
  const url = origin.replace(/\\/$/, '') + '/api/installers/linux';
  const body = JSON.stringify({installToken});
  return '(umask 077; set -eu; cache=$(mktemp -d "$HOME/.employee-trace-install.XXXXXX"); cleanup() { status=$?; trap - EXIT HUP INT TERM; rm -rf -- "$cache" || true; exit "$status"; }; trap cleanup EXIT; trap "exit 129" HUP; trap "exit 130" INT; trap "exit 143" TERM; printf %s ' + shellQuote(body) + ' | curl --disable --fail --show-error --silent --request POST --header "Content-Type: application/json" --data-binary @- ' + shellQuote(url) + ' --output "$cache/install.sh"; sh "$cache/install.sh")';
}

` + source.slice(end);
  source = source.replace("echo 'Installing OCR dependencies'\nsudo apt-get install -y poppler-utils tesseract-ocr\n", '');
  const setupCommand = '"$BIN_DIR/employee-trace" setup --server ${shellQuote(serverUrl)} --install-token ${shellQuote(installToken)} --transaction-dir "$STAGE_DIR"';
  if (!source.includes(setupCommand)) throw new Error('Upstream installer credential seam changed');
  source = source.replace(setupCommand, `printf '%s' \${shellQuote(installToken)} > "$STAGE_DIR/install-credential"
(
  exec 3< "$STAGE_DIR/install-credential"
  rm -- "$STAGE_DIR/install-credential"
  exec "$BIN_DIR/employee-trace" setup --server \${shellQuote(serverUrl)} --install-token-fd 3 --transaction-dir "$STAGE_DIR"
)`);
  source = source.replace('set -eu\n', 'set -eu\numask 077\n');
 }
 return activationPatch(name, source);
}
