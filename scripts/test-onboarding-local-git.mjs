import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'onboarding-git-'));
process.env.HOME=root;process.env.EMPLOYEE_TRACE_HOME=path.join(root,'state');
try {
 const {safeRepositoryKey}=await import('../build/tracemini/transport.mjs');
 const {inspectRepo,repositoryFingerprint}=await import('../build/tracemini/git.mjs');
 const bare=path.join(root,'bare.git');execFileSync('git',['init','--bare',bare],{stdio:'ignore'});
 for(const [i,remote] of [undefined,bare,'file://'+bare].entries()) {
  const repo=path.join(root,'repo'+i);execFileSync('git',['init',repo],{stdio:'ignore'});
  if(remote)execFileSync('git',['-C',repo,'remote','add','origin',remote]);
  const info=inspectRepo(repo), digest=repositoryFingerprint(repo);
  assert.match(digest,/^[a-f0-9]{64}$/);
  const key=safeRepositoryKey(info.remoteUrl,'a'.repeat(64));
  assert.equal(key,'local:'+'a'.repeat(64));assert.ok(!key.includes(root));
 }
 console.log('PASS actual Git fixtures: no remote, absolute bare origin, file:// bare origin map to opaque device-local keys; no path sent');
} finally {fs.rmSync(root,{recursive:true,force:true});}
