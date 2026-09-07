import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
const exec=promisify(execFile), root=process.cwd(),cli=path.join(root,'build/tracemini/cli/index.js');
test('credential descriptor rejects unsafe, oversized, empty and ambiguous input before guided setup',t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'trace-fd-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 for(const fixture of [
  {body:'',mode:0o600}, {body:'x'.repeat(4097),mode:0o600},
  {body:'private-sentinel',mode:0o644}, {body:'private-sentinel',mode:0o600,linked:true},
  {body:'private sentinel',mode:0o600},
  {body:'private-sentinel',mode:0o600,args:['--install-token','manual']},
  {body:'private-sentinel',mode:0o600,args:['--install-token-fd','0']}
 ]) {
  const file=path.join(tmp,'credential');fs.writeFileSync(file,fixture.body);fs.chmodSync(file,fixture.mode);const fd=fs.openSync(file,'r');if(!fixture.linked)fs.unlinkSync(file);
  try {
   const result=spawnSync(process.execPath,[cli,'setup',...(fixture.args?.includes('0')?fixture.args:['--install-token-fd','3',...(fixture.args||[])])],{env:{...process.env,EMPLOYEE_TRACE_HOME:path.join(tmp,'state')},stdio:['pipe','pipe','pipe',fd],encoding:'utf8',timeout:5000});
   assert.equal(result.status,1);assert.doesNotMatch(result.stdout,/Collecting watched folders/);assert.doesNotMatch(result.stderr,/private-sentinel/);
  } finally {fs.closeSync(fd);fs.rmSync(file,{force:true});}
 }
});
test('original dispatcher watch -> once selection -> event; conflicts before registration; isolated service',async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'trace-cli-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const repo=path.join(tmp,'repo'),state=path.join(tmp,'state');fs.mkdirSync(repo);fs.mkdirSync(state);
 const git=(...a)=>execFileSync('git',['-C',repo,...a],{encoding:'utf8'}).trim();git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.test');fs.writeFileSync(path.join(repo,'private'),'secret');git('add','.');git('commit','-m','private message');git('remote','add','origin','https://github.com/acme/widget.git');
 let work=[{kind:'scan',work_id:'1',claim_token:'scan'}],candidate;const wire=[];
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const data=JSON.parse(body||'{}');const op=req.url.split('/').pop();wire.push({op,data});let result={};if(op==='sync')result={contextId:50,workspaceIds:[700],work};if(op==='candidates'){candidate=data.repositories[0];result={};}if(op==='register')result={id:2};if(op==='status')result={syncEnabled:false,state:'pending_sync',capability:'node-git-v1'};if(op==='complete'){work=[];}res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const config={serverUrl:'http://127.0.0.1:'+server.address().port,agentToken:'etn_'+'a'.repeat(43),agentId:5,workspaceId:50,watchedPaths:[],watchedRoots:[],clones:[],documents:[]};fs.writeFileSync(path.join(state,'config.json'),JSON.stringify(config));
 const bin=path.join(tmp,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'systemctl'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/systemctl.log"\n');fs.chmodSync(path.join(bin,'systemctl'),0o755);
 const env={...process.env,HOME:tmp,EMPLOYEE_TRACE_HOME:state,PATH:bin+':'+process.env.PATH};const run=(...a)=>exec(process.execPath,[cli,...a],{env,timeout:15000});
 await run('watch',repo);assert.ok(candidate?.fingerprint);assert.equal(fs.existsSync(path.join(repo,'.git/hooks/post-commit')),false);
 const select=()=>{work=[{kind:'selection',work_id:'2',claim_token:'selection',revision:1,desired_tracking:true,repository_key:candidate.repository_key,fingerprint:candidate.fingerprint,project_id:'700'}];};
 const hook=path.join(repo,'.git/hooks/post-commit');fs.writeFileSync(hook,'#!/bin/sh\n# TraceMini managed hook\n');select();await run('once');assert.equal(wire.filter(x=>x.op==='register').length,0);assert.match(fs.readFileSync(hook,'utf8'),/TraceMini/);
 fs.unlinkSync(hook);select();await run('once');assert.equal(wire.filter(x=>x.op==='register').length,1);assert.match(fs.readFileSync(hook,'utf8'),/Employee Trace/);
 await run('event','--repo',repo,'--type','commit');assert.ok(wire.some(x=>x.op==='activity'&&!x.data.history));assert.ok(!JSON.stringify(wire).includes('private message'));
 const before=wire.filter(x=>x.op==='sync').length;await assert.rejects(exec(process.execPath,[cli,'start'],{env,timeout:1200}),e=>e.killed);assert.ok(wire.filter(x=>x.op==='sync').length>before);
 await run('service-install');const unit=fs.readFileSync(path.join(tmp,'.config/systemd/user/employee-trace.service'),'utf8');assert.match(unit,/start/);assert.ok(!fs.existsSync(path.join(tmp,'.config/systemd/user/tracemini.service')));assert.match(fs.readFileSync(path.join(tmp,'systemctl.log'),'utf8'),/enable employee-trace.service/);
 const legacy=JSON.parse(fs.readFileSync(path.join(state,'config.json'),'utf8'));delete legacy.clones[0].repositoryFingerprint;fs.writeFileSync(path.join(state,'config.json'),JSON.stringify(legacy));await assert.rejects(run('once'),/reselect/);
});
test('Git-directory containment rejects external gitdir before hook write',async()=>{const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'trace-bound-'));try{const repo=path.join(tmp,'repo');execFileSync('git',['init','--separate-git-dir',path.join(tmp,'external'),repo],{stdio:'ignore'});const g=await import('../build/tracemini/git.mjs');assert.throws(()=>g.installHooks(repo),/containment|boundary/);}finally{fs.rmSync(tmp,{recursive:true,force:true});}});
