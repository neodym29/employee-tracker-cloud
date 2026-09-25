import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {AsyncLocalStorage} from 'node:async_hooks';
import {build} from 'esbuild';
import crypto from 'node:crypto';
const require=createRequire(import.meta.url);
globalThis.AsyncLocalStorage=AsyncLocalStorage;
const {NextRequest}=require('next/server');
const {workAsyncStorage}=require('next/dist/server/app-render/work-async-storage.external');
const {workUnitAsyncStorage}=require('next/dist/server/app-render/work-unit-async-storage.external');
const {createRequestStoreForAPI}=require('next/dist/server/async-storage/request-store');
const container=execFileSync('docker',['run','-d','--rm','-e','POSTGRES_PASSWORD=fixture','-e','POSTGRES_DB=fixture','-p','127.0.0.1::5432','postgres:16-alpine'],{encoding:'utf8'}).trim();
let pool;
try {
 const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8'}).trim().split(':').pop();
 process.env.DATABASE_URL=`postgres://postgres:fixture@localhost:${port}/fixture`;
 process.env.AUTH_SECRET='disposable-onboarding-fixture-only';
 await build({stdin:{contents:"export * from './lib/db'; export * from './lib/auth'; export {POST as login} from './app/api/login/route'; export {POST as create} from './app/api/projects/route';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',packages:'external',outfile:'build/qa-onboarding-cloud.cjs',plugins:[{name:'marker',setup(b){b.onResolve({filter:/^server-only$/},()=>({path:'empty',namespace:'marker'}));b.onLoad({filter:/.*/,namespace:'marker'},()=>({contents:''}));}}]});
 const cloud=require('../build/qa-onboarding-cloud.cjs');pool=cloud.getPool();
 for(let n=0;;n++){try{await pool.query('select 1');break;}catch(e){if(n>80)throw e;await new Promise(r=>setTimeout(r,100));}}
 await cloud.ensureSchema();
 await pool.query("insert into companies(id,name,domain) values(1,'Fixture','fixture.test')");
 await pool.query("insert into app_users(id,company_id,email,password_hash,role,approval_status,account_type,display_name) values(11,1,'owner@fixture.test',$1,'employee','approved','client','Fixture')",[cloud.hashPassword('Fixture-only')]);
 async function request(handler,route,token,body){
  const req=new NextRequest('http://localhost'+route,{method:'POST',headers:{origin:'http://localhost','content-type':'application/json',...(token?{cookie:'trace_session_v2='+token}:{})},body:JSON.stringify(body)});
  const store=createRequestStoreForAPI(req,req.nextUrl,[],undefined,{});
  const response=await workAsyncStorage.run({route},()=>workUnitAsyncStorage.run(store,()=>handler(req)));
  return {response,token:store.mutableCookies.get('trace_session_v2')?.value};
 }
 const login=await request(cloud.login,'/api/login',null,{email:'owner@fixture.test',password:'Fixture-only'});assert.equal(login.response.status,200);assert.ok(login.token);
 for(let i=0;i<3;i++) {
  const input={title:'Local fixture '+i,sourceType:'local',requestKey:crypto.randomUUID()};
  const created=await request(cloud.create,'/api/projects',login.token,input);
  assert.equal(created.response.status,201,await created.response.text());
  const replay=await request(cloud.create,'/api/projects',login.token,input);assert.equal(replay.response.status,201);
 }
 const rows=(await pool.query('select git_remote_url,git_repository_key,client_id from projects')).rows;
 assert.equal(rows.length,3);for(const r of rows){assert.equal(r.git_remote_url,null);assert.equal(r.git_repository_key,null);assert.equal(String(r.client_id),'11');}
 assert.equal((await request(cloud.create,'/api/projects',null,{title:'Unauthorized',sourceType:'local',requestKey:crypto.randomUUID()})).response.status,401);
 for(const gitRemote of ['/tmp/bare.git','file:///tmp/bare.git']) assert.equal((await request(cloud.create,'/api/projects',login.token,{title:'Unsafe',sourceType:'local',gitRemote,requestKey:crypto.randomUUID()})).response.status,400);
 console.log('PASS real login + actual projects POST + ensureSchema PostgreSQL: three local projects, idempotency, owner binding, path/file rejection, unauthenticated denial');
} finally {if(pool)await pool.end();execFileSync('docker',['rm','-f',container],{stdio:'ignore'});}
