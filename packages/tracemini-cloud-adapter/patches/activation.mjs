// Git-only cutover. No report runner, Python work, or legacy hook adoption.
export function activationPatch(name, source) {
 if(name==='index.ts') {
  source=source.replace('#!/usr/bin/env node',"#!/usr/bin/env node\nimport {localWorktreeCapabilities} from './local-worktree.js';");
  source=source.replace('JSON.stringify({...status, server:', 'JSON.stringify({...status, service:startupStatus(), localCapture:localWorktreeCapabilities, localRegistration:{registeredClones:config.clones.length,state:config.clones.length ? "registered-local-clones" : "no-local-clone-registration"}, server:');
  source=source.replace("import {flush,", "import {processRepositorySelections, flush,");
  source=source.replace("import {commitData,", "import {inspectRepo, commitData,");
  source=source.replace('async function main() {', `async function main() {
    if(command==='project-capabilities') {console.log('project-discover project-activate v1');return;}
    if(command==='project-discover' || command==='project-activate') {
      if(args.length!==(command==='project-discover'?1:2) || !path.isAbsolute(args[0])) throw new Error('Supply exact absolute repository and, for activation, existing project ID');
      const root=fs.realpathSync(args[0]);
      if(root!==args[0] || git(root,['rev-parse','--show-toplevel'])!==root) throw new Error('Exact canonical Git root required');
      const digest=repositoryFingerprint(root);
      if(command==='project-discover') {
        if(!config.watchedPaths.includes(root)) {config.watchedPaths.push(root);saveConfig(config);}
        const info=inspectRepo(root);
        await api(config,'/api/agents/repository-candidates',{method:'POST',body:JSON.stringify({repositories:[{localKey:root,identityFingerprint:digest,remoteUrl:info.remoteUrl}]})});
        console.log('Discovered exact repository; browser project linking and selection required');return;
      }
      if(!/^[1-9][0-9]*$/.test(args[1]) || !Number.isSafeInteger(Number(args[1]))) throw new Error('Existing project ID required');
      const result=await api<any>(config,'/api/agents/project-control',{body:JSON.stringify({digest,projectId:Number(args[1])})});
      if(!result.repositorySelections.length) throw new Error('No authorized pending selection for this repository/project; approve in authenticated browser first');
      await processRepositorySelections(config,undefined,result.repositorySelections);
      const clone=loadConfig().clones.find(c=>c.path===root&&c.workspaceId===Number(args[1])&&c.repositoryFingerprint===digest);
      if(!clone && result.repositorySelections.some((s:any)=>s.desired_traced)) throw new Error('Activation failed; inspect exact candidate error');
      console.log('Selection processed; verify server acknowledgement separately; upload pause unchanged');return;
    }
    if(command==='poll-only-consent') {
      if(args.length!==3 || !['enable','disable'].includes(args[2])) throw new Error('Usage: poll-only-consent ABSOLUTE_REPOSITORY EXPECTED_FINGERPRINT enable|disable');
      persistPollOnlyConsent(args[0],args[1],args[2]==='enable');return;
    }`);
  source=source.replace("import {inspectRepo, commitData,", "import {persistPollOnlyConsent, inspectRepo, commitData,");
  source=source.replace("import {installStartup,", "import {startupStatus, installStartup,");
  source=source.replace('JSON.stringify({...status, server:', 'JSON.stringify({...status, service: startupStatus(), server:');
  source=source.replace("'setup', 'install', 'status'].includes(command)","'setup', 'install', 'status', 'watch', 'once', 'start', 'event', 'repositories', 'service-install', 'sync', 'use-workspace'].includes(command)");
  source=source.replace("  if (command === 'watch') {",`  if (command === 'service-install') {
    await api(config, '/api/agents/status');
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
 if(name==='config.ts') {
  source=source.replace('repositoryFingerprint?:string};', 'repositoryFingerprint?:string;registrationRevision?:number;historyImportVersion?:number};');
  // Background snapshots may update cursors, never grant clone membership.
  source=source.replace('for(const clone of c.clones)clones.set(cloneKey(clone),clone);', 'const backgroundClones=new Map(c.clones.map(clone=>[cloneKey(clone),clone]));');
  source=source.replace('const background=clones.get(key);', 'const background=backgroundClones.get(key);');
  source=source.replace('background?.repositoryId===clone.repositoryId?', 'background?.repositoryId===clone.repositoryId&&background?.repositoryFingerprint===clone.repositoryFingerprint?');
  // A daemon snapshot may update metadata on a registration, but must not
  // overwrite a newer same-root activation generation persisted meanwhile.
  source=source.replace('{...clone,...background}:clone)', '(background.registrationRevision||0)>(clone.registrationRevision||0)?clone:{...clone,...background}:clone)');
  source=source.replaceAll('fs.renameSync(temporary,target);', `const durableFd=fs.openSync(temporary,'r');try{fs.fsyncSync(durableFd);}finally{fs.closeSync(durableFd);}
  fs.renameSync(temporary,target);
  const durableDir=fs.openSync(path.dirname(target),'r');try{fs.fsyncSync(durableDir);}finally{fs.closeSync(durableDir);}`);
  source=source.replace('if(queue.some(current=>current.eventKey===event.eventKey))return true;', `const configuredQueueLimit=Number(process.env.EMPLOYEE_TRACE_QUEUE_MAX_EVENTS);
    const queueLimit=Number.isSafeInteger(configuredQueueLimit)&&configuredQueueLimit>0?Math.min(configuredQueueLimit,100_000):100_000;
    const authorized=(queued)=>queued.workspaceId!=null&&!!queued.localKey&&!!queued.identityFingerprint&&stored.clones.some(clone=>clone.workspaceId===queued.workspaceId&&clone.path===queued.localKey&&clone.repositoryId===queued.repositoryId&&clone.repositoryFingerprint===queued.identityFingerprint);
    queue.splice(0,queue.length,...queue.filter(authorized));
    if(queue.some(current=>current.eventKey===event.eventKey))return true;
    if(queue.length>=queueLimit)return false;`);
 }
 if(name==='agent.ts') {
  source=source.replace("import {commitHistory,", "import {automaticDiscoveryRoots, commitHistory,");
  source=source.replace('  return config.watchedPaths || [];', '  return [...new Set([...(config.watchedPaths || []), ...automaticDiscoveryRoots()])];');
  source=source.replace('const approvedRoots =', 'const permittedRoots =');
  source=source.replace('approvedRoots.some(root =>', 'permittedRoots.some(root =>');
  source=source.replace('repository is outside the approved discovery root', 'repository is outside the safe discovery roots');
  // Exact canonical device AND path, never prefix-based remote trust.
  const localIdentity='clone.normalizedRemote.startsWith(`local-device-${config.agentId}:`) || clone.normalizedRemote.startsWith(`local-device-${config.agentId}/`)';
  if(!source.includes(localIdentity))throw new Error('Local identity seam missing');
  source=source.replace(localIdentity,'!!clone.repositoryFingerprint && (clone.normalizedRemote === `local-device-${config.agentId}:${info.path}` || clone.normalizedRemote === normalizeRemote(`local-device-${config.agentId}:${info.path}`))');
  // A sync response predates concurrent interactive activation. Revoke only the
  // exact registrations observed by that request, not newer persisted grants.
  source=source.replace('  const authorized = new Set(workspaceIds);', `  const authorized = new Set(workspaceIds);
  const observed = new Set(config.clones.map(clone=>JSON.stringify(clone)));
  const revoked = (clone: Config['clones'][number]) => observed.has(JSON.stringify(clone)) && clone.workspaceId != null && !authorized.has(clone.workspaceId);`);
  source=source.replace('current.clones.filter(clone => clone.workspaceId != null && !authorized.has(clone.workspaceId))', 'current.clones.filter(revoked)');
  source=source.replace('current.clones.filter(clone => clone.workspaceId == null || authorized.has(clone.workspaceId))', 'current.clones.filter(clone => !revoked(clone))');
  // Persist server selection revision as clone identity. Direct/local callers
  // receive a monotonic local generation. Mutations and cleanup are ordered so
  // stale activation/stop/failure work cannot remove or replace a newer grant.
  source=source.replace('export async function traceRepository(config: Config, repoPath: string, workspaceId = config.workspaceId) {', 'export async function traceRepository(config: Config, repoPath: string, workspaceId = config.workspaceId, registrationRevision?: number) {');
  source=source.replace('const existing = config.clones.find(clone => clone.path === info.path && clone.workspaceId === workspaceId && clone.repositoryId === repository.id);', `const existing = config.clones.find(clone => clone.path === info.path && clone.workspaceId === workspaceId && clone.repositoryId === repository.id);
    const persistedRevision = registrationRevision ?? Math.max(0, ...config.clones.filter(clone => clone.path === info.path && clone.workspaceId === workspaceId).map(clone => clone.registrationRevision || 0)) + 1;`);
  source=source.replace('historyHeads: existing?.historyHeads || [], repositoryFingerprint: fingerprint}', 'historyHeads: existing?.historyHeads || [], repositoryFingerprint: fingerprint, registrationRevision: persistedRevision, historyImportVersion: existing?.historyImportVersion}');
  source=source.replace('await traceRepository(binding, current.path, selectionWorkspaceId);', 'await traceRepository(binding, current.path, selectionWorkspaceId, Number(selection.revision));');
  source=source.replace('currentConfig.clones = [...currentConfig.clones.filter(candidate => !(candidate.path === target && candidate.workspaceId === selectionWorkspaceId)), clone];', `const newer=currentConfig.clones.find(candidate => candidate.path === target && candidate.workspaceId === selectionWorkspaceId && (candidate.registrationRevision||0)>(clone.registrationRevision||0));
          if(!newer) currentConfig.clones = [...currentConfig.clones.filter(candidate => !(candidate.path === target && candidate.workspaceId === selectionWorkspaceId)), clone];`);
  source=source.replaceAll("currentConfig.clones = currentConfig.clones.filter(clone => !(clone.path === target && clone.workspaceId === selectionWorkspaceId));", "currentConfig.clones = currentConfig.clones.filter(clone => !(clone.path === target && clone.workspaceId === selectionWorkspaceId && (clone.registrationRevision||0) <= Number(selection.revision)));");
  source=source.replace('  if (!matched || !changed) return 0;', '  if (!matched || !changed) { if (matched) Object.assign(config, loadConfig()); return 0; }');
  source="import {reconcileLocalWorktrees, importObserverReceipts} from './local-worktree.js';\n"+source;
  source=source.replace('Use only the supplied Git', 'File-change receipts prove successful attributed filesystem operations, not commits, content, delivery or human authorship. Never describe file_change as a commit. Use only the supplied Git and attributed file-change');
  source=source.replace('  const stagedPaths = new Set<string>();', '  reconcileLocalWorktrees(config);\n  try { importObserverReceipts(config); } catch { console.error("Observer receipt import blocked; cursor preserved"); }\n  const stagedPaths = new Set<string>();');
  // Unattributed stage metadata must remain local, not be emitted as work.
  const stageStart=source.indexOf('      let index = git(clone.path,');
  const stageEnd=source.indexOf('      indexState.set(clone.path, state);',stageStart);
  if(stageStart<0||stageEnd<0)throw new Error('Local worktree stage seam missing');
  source=source.slice(0,stageStart)+source.slice(stageEnd+'      indexState.set(clone.path, state);'.length);
  // Defer initial history until the clone is persisted: enqueue validates it.
  const historyStart=source.indexOf('    const incrementalHistory =');
  const historyEnd=source.indexOf('    assertIdentity();\n    try { installHooks', historyStart);
  if(historyStart<0 || historyEnd<0) throw new Error('Activation history patch anchor missing');
  source=source.slice(0,historyStart)+source.slice(historyEnd);
  source=source.replace('historyHeads: currentHistoryHeads, repositoryFingerprint: fingerprint', 'historyHeads: existing?.historyHeads || [], repositoryFingerprint: fingerprint, registrationRevision: persistedRevision, historyImportVersion: existing?.historyImportVersion');
  source=source.replace('      if (clone.historyHeads?.length) {', '      if (Array.isArray(clone.historyHeads)) {');
  source=source.replace('const commits = commitHistoryAfterHeads(clone.path, clone.historyHeads) || [];', "const commits = clone.historyImportVersion === 2 && clone.historyHeads.length ? commitHistoryAfterHeads(clone.path, clone.historyHeads) || [] : commitHistory(clone.path, new Date(0).toISOString(), new Date().toISOString());");
  source=source.replace('        clone.historyHeads = currentHeads;', '        clone.historyHeads = currentHeads;\n        clone.historyImportVersion = 2;');

  source=source.replace('    } catch (error: any) {\n      if (!bindingLost', "    } catch (error: any) {\n      console.error('Employee Trace activation failed', error?.message === 'repository commit recovery could not be queued' ? 'history_queue_failed' : 'local_activation_failed');\n      if (!bindingLost");
  source=source.replace('try { await tick(config, states); } catch (error) { console.error(new Date().toISOString(), String(error)); }','try { await tick(config, states); } catch (error) { if (once) throw error; console.error(new Date().toISOString(), String(error)); }');
  source=source.replace(
    'export async function runAgent(config: Config, once = false) {\n  const states = new Map<string, {mtime: number; timer?: NodeJS.Timeout}>();',
    `export const effectiveRepositoryDiscoveryMs = (configured: unknown) => Math.max(5 * 60_000, Number(configured) || 10 * 60_000);

export async function runAgent(config: Config, once = false) {
  const states = new Map<string, {mtime: number; timer?: NodeJS.Timeout}>();
  let lastRepositoryDiscoveryAt = 0;`,
  );
  source=source.replace(
    '      config = loadConfig();\n      try { await tick(config, states); }',
    `      config = loadConfig();
      const discoveryNow = Date.now();
      if (discoveryNow - lastRepositoryDiscoveryAt >= effectiveRepositoryDiscoveryMs(process.env.EMPLOYEE_TRACE_REPOSITORY_DISCOVERY_MS)) {
        lastRepositoryDiscoveryAt = discoveryNow;
        try { await publishRepositoryCandidates(config); }
        catch (error) { if (once) throw error; console.error(new Date().toISOString(), 'Repository discovery failed', String(error)); }
      }
      try { await tick(config, states); }`,
  );
 }
 if(name==='git.ts') {
  source="import os from 'node:os';\nimport {loadConfig, mutateCurrentBinding} from './config.js';\n"+source;
  source=source.replace("'.hermes', '.Trash'", "'.hermes', '.git', '.ssh', '.gnupg', '.aws', '.azure', '.config', '.mozilla', '__pycache__', 'lost+found', '.Trash'");
  source=source.replace("entry.isDirectory() && !entry.isSymbolicLink() && !excluded.has(entry.name)", "entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !excluded.has(entry.name)");
  source=source.replace("  encoding: 'utf8',", "  timeout: 5_000,\n  maxBuffer: 8 * 1024 * 1024,\n  env: {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never'},\n  encoding: 'utf8',");
  source=source.replace('export function repositoryFingerprint(repo: string) {','export function repositoryFingerprint(repo: string) {\n  assertGitBoundary(repo);');
  source=source.replace('export function installHooks(repo: string) {','export function installHooks(repo: string) {\n  preflightHooks(repo);');
  source=source.replace('export function uninstallHooks(repo: string) {','export function uninstallHooks(repo: string) {\n  assertGitBoundary(repo);');
  source=source.replace('export function removeHooks(repo: string) {','export function removeHooks(repo: string) {\n  assertGitBoundary(repo);');
  // No legacy-managed hook recognition: only a current digest owner is authority.
  source=source.replaceAll('!legacyManagedHook(existing)','true');
  source=source.replace('  preflightHooks(repo);', '  preflightHooks(repo);\n  if (pollOnlyRepository(repo)) return [];');
  source=source.replace('export function uninstallHooks(repo: string) {\n  assertGitBoundary(repo);', 'export function uninstallHooks(repo: string) {\n  assertGitBoundary(repo);\n  if (pollOnlyRepository(repo)) return [];');
  source+=`\nexport function automaticDiscoveryRoots() {
  const roots:string[]=[];
  const seen=new Set<string>();
  const uid=process.getuid?.();
  const username=os.userInfo().username;
  const add=(candidate:string, requireOwner=false) => {
    try {
      if(!path.isAbsolute(candidate))return;
      const absolute=path.resolve(candidate),entry=fs.lstatSync(absolute);
      if(entry.isSymbolicLink()||!entry.isDirectory())return;
      const canonical=fs.realpathSync(absolute),details=fs.statSync(canonical);
      if(canonical!==absolute||!details.isDirectory()||(requireOwner&&uid!==undefined&&details.uid!==uid))return;
      fs.accessSync(canonical,fs.constants.R_OK|fs.constants.X_OK);
      if(!seen.has(canonical)){seen.add(canonical);roots.push(canonical);}
    } catch {}
  };
  add(os.homedir(),true);
  const deniedFileSystems=new Set(['nfs','nfs4','cifs','smb3','sshfs','fuse.sshfs','9p','ceph','glusterfs','davfs','proc','sysfs','devtmpfs','devpts','tmpfs','cgroup','cgroup2','overlay','squashfs','autofs','tracefs','debugfs','securityfs','pstore','configfs','efivarfs','mqueue','hugetlbfs','ramfs','fuse.portal','fusectl','bpf']);
  const deniedPaths=['/','/boot','/dev','/etc','/opt','/proc','/run','/snap','/sys','/usr','/var'];
  const permittedParents=[path.join('/media',username),path.join('/run/media',username),'/mnt'];
  const inside=(parent:string,target:string)=>{const relative=path.relative(parent,target);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
  try {
    const parsed=JSON.parse(execFileSync('findmnt',['--json','--list','--output','TARGET,FSTYPE'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:3_000,maxBuffer:512*1024}));
    const rows:any[]=[];
    const collect=(items:any[])=>{for(const item of items||[]){rows.push(item);collect(item.children||[]);}};
    collect(parsed?.filesystems||[]);
    let accepted=0;
    for(const item of rows) {
      if(accepted>=16)break;
      const target=typeof item?.target==='string'?path.resolve(item.target):'';
      const fstype=String(item?.fstype||'').toLowerCase();
      const explicitlyPermitted=permittedParents.some(parent=>inside(parent,target));
      const deniedTarget=deniedPaths.some(blocked=>blocked==='/'?target==='/':inside(blocked,target));
      if(!target||deniedFileSystems.has(fstype)||(deniedTarget&&!explicitlyPermitted))continue;
      let owned=false;
      try{owned=uid!==undefined&&fs.statSync(target).uid===uid;}catch{continue;}
      if(!owned&&!explicitlyPermitted)continue;
      const before=roots.length;add(target,false);if(roots.length>before)accepted++;
    }
  } catch {}
  return roots;
}

// Explicit local operator opt-in; cloud selection and lease checks still apply.
export function pollOnlyRepository(repo: string) {
  const selected=fs.realpathSync(repo);
  const approved=JSON.parse(process.env.EMPLOYEE_TRACE_POLL_ONLY_REPOSITORIES || '{}');
  if (!approved || typeof approved!=='object' || Array.isArray(approved)) throw new Error('Invalid poll-only repository opt-in');
  const c=loadConfig();
  const binding=crypto.createHash('sha256').update(JSON.stringify([c.serverUrl,c.agentId,c.agentToken])).digest('hex');
  const saved=(c as any).pollOnlyConsent;
  const durable=saved?.binding===binding && saved?.repositories && typeof saved.repositories==='object' ? saved.repositories : {};
  const fingerprint=Object.prototype.hasOwnProperty.call(approved,selected) ? approved[selected] : selected===process.env.EMPLOYEE_TRACE_POLL_ONLY_REPOSITORY ? process.env.EMPLOYEE_TRACE_POLL_ONLY_FINGERPRINT : Object.prototype.hasOwnProperty.call(durable,selected) ? durable[selected] : undefined;
  if (fingerprint===undefined) return false;
  if (typeof fingerprint!=='string' || repositoryFingerprint(repo)!==fingerprint) throw new Error('Poll-only repository identity changed; explicit opt-in required');
  const directory=path.join(selected,'.git','hooks');
  for (const hook of hooks) {
    for (const suffix of ['.employee-trace-owner','.employee-trace-original']) {
      if (fs.existsSync(path.join(directory,hook+suffix))) throw new Error('Existing Employee Trace hook ownership conflicts with poll-only mode');
    }
  }
  return true;
}
export function persistPollOnlyConsent(repo: string, expected: string, enabled=true) {
  const selected=fs.realpathSync(repo),c=loadConfig();
  if(!/^etn_[A-Za-z0-9_-]{43}$/.test(c.agentToken||'') || repositoryFingerprint(selected)!==expected) throw new Error('Current Node identity and exact fingerprint required');
  if(!c.watchedPaths.some(root=>{const r=path.relative(fs.realpathSync(root),selected);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));})) throw new Error('Explicit watched root required');
  const binding=crypto.createHash('sha256').update(JSON.stringify([c.serverUrl,c.agentId,c.agentToken])).digest('hex');
  if(!mutateCurrentBinding(c,current=>{
    const saved=(current as any).pollOnlyConsent;
    const repositories={...(saved?.binding===binding?saved.repositories:{})};
    if(enabled){if(Object.keys(repositories).length>=64&&!repositories[selected])throw new Error('Poll-only consent limit');repositories[selected]=expected;}else delete repositories[selected];
    (current as any).pollOnlyConsent={binding,repositories};
  })) throw new Error('Node identity changed');
}
export function assertGitBoundary(repo: string) {
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
  if (pollOnlyRepository(repo)) return;
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
export function migrateLegacyHooks(repo: string) {
  assertGitBoundary(repo);
  const directory=path.join(fs.realpathSync(repo),'.git','hooks');
  if(!fs.existsSync(directory)) return false;
  const kinds:Record<string,string>={"post-commit":"commit","post-checkout":"branch","post-merge":"merge","post-rewrite":"rewrite","pre-push":"push"};
  const plans:Array<{target:string;owner:string;original:string;nextOriginal:string}>=[];
  for(const hook of hooks) {
    const target=path.join(directory,hook),owner=target+'.tracemini-owner',original=target+'.tracemini-original';
    const present=(p:string)=>{try{fs.lstatSync(p);return true;}catch{return false;}};
    if(!present(owner)&&!present(original))continue;
    if(!present(owner)||!present(target))throw new Error('Unverifiable legacy hook; explicit local cleanup required');
    for(const p of [target,owner,...(present(original)?[original]:[])])if(fs.lstatSync(p).isSymbolicLink()||!fs.lstatSync(p).isFile())throw new Error('Unsafe legacy hook; explicit local cleanup required');
    if(present(target+'.employee-trace-owner')||present(target+'.employee-trace-original'))throw new Error('Conflicting hook ownership; explicit local cleanup required');
    const content=fs.readFileSync(target,'utf8'),owned=fs.readFileSync(owner,'utf8').trim();
    const common=['#!/bin/sh','# TraceMini managed hook','original="$0.tracemini-original"'];
    const quote=String.fromCharCode(39);
    const expected=hook==='pre-push'
      ? [...common,'input="$(mktemp "'+'$'+'{TMPDIR:-/tmp}/tracemini-push.XXXXXX")" || exit 1',"trap "+quote+"rm -f \\\"$input\\\""+quote+" EXIT HUP INT TERM",'cat >"$input"','if [ -x "$original" ]; then "$original" "$@" <"$input" || exit $?; fi','command -v tracemini >/dev/null 2>&1 && tracemini event --repo "$(git rev-parse --show-toplevel)" --type '+kinds[hook]+' --hook '+hook+' "$@" <"$input" >/dev/null 2>&1 || true','exit 0',''].join('\\n')
      : [...common,'if [ -x "$original" ]; then "$original" "$@" || exit $?; fi','command -v tracemini >/dev/null 2>&1 && tracemini event --repo "$(git rev-parse --show-toplevel)" --type '+kinds[hook]+' --hook '+hook+' "$@" >/dev/null 2>&1 || true','exit 0',''].join('\\n');
    if(content!==expected||owned!==crypto.createHash('sha256').update(content).digest('hex'))throw new Error('Legacy hook changed; explicit local cleanup required');
    plans.push({target,owner,original,nextOriginal:target+'.employee-trace-original'});
  }
  if(!plans.length)return false;
  for(const plan of plans) {
    if(fs.existsSync(plan.original))fs.renameSync(plan.original,plan.nextOriginal);
    fs.unlinkSync(plan.target);fs.unlinkSync(plan.owner);
  }
  return true;
}
`;
 }
 return source;
}
