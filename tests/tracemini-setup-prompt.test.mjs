import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {build} from 'esbuild';
test('server prompt embeds exact per-user command and bounded automatic setup contract',async()=>{
 assert.ok(fs.existsSync('lib/tracemini-setup-prompt.ts'),'server-side setup prompt generator exists');
 const {outputFiles}=await build({entryPoints:['lib/tracemini-setup-prompt.ts'],bundle:true,write:false,platform:'node',format:'esm'});
 const {agentSetupPrompt}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
 const {linuxInstallCommand}=await import('../build/tracemini/installer.mjs');
 const one=linuxInstallCommand('https://example.test','user-one-secret'),two=linuxInstallCommand('https://example.test','user-two-secret');
 const prompt=agentSetupPrompt(one);
 assert.ok(prompt.includes(one));assert.ok(!prompt.includes('user-two-secret'));assert.ok(!agentSetupPrompt(two).includes('user-one-secret'));
 for(const term of ['--watched-dir','--no-watched-dirs','employee-trace watch','symlink','metadata-only','worktrees','100000','credentials','skipped','Do not ask','git init','telemetry'])assert.ok(prompt.includes(term),term);
 const route=fs.readFileSync('lib/tracemini-install-http.ts','utf8');assert.match(route,/setupPrompt:agentSetupPrompt\(installCommand\)/);
 const ui=fs.readFileSync('app/components/trace-node/Install.tsx','utf8');assert.match(ui,/command=\{installation.setupPrompt\}/);assert.match(ui,/Copy agent setup prompt/);
});
test('exact generated prompt command forwards paths through POST installer and FD into real compiled setup',async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-real-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const repos=['project one',"project ' two"].map(n=>path.join(tmp,n));
 for(const repo of repos){fs.mkdirSync(repo);execFileSync('git',['init',repo],{stdio:'ignore'});}
 const bin=path.join(tmp,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'systemctl'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 const {linuxInstallCommand,linuxInstaller}=await import('../build/tracemini/installer.mjs');
 let origin;const wire=[];
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;wire.push(req.url);let result={};
 if(req.url==='/api/installers/linux'){res.end(linuxInstaller(path.resolve('build/tracemini/cli'),origin,'test-only-private'));return;}
 if(req.url.endsWith('/exchange'))result={agentId:5,workspaceId:50,agentToken:'etn_'+'a'.repeat(43),created:true,syncEnabled:false,state:'pending_sync',capability:'node-git-v1'};
 if(req.url.endsWith('/scan'))result={work:[{kind:'scan',work_id:'1',claim_token:'fixture'}]};
 if(req.url.endsWith('/sync'))result={contextId:50,workspaceIds:[],work:[]};
 if(req.url.endsWith('/status'))result={syncEnabled:false,state:'pending_sync',capability:'node-git-v1'};
 res.setHeader('content-type','application/json');res.end(JSON.stringify(result));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));origin='http://127.0.0.1:'+server.address().port;
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 const script=path.join(tmp,'setup.sh');fs.writeFileSync(script,'set -- '+repos.map(p=>'--watched-dir '+quote(p)).join(' ')+'\n'+linuxInstallCommand(origin,'test-only-private'),{mode:0o600});
 const result=await promisify(execFile)('/bin/bash',[script],{env:{...process.env,HOME:tmp,EMPLOYEE_TRACE_HOME:path.join(tmp,'state'),PATH:bin+':'+process.env.PATH},timeout:20000});
 assert.doesNotMatch(result.stdout,/Paste a folder/);assert.match(result.stdout,/installation completed successfully/);
 const config=JSON.parse(fs.readFileSync(path.join(tmp,'state/config.json'),'utf8'));assert.deepEqual(config.watchedPaths,repos);
 assert.ok(wire.includes('/api/agents/install/exchange'));assert.ok(!wire.some(p=>/activity|register|selection/.test(p)));
 for(const repo of repos)assert.ok(!fs.existsSync(path.join(repo,'.git/hooks/post-commit')));
});

test('compiled setup accepts repeated roots without reading stdin, rejects bad explicit roots before enrollment',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-cli-'));
 try {
 const bin=path.join(tmp,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'systemctl'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 const result=spawnSync(process.execPath,['build/tracemini/cli/index.js','setup','--watched-dir',path.join(tmp,'missing')],{env:{...process.env,HOME:tmp,EMPLOYEE_TRACE_HOME:path.join(tmp,'state'),PATH:bin+':'+process.env.PATH},input:'',encoding:'utf8',timeout:5000});
 assert.equal(result.status,1);assert.match(result.stderr,/Folder does not exist/);assert.doesNotMatch(result.stdout,/Paste a folder/);
 } finally {fs.rmSync(tmp,{recursive:true,force:true});}
});
