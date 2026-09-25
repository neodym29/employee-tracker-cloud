import http from 'node:http';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
const {linuxInstaller}=await import('file://'+path.resolve('build/tracemini/installer.mjs'));
const calls=[];
const state={syncEnabled:false,state:'pending_sync',capability:'node-git-v1'};
const server=http.createServer(async(req,res)=>{
 let text=''; for await(const c of req)text+=c;
 calls.push(req.url);
 const value=req.url==='/api/agents/install/exchange'?{...state,agentId:1,workspaceId:1,agentToken:'etn_'+'a'.repeat(43),created:true}:req.url==='/api/agents/git/sync'?{work:[],contextId:1,workspaceIds:[]}:state;
 res.setHeader('content-type','application/json');res.end(JSON.stringify(value));
});
await new Promise(r=>server.listen(9876,'127.0.0.1',r));
function run(cmd,args){return new Promise((resolve,reject)=>{const p=spawn(cmd,args,{stdio:['ignore','pipe','pipe']});let output='';p.stdout.on('data',c=>output+=c);p.stderr.on('data',c=>output+=c);p.on('close',code=>resolve({code,output}));p.on('error',reject);});}
try {
 fs.writeFileSync('/tmp/install.sh',linuxInstaller('build/tracemini/cli','http://localhost:9876','fixture-install-only'));
 const normal=await run('sh',['/tmp/install.sh','--no-watched-dirs']);
 assert.notEqual(normal.code,0,'default must reject container without systemd');
 assert.match(normal.output,/systemctl is required/);
 const installed=await run('sh',['/tmp/install.sh','--no-service','--isolated-home','/tmp/isolated-collector','--no-watched-dirs']);
 assert.equal(installed.code,0,installed.output);
 assert.match(installed.output,/Not running/);
 assert.equal(fs.existsSync('/tmp/isolated-collector/.config/systemd/user/employee-trace.service'),false);
 assert.equal(fs.existsSync('/root/.employee-trace'),false);
 const before=calls.filter(x=>x==='/api/agents/git/sync').length;
 const collector=spawn('/tmp/isolated-collector/.local/bin/employee-trace',['start'],{stdio:['ignore','pipe','pipe']});
 let output='';collector.stdout.on('data',c=>output+=c);collector.stderr.on('data',c=>output+=c);
 try {
  const deadline=Date.now()+12000;
  while(calls.filter(x=>x==='/api/agents/git/sync').length<=before && Date.now()<deadline) await new Promise(r=>setTimeout(r,50));
  assert.ok(calls.filter(x=>x==='/api/agents/git/sync').length>before,output);
 } finally {collector.kill('SIGTERM'); await new Promise(r=>collector.once('close',r));}
 const repeat=await run('sh',['/tmp/install.sh','--no-service','--isolated-home','/tmp/isolated-collector','--no-watched-dirs']);
 assert.notEqual(repeat.code,0);assert.match(repeat.output,/refusing existing state/);
 console.log('PASS real container: default refusal, installer -> exchange -> installed executable start -> authenticated poll; no systemctl substitute; no service or host state; repeat refused');
 console.log('Fixture HTTP calls:',JSON.stringify(calls));
} finally {server.close();}
