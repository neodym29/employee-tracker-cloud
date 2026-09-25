import {build} from 'esbuild';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'et-remote-'));process.env.EMPLOYEE_TRACE_HOME=dir;
await build({stdin:{contents:"export {api} from './api.ts';export {loadConfig,saveConfig} from './config.ts';export {repositoryFingerprint,normalizeRemote} from './git.ts';export {reconcileConfiguredCloneIdentities} from './agent.ts';",resolveDir:path.resolve('build/tracemini/stage')},bundle:true,platform:'node',format:'esm',outfile:dir+'/engine.mjs'});
const e=await import('file://'+dir+'/engine.mjs');const repo=dir+'/repo';fs.mkdirSync(repo);execFileSync('git',['init',repo],{stdio:'ignore'});
const digest=e.repositoryFingerprint(repo),token='etn_'+'a'.repeat(43),serverUrl='http://127.0.0.1:1';
let c={serverUrl,agentId:2,agentToken:token,watchedPaths:[repo],clones:[],pollMs:60000};e.saveConfig(c,{replaceRepositoryState:true});
const scope=crypto.createHash('sha256').update(serverUrl+'\0'+token).digest('hex');const md=dir+'/cloud-git/'+scope;fs.mkdirSync(md,{recursive:true});
const m={localPath:repo,digest,key:'local:'+crypto.createHmac('sha256',token).update(repo+'\0'+digest).digest('hex'),normalized:e.normalizeRemote('local:'+repo),candidate:'139',project:41,revision:4,claim:'fixture'};
fs.writeFileSync(md+'/'+digest+'.json',JSON.stringify(m));
globalThis.fetch=async(url)=>new Response(JSON.stringify(url.endsWith('/sync')?{work:[],workspaceIds:[41]}:{registered:true,candidate_id:'139',project_id:41,revision:4,claim_token:'fixture'}));
await e.api(c,'/api/agents/sync');c=e.loadConfig();assert.equal(c.clones.length,1,'authorized recovery');await e.reconcileConfiguredCloneIdentities(c,new Map());assert.equal(e.loadConfig().clones.length,1,'recovered local clone survives identity reconciliation');
assert.equal(c.clones[0].normalizedRemote,e.normalizeRemote('local-device-2:'+repo));
for(const remote of ['local-device-3:'+repo,'local-device-2:/wrong-path']) {c=e.loadConfig();c.clones[0].normalizedRemote=remote;e.saveConfig(c,{replaceRepositoryState:true});await e.reconcileConfiguredCloneIdentities(c,new Map()).catch(()=>{});assert.equal(e.loadConfig().clones.length,0,'reject wrong device/path');await e.api(e.loadConfig(),'/api/agents/sync');}
console.log('PASS validated recovery survives; wrong device/path rejected');fs.rmSync(dir,{recursive:true,force:true});
