import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {spawn,spawnSync} from 'node:child_process';import assert from 'node:assert/strict';
const cli=path.resolve('build/tracemini/cli/index.js');
const wait=async f=>{const end=Date.now()+12000;while(!f()){if(Date.now()>end)throw Error('barrier timeout');await new Promise(r=>setTimeout(r,25));}};
for(const mode of ['concurrent-grant','stop-no-resurrection','credential-change',...(process.env.TEST_SAME_ROOT?['same-root-reactivation']:[])]){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'et-full-race-')),repo=tmp+'/repo',home=tmp+'/state';fs.mkdirSync(repo);fs.mkdirSync(home);
 const git=(...a)=>{let r=spawnSync('git',['-C',repo,...a],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};git('init');git('config','user.name','QA');git('config','user.email','qa@example.invalid');fs.writeFileSync(repo+'/file','nonempty fixture\n');git('add','.');git('commit','-m','Fixture change');
 let mapping,held,hold=false,selection=false,desired=true,revision=1,completions=0,requests=[];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw||'{}'),op=req.url.split('/').pop();requests.push(op);const send=x=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(x));};
 if(op==='scan')return send({work:[{kind:'scan',work_id:'1',claim_token:'scan'}]});
 if(op==='candidates'){mapping=b.repositories[0];return send({});}
 if(op==='sync'){if(hold&&!held){held=()=>send({work:[],workspaceIds:(mode==='concurrent-grant'||mode==='same-root-reactivation')?[]:[41]});return;}return send({work:selection?[{kind:'selection',work_id:'139',claim_token:'claim'+revision,revision,desired_tracking:desired,repository_key:mapping.repository_key,fingerprint:mapping.fingerprint,project_id:'41'}]:[],workspaceIds:[41]});}
 if(op==='register')return send({id:139,name:'repo'});
 if(op==='registration-status')return send({registered:false});
 if(op==='complete'){if(b.kind==='selection'){assert.equal(b.error,undefined);completions++;selection=false;}return send({});}
 if(op==='report-poll')return send({job:null});return send({});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const config={serverUrl:`http://127.0.0.1:${server.address().port}`,agentId:2,agentToken:'etn_'+'a'.repeat(43),workspaceId:1,watchedPaths:[repo],clones:[],pollMs:60000};fs.writeFileSync(home+'/config.json',JSON.stringify(config));
 const env={...process.env,HOME:tmp,EMPLOYEE_TRACE_HOME:home};const children=[];
 const start=(...a)=>{let p=spawn(process.execPath,[cli,...a],{env});children.push(p);p.out='';p.stdout.on('data',x=>p.out+=x);p.stderr.on('data',x=>p.out+=x);return p;};
 const done=p=>new Promise((resolve,reject)=>{p.on('exit',c=>c===0?resolve():reject(Error(p.out)));});
 try{await done(start('project-discover',repo));if(mode!=='concurrent-grant'){selection=true;await done(start('project-activate',repo,'41'));assert.equal(JSON.parse(fs.readFileSync(home+'/config.json')).clones.length,1);}
 hold=true;const daemon=start('start');await wait(()=>held);
 if(mode==='credential-change'){let c=JSON.parse(fs.readFileSync(home+'/config.json'));c.agentToken='etn_'+'b'.repeat(43);c.clones=[];fs.writeFileSync(home+'/config.json',JSON.stringify(c));}
 else {selection=true;desired=(mode==='concurrent-grant'||mode==='same-root-reactivation');revision++;await done(start('project-activate',repo,'41'));}
 held();await new Promise(r=>setTimeout(r,1200));assert.equal(daemon.exitCode,null,daemon.out);const actual=JSON.parse(fs.readFileSync(home+'/config.json'));assert.equal(actual.clones.length,(mode==='concurrent-grant'||mode==='same-root-reactivation')?1:0);if(mode==='credential-change')assert.equal(actual.agentToken,'etn_'+'b'.repeat(43));if((mode==='concurrent-grant'||mode==='same-root-reactivation'))assert.match(actual.clones[0].normalizedRemote,/^local-device-2\//);if(mode==='same-root-reactivation')assert.equal(actual.clones[0].registrationRevision,2);console.log('PASS compiled daemon + HTTP project-activate',mode,JSON.stringify({completions,requests}));
 }finally{for(const p of children)if(p.exitCode===null)p.kill('SIGTERM');server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});}
}
