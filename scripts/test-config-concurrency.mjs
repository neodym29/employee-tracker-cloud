import {build} from 'esbuild';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'et-config-race-'));
await build({stdin:{contents:"export {loadConfig,saveConfig,mutateCurrentBinding} from './config.ts';export {reconcileAuthorizedWorkspaces} from './agent.ts';",resolveDir:path.resolve('build/tracemini/stage')},bundle:true,platform:'node',format:'esm',outfile:dir+'/engine.mjs'});
const clone={path:'/nonexistent/qa-alpha',workspaceId:41,repositoryId:139,repositoryFingerprint:'a'.repeat(64)};
const base={serverUrl:'https://fixture.invalid',agentId:2,agentToken:'fixture',watchedPaths:[],clones:[],pollMs:60000};
const env={...process.env,EMPLOYEE_TRACE_HOME:dir};
function run(code){const r=spawnSync(process.execPath,['--input-type=module','-e',`import {loadConfig,saveConfig,mutateCurrentBinding,reconcileAuthorizedWorkspaces} from ${JSON.stringify('file://'+dir+'/engine.mjs')};import fs from 'node:fs';${code}`],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
let failures=[];
for(const mode of ['stale-authority-removes-concurrent-enrollment','stale-daemon-resurrects-stop','changed-binding']){
 fs.writeFileSync(dir+'/config.json',JSON.stringify({...base,clones:mode==='stale-daemon-resurrects-stop'?[clone]:[]}));
 // Distinct processes model snapshot acquisition followed by interactive activation/stop.
 run(`fs.writeFileSync(${JSON.stringify(dir+'/snapshot')},JSON.stringify(loadConfig()));`);
 run(mode==='changed-binding'?`const c=loadConfig();c.agentToken='new-credential';c.clones=[];saveConfig(c,{replaceRepositoryState:true});`:`const c=loadConfig();mutateCurrentBinding(c,current=>{current.clones=${JSON.stringify(mode==='stale-daemon-resurrects-stop'?[]:[clone])}});`);
 run(`const stale=JSON.parse(fs.readFileSync(${JSON.stringify(dir+'/snapshot')},'utf8'));${mode==='stale-authority-removes-concurrent-enrollment'?'reconcileAuthorizedWorkspaces(stale,[],new Map());':'saveConfig(stale,{preserveCurrentScalars:true});'}`);
 const actual=JSON.parse(fs.readFileSync(dir+'/config.json'));
 try{assert.equal(actual.clones.length,mode==='stale-authority-removes-concurrent-enrollment'?1:0);if(mode==='changed-binding')assert.equal(actual.agentToken,'new-credential');console.log('PASS',mode)}catch(e){failures.push(mode);console.error('FAIL',mode,e.message)}
}
fs.rmSync(dir,{recursive:true,force:true});assert.deepEqual(failures,[]);
