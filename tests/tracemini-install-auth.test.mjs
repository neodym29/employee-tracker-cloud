import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
import {createServer} from 'node:http';
import {gunzipSync} from 'node:zlib';
import {build} from 'esbuild';
import pg from 'pg';

const root=process.cwd();
const commandToken=command=>JSON.parse(command.match(/printf %s '([^']+)'/)[1]).installToken;
test('real PostgreSQL Node enrollment routes, upstream transport, archive and replay protection', async t=>{
  assert.ok(fs.existsSync('lib/tracemini-install.ts'), 'cloud Node installation adapter must exist');
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'trace-auth-'));
  const id=execFileSync('docker',['run','-d','--rm','-e','POSTGRES_PASSWORD=test','-e','POSTGRES_DB=test','-P','postgres:16-alpine'],{encoding:'utf8'}).trim();
  let pool,server;
  let observingHome;
  const beforeDownload=[];
  const requests=[];
  t.after(async()=>{if(server?.listening)await new Promise(r=>server.close(r));await pool?.end();execFileSync('docker',['rm','-f',id],{stdio:'ignore'});fs.rmSync(tmp,{recursive:true,force:true});});
  const port=execFileSync('docker',['port',id,'5432/tcp'],{encoding:'utf8'}).trim().split('\n')[0].split(':').pop();
  pool=new pg.Pool({host:'127.0.0.1',port:Number(port),user:'postgres',password:'test',database:'test'});
  for(let n=0;;n++){try{await pool.query('select 1');break;}catch(e){if(n>50)throw e;await new Promise(r=>setTimeout(r,100));}}
  await pool.query(`create table companies(id bigint primary key); create table app_users(id bigint primary key,company_id bigint references companies(id),email text,approval_status text); insert into companies values(1),(2); insert into app_users values(1,1,'one@example.test','approved'),(2,2,'two@example.test','approved'); create table files_agent_devices(id bigint primary key,credential_hash text); insert into files_agent_devices values(1,'python-unchanged');`);
  const schema=fs.readFileSync('migrations/021_tracemini_node_install.sql','utf8'); await pool.query(schema);await pool.query(schema);
  globalThis.__tracePool=pool; globalThis.__traceSession={id:'1',company_id:'1',email:'one@example.test',account_type:'engineer',role:'employee'};
  const outfile=path.join(root,'build/tracemini/install-routes-test.mjs');
  await build({stdin:{contents:`export * as installations from './app/api/agents/installations/route'; export * as download from './app/api/installers/linux/route'; export * as installer from './app/api/installers/linux/[token]/route'; export * as exchange from './app/api/agents/install/exchange/route'; export * as abort from './app/api/agents/install/abort/route'; export * as status from './app/api/agents/status/route';`,resolveDir:root},bundle:true,platform:'node',format:'esm',packages:'external',outfile,plugins:[{name:'test-boundaries',setup(b){b.onResolve({filter:/^next\/server$/},()=>({path:'next/server.js',external:true}));b.onResolve({filter:/\/db$|^\.\/db$/},()=>({path:'db',namespace:'fixture'}));b.onResolve({filter:/\/auth$|^\.\/auth$/},()=>({path:'auth',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='db'?'export const getPool=()=>globalThis.__tracePool; export const ensureSchema=async()=>{};':'export const currentSession=async()=>globalThis.__traceSession;'}));}}]});
  const routes=await import('file://'+outfile+'?t='+Date.now());
  const {NextRequest}=await import('next/server.js');
  server=createServer(async(req,res)=>{try{let body='';for await(const c of req)body+=c;const url=new URL(req.url,process.env.NEXT_PUBLIC_APP_URL);const request=new NextRequest(url,{method:req.method,headers:req.headers,...(body?{body}:{})});const pathname=url.pathname;let result;
    if(pathname==='/api/agents/installations') result=await routes.installations[req.method](request);
    else if(pathname==='/api/installers/linux') {
      requests.push({url:req.url,method:req.method,body});
      if(observingHome)for(const name of fs.readdirSync(observingHome).filter(n=>n.startsWith('.employee-trace-install.'))) {
        const dir=path.join(observingHome,name);
        beforeDownload.push({mode:fs.statSync(dir).mode & 0o777,files:fs.readdirSync(dir)});
      }
      result=await routes.download[req.method](request);
    }
    else if(pathname.startsWith('/api/installers/linux/')) result=await routes.installer.GET(request);
    else if(pathname==='/api/agents/install/exchange') result=await routes.exchange.POST(request);
    else if(pathname==='/api/agents/install/abort') result=await routes.abort.POST(request);
    else if(pathname==='/api/agents/status') result=await routes.status.GET(request);
    else {res.writeHead(404).end();return;}
    res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());
  }catch{res.writeHead(500).end('fixture failed');}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;process.env.NEXT_PUBLIC_APP_URL=origin;
  const call=(url,body,extra={})=>fetch(origin+url,{method:'POST',headers:{'content-type':'application/json',origin,...extra},body:JSON.stringify(body)});
  globalThis.__traceSession=null;assert.equal((await call('/api/agents/installations',{})).status,401);
  globalThis.__traceSession={id:'1',company_id:'1',email:'one@example.test'};
  assert.equal((await call('/api/agents/installations',{}, {origin:'https://evil.test'})).status,403);
  assert.equal((await call('/api/agents/installations',{workspaceId:1})).status,400);
  const mint=await call('/api/agents/installations',{});assert.equal(mint.status,200);assert.match(mint.headers.get('cache-control'),/no-store/);
  const installation=await mint.json();assert.equal(installation.state,'pending_sync');assert.match(installation.installCommand,/curl/);assert.doesNotMatch(installation.installCommand,/zip|files-agent\/package/);
  const token=commandToken(installation.installCommand);
  const stored=(await pool.query('select * from tracemini_node_installations')).rows[0];assert.notEqual(stored.token_hash,token);assert.equal(stored.token_hash.length,64);
  assert.equal((await fetch(origin+'/api/installers/linux/'+token)).status,410);
  assert.equal((await fetch(origin+'/api/installers/linux')).status,410);
  assert.equal((await call('/api/installers/linux',{})).status,403);
  assert.equal((await call('/api/installers/linux',{installToken:token,extra:true})).status,400);
  assert.equal((await call('/api/installers/linux?token='+token,{installToken:token})).status,400);
  const download=await call('/api/installers/linux',{installToken:token});assert.equal(download.status,200);assert.match(download.headers.get('cache-control'),/no-store/);const script=await download.text();assert.match(script,/rollback\(\)/);assert.match(script,/employee-trace/);assert.doesNotMatch(script,/sudo apt|Installing OCR/);
  const payload=script.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| gzip -d/);assert.ok(payload);assert.equal(gunzipSync(Buffer.from(payload[1],'base64')).toString(),fs.readFileSync('build/tracemini/cli/index.js','utf8'));
  const {api}=await import('file://'+root+'/build/tracemini/transport.mjs?t='+Date.now());
  const exchangeBody={installToken:token,installationId:'a'.repeat(64),machineName:'fixture'};
  const config={serverUrl:origin};
  const responses=await Promise.allSettled([api(config,'/api/agents/install/exchange',{method:'POST',body:JSON.stringify(exchangeBody)}),api(config,'/api/agents/install/exchange',{method:'POST',body:JSON.stringify(exchangeBody)})]);
  assert.equal(responses.filter(r=>r.status==='fulfilled').length,1);const device=responses.find(r=>r.status==='fulfilled').value;
  assert.ok(Number.isSafeInteger(device.agentId));assert.ok(Number.isSafeInteger(device.workspaceId));assert.equal(device.state,'pending_sync');assert.match(device.agentToken,/^etn_/);
  assert.equal((await call('/api/installers/linux',{installToken:token})).status,403);
  const ready=await api({...config,agentToken:device.agentToken},'/api/agents/status');assert.equal(ready.state,'pending_sync');assert.equal(ready.syncEnabled,false);
  await assert.rejects(api({...config,agentToken:'fad_python'},'/api/agents/status'));
  await assert.rejects(api(config,'/api/agents/heartbeat',{method:'POST',body:'{}'}),/no synchronization acknowledged/);
  // Enrollment is not proof that the Git API exists: this server deliberately
  // returns 404 for it, and the real authenticated transport must reject that.
  await assert.rejects(api({...config,agentToken:device.agentToken},'/api/agents/sync'),/no synchronization acknowledged/);
  const home=path.join(tmp,'missing-api-home');
  const cliEnv={...process.env,EMPLOYEE_TRACE_HOME:home};
  const cli=path.join(root,'build/tracemini/cli/index.js');
  await assert.rejects(run(process.execPath,[cli,'sync'],{env:cliEnv}),e=>e.code===1 && /requires generated --server and --install-token/.test(e.stderr));
  assert.deepEqual(fs.readdirSync(home),[]); // Missing arguments must not enroll or persist credentials.
  const configPath=path.join(home,'config.json');
  const saved=JSON.stringify({...config,agentToken:device.agentToken,agentId:device.agentId,workspaceId:device.workspaceId,watchedPaths:[],clones:[]});
  fs.writeFileSync(configPath,saved,{mode:0o600});
  await assert.rejects(run(process.execPath,[cli,'sync','--server',origin,'--install-token',token],{env:cliEnv}),e=>e.code===1 && /no synchronization acknowledged/.test(e.stderr));
  assert.equal(fs.readFileSync(configPath,'utf8'),saved,'missing Git API must not replace the current binding');
  const list=await (await fetch(origin+'/api/agents/installations')).json();assert.equal(list.agents.length,1);assert.equal(list.agents[0].status,'pending_sync');assert.ok(!JSON.stringify(list).includes(device.agentToken));assert.ok(!JSON.stringify(list).includes('installationId'));
  globalThis.__traceSession={id:'2',company_id:'2',email:'two@example.test'};assert.equal((await (await fetch(origin+'/api/agents/installations')).json()).agents.length,0);
  globalThis.__traceSession={id:'1',company_id:'1',email:'one@example.test'};
  await pool.query("update app_users set approval_status='pending' where id=1");await assert.rejects(api({...config,agentToken:device.agentToken},'/api/agents/status'));await pool.query("update app_users set approval_status='approved' where id=1");
  await api({...config,agentToken:device.agentToken},'/api/agents/install/abort',{method:'POST'});await assert.rejects(api({...config,agentToken:device.agentToken},'/api/agents/status'));
  // Execute the exact generated copy command with real curl, route, embedded
  // Node CLI and PostgreSQL exchange. Only systemctl is stubbed; absent Git API
  // deliberately exercises the original setup abort/rollback transaction.
  const generated=await (await call('/api/agents/installations',{})).json();
  const commandHome=path.join(tmp,'command-home'),bin=path.join(tmp,'command-bin');
  fs.mkdirSync(commandHome);fs.mkdirSync(bin);
  const sentinel=path.join(tmp,'sentinel');fs.writeFileSync(sentinel,'unchanged');
  fs.mkdirSync(path.join(commandHome,'.cache/employee-trace'),{recursive:true});
  fs.symlinkSync(sentinel,path.join(commandHome,'.cache/employee-trace/install.sh'));
  fs.writeFileSync(path.join(bin,'systemctl'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  fs.writeFileSync(path.join(bin,'curl'),'#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/curl-argv"\nexec /usr/bin/curl "$@"\n',{mode:0o755});
  fs.writeFileSync(path.join(bin,'sh'),'#!/bin/sh\nstat -c "%a" "$1" "$(dirname "$1")" > "$HOME/download-modes"\nprintf "%s" "$1" > "$HOME/download-path"\nexec /bin/sh "$@"\n',{mode:0o755});
  fs.writeFileSync(path.join(bin,'node'),`#!/bin/sh
if [ "\${2:-}" = setup ]; then
  printf '%s\\n' "$@" > "$HOME/setup-argv"
  env > "$HOME/setup-env"
  readlink /proc/$$/fd/3 > "$HOME/setup-fd" || true
fi
exec ${process.execPath} "$@"
`,{mode:0o755});
  const commandEnv={...process.env,HOME:commandHome,EMPLOYEE_TRACE_HOME:path.join(commandHome,'state'),PATH:bin+':'+process.env.PATH};
  requests.length=0;
  observingHome=commandHome;
  const actual=run('/bin/sh',['-c',generated.installCommand],{env:commandEnv,timeout:20000});
  actual.child.stdin.end(commandHome+'\nn\n');
  await assert.rejects(actual,error=>error.code===1 && /rolling back/.test(error.stderr));
  const setupArgv=fs.readFileSync(path.join(commandHome,'setup-argv'),'utf8');
  assert.ok(!setupArgv.includes(commandToken(generated.installCommand)),'setup credential must not appear in child argv');
  assert.ok(!fs.readFileSync(path.join(commandHome,'setup-env'),'utf8').includes(commandToken(generated.installCommand)),'setup credential must not appear in environment');
  assert.match(setupArgv,/--install-token-fd\n3\n/);
  assert.doesNotMatch(setupArgv,/--install-token\n/);
  assert.match(fs.readFileSync(path.join(commandHome,'setup-fd'),'utf8'),/\(deleted\)/);
  assert.deepEqual(requests,[{url:'/api/installers/linux',method:'POST',body:JSON.stringify({installToken:commandToken(generated.installCommand)})}]);
  assert.equal(fs.readFileSync(path.join(commandHome,'download-modes'),'utf8'),'600\n700\n');
  assert.deepEqual(beforeDownload,[{mode:0o700,files:[]}],'private directory exists before curl receives script bytes');
  assert.doesNotMatch(fs.readFileSync(path.join(commandHome,'curl-argv'),'utf8'),/eti_/);
  assert.equal(fs.existsSync(fs.readFileSync(path.join(commandHome,'download-path'),'utf8')),false);
  assert.equal(fs.readFileSync(sentinel,'utf8'),'unchanged');
  assert.equal(fs.existsSync(path.join(commandHome,'.local/share/employee-trace/cli')),false);
  assert.equal(fs.existsSync(path.join(commandHome,'state/config.json')),false);
  assert.ok((await pool.query('select used_at from tracemini_node_installations order by id desc limit 1')).rows[0].used_at,'real embedded CLI exchanged the body credential before rollback');
  fs.unlinkSync(path.join(commandHome,'download-path'));
  await assert.rejects(run('/bin/sh',['-c',generated.installCommand],{env:commandEnv}),error=>error.code===22);
  assert.equal(fs.existsSync(path.join(commandHome,'download-path')),false,'replay must not execute a script');
  assert.deepEqual(fs.readdirSync(commandHome).filter(n=>n.startsWith('.employee-trace-install.')),[]);
  // A successful child status is also preserved and its credential file removed.
  // Real embedded execution and rollback were verified above; this child only
  // isolates the outer command's successful cleanup branch.
  const successful=await (await call('/api/agents/installations',{})).json();
  fs.writeFileSync(path.join(bin,'sh'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  await run('/bin/sh',['-c',successful.installCommand],{env:commandEnv});
  assert.deepEqual(fs.readdirSync(commandHome).filter(n=>n.startsWith('.employee-trace-install.')),[]);
  observingHome=undefined;
  const expired=await (await call('/api/agents/installations',{})).json();const expiredToken=commandToken(expired.installCommand);await pool.query("update tracemini_node_installations set expires_at=now()-interval '1 second' where used_at is null");assert.equal((await call('/api/agents/install/exchange',{...exchangeBody,installToken:expiredToken})).status,403);
  assert.equal((await call('/api/installers/linux',{installToken:expiredToken})).status,403);
  assert.equal((await pool.query('select credential_hash from files_agent_devices')).rows[0].credential_hash,'python-unchanged');
  assert.equal((await pool.query("select count(*)::int as n from information_schema.tables where table_name='projects'")).rows[0].n,0);
});
