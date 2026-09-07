// Git-only cutover. No report runner, Python work, or legacy hook adoption.
export function activationPatch(name, source) {
 if(name==='index.ts') {
  source=source.replace("import {installStartup,", "import {startupStatus, installStartup,");
  source=source.replace('JSON.stringify({...status, server:', 'JSON.stringify({...status, service: startupStatus(), server:');
  source=source.replace("'setup', 'install', 'status'].includes(command)","'setup', 'install', 'status', 'watch', 'once', 'start', 'event', 'repositories', 'service-install', 'sync', 'use-workspace'].includes(command)");
  source=source.replace("  if (command === 'watch') {",`  if (command === 'service-install') {
    await api(config, '/api/agents/status');
    if (!config.watchedPaths.length) throw new Error('Explicit watch and repository reselect required before service installation');
    installStartup(); return;
  }
  if (command === 'watch') {`);
  source=source.replace('    const root = path.resolve(args[0]);','    const root = fs.realpathSync(path.resolve(args[0]));');
  source=source.replace('    const found = await scanWatchedRoots(config, [root]);',"    await api(config, '/api/agents/sync');\n    const found = await scanWatchedRoots(config, [root]);");
 }
 if(name==='install.ts') {
  source+=`\nexport function startupStatus() {
    if (process.platform !== 'linux') return 'unsupported';
    try {execFileSync('systemctl', ['--user','is-active','--quiet','employee-trace.service'], {stdio:'ignore'});return 'active';} catch {return 'inactive-or-unavailable';}
  }\n`;
  source=source.replace('  return service;', "  execFileSync('systemctl', ['--user', 'is-active', '--quiet', 'employee-trace.service'], {stdio: 'ignore'});\n  return service;");
 }
 if(name==='setup.ts') source=source.replace('  return resolved;', '  return fs.realpathSync(resolved);');
 if(name==='agent.ts') {
  source=source.replace('try { await tick(config, states); } catch (error) { console.error(new Date().toISOString(), String(error)); }','try { await tick(config, states); } catch (error) { if (once) throw error; console.error(new Date().toISOString(), String(error)); }');
 }
 if(name==='git.ts') {
  source=source.replace("  encoding: 'utf8',", "  timeout: 5_000,\n  maxBuffer: 8 * 1024 * 1024,\n  env: {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never'},\n  encoding: 'utf8',");
  source=source.replace('export function repositoryFingerprint(repo: string) {','export function repositoryFingerprint(repo: string) {\n  assertGitBoundary(repo);');
  source=source.replace('export function installHooks(repo: string) {','export function installHooks(repo: string) {\n  preflightHooks(repo);');
  source=source.replace('export function uninstallHooks(repo: string) {','export function uninstallHooks(repo: string) {\n  assertGitBoundary(repo);');
  source=source.replace('export function removeHooks(repo: string) {','export function removeHooks(repo: string) {\n  assertGitBoundary(repo);');
  // No legacy-managed hook recognition: only a current digest owner is authority.
  source=source.replaceAll('!legacyManagedHook(existing)','true');
  source+=`\nexport function assertGitBoundary(repo: string) {
  const root = fs.realpathSync(repo);
  const inside = (target: string) => {const r=path.relative(root, target);return r!=='' && r!=='..' && !r.startsWith('..'+path.sep) && !path.isAbsolute(r);};
  const dotgit=path.join(root,'.git');
  if(!fs.lstatSync(dotgit).isDirectory() || fs.lstatSync(dotgit).isSymbolicLink()) throw new Error('Git-directory containment boundary: external worktrees require explicit separate approval');
  for(const argument of ['--absolute-git-dir','--git-common-dir']) {
    const result=git(root,['rev-parse',argument]);
    if(!inside(fs.realpathSync(path.resolve(root,result)))) throw new Error('Git-directory containment boundary');
  }
  const hooksPath=path.resolve(root,git(root,['rev-parse','--git-path','hooks']));
  if(hooksPath!==path.join(dotgit,'hooks')) throw new Error('Git hook containment boundary');
  if(fs.existsSync(hooksPath) && (fs.lstatSync(hooksPath).isSymbolicLink() || !inside(fs.realpathSync(hooksPath)))) throw new Error('Git hook containment boundary');
}
export function preflightHooks(repo: string) {
  assertGitBoundary(repo);
  const directory=path.join(fs.realpathSync(repo),'.git','hooks');
  if(!fs.existsSync(directory)) return;
  for(const hook of hooks) {
    const target=path.join(directory,hook), owner=target+'.employee-trace-owner';
    const present=(p:string)=>{try{fs.lstatSync(p);return true;}catch{return false;}};
    for(const suffix of ['', '.employee-trace-owner', '.employee-trace-original', '.tracemini-owner', '.tracemini-original']) {
      const p=target+suffix;
      if(present(p) && (fs.lstatSync(p).isSymbolicLink() || !fs.lstatSync(p).isFile())) throw new Error('Unsafe hook conflict; explicit reselect required');
    }
    if(present(target+'.tracemini-owner') || present(target+'.tracemini-original')) throw new Error('Upstream hook conflict; explicit reselect required');
    const content=present(target)?fs.readFileSync(target,'utf8'):'';
    if(content.includes('TraceMini managed hook')) throw new Error('Upstream hook conflict; explicit reselect required');
    const owned=content && present(owner) && fs.readFileSync(owner,'utf8').trim()===hookDigest(content);
    // Unknown hooks may belong to Python or another installation. Never chain/steal.
    if((content && !owned) || (!content && present(owner)) || present(target+'.employee-trace-original')) throw new Error('Unsafe managed/user hook conflict; explicit reselect required');
  }
}
`;
 }
 return source;
}
