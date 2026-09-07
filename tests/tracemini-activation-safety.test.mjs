import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
class ServiceError extends Error { constructor(message,status,code) {super(message);this.status=status;this.code=code;} }
function load(path, pool={}) {
  const module={exports:{}};
  vm.runInNewContext(ts.transpileModule(read(path), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {module,exports:module.exports,Buffer,process,require(name) {
      if(name==='server-only'||name==='./auth') return {};
      if(name==='./db') return {ensureSchema:async()=>{},getPool:()=>pool};
      if(name==='./projects') return {ProjectServiceError:ServiceError};
      if(name==='./files-agent') return {FilesAgentError:ServiceError,hashFilesAgentSecret:hash};
      return require(name);
    }});
  return module.exports;
}
const event = () => ({event_key:'history-1',kind:'commit',action:'commit_history',agent:null,run_id:null,
  repository_key:'github.com/acme/repo',occurred_at:new Date(Date.now()-60*86400000).toISOString(),
  provenance:{head_sha:'a'.repeat(40),branch:'main',files_changed:1}});

test('90-day history is valid unattributed Git metadata, not fabricated AI evidence', () => {
  const {normalizeEmbeddedIngest: normalize}=load('lib/embedded-tracemini-ingest.ts');
  const normalized=normalize({events:[event()]})[0];
  assert.equal(normalized.agent,null); assert.equal(normalized.runId,null); assert.equal(normalized.kind,'commit');
  assert.throws(()=>normalize({events:[{...event(),agent:'codex',run_id:'a'.repeat(32)}]}),/attribution/);
  assert.throws(()=>normalize({events:[{...event(),kind:'file_activity'}]}),/agent/);
  assert.throws(()=>normalize({events:[{...event(),provenance:{message:'secret',author_email:'private'}}]}),/prohibited/);
});

test('actual Python hook payloads normalize without invented AI evidence', () => {
  const records=JSON.parse(execFileSync('python3',['-c', `
import runpy,json
m=runpy.run_path('files-agent/files_agent.py')
metadata={'repository_key':'github.com/acme/repo','provenance':{'branch':'main','head_sha':'a'*40,'index_digest':'private','upstream_head_sha':None}}
print(json.dumps([m['git_hook_record'](kind,metadata) for kind in ['commit','branch','merge','rewrite','stage']]))
`],{cwd:new URL('..',import.meta.url),encoding:'utf8'}));
  const {normalizeEmbeddedIngest: normalize}=load('lib/embedded-tracemini-ingest.ts');
  for(const record of records) {
    const [result]=normalize({events:[record]}); assert.equal(result.agent,null); assert.equal(result.runId,null);
    assert.throws(()=>normalize({events:[{...record,kind:'file_activity'}]}),/agent/);
    assert.throws(()=>normalize({events:[{...record,provenance:{...record.provenance,approved_agent:'codex'}}]}),/prohibited/);
    assert.throws(()=>normalize({events:[{...record,action:'made_up'}]}),/agent/);
  }
});

test('in-process PostgreSQL: fresh Track binding, scan leases, revisions, revocation, signed history', async t => {
  let PGlite;
  try { ({PGlite}=await import(process.env.TRACEMINI_PGLITE_MODULE || '@electric-sql/pglite')); }
  catch { t.skip('Set TRACEMINI_PGLITE_MODULE to an installed @electric-sql/pglite module; no services are launched'); return; }
  const db=new PGlite(); t.after(()=>db.close());
  // PGlite reports affectedRows=0 for SELECT even when rows are returned.
  // Match node-postgres rowCount semantics for both reads and writes.
  const query=async (sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.rowCount ?? (r.command==='SELECT' ? r.rows.length : r.affectedRows ?? r.rows.length)};};
  const client={query,release(){}}; const pool={query,connect:async()=>client};
  await db.exec(`
    create table companies(id bigint primary key);
    create table app_users(id bigint primary key,company_id bigint,approval_status text default 'approved');
    create table files_agent_devices(id bigint primary key,company_id bigint,user_id bigint,credential_hash text,revoked_at timestamptz,last_seen_at timestamptz);
    create table projects(id bigint primary key,company_id bigint,client_id bigint,approval_status text default 'approved',git_repository_key text,tracemini_telemetry_paused boolean default false,tracemini_resume_epoch integer default 0);
    create table project_memberships(project_id bigint,user_id bigint,membership_status text);
    create table project_tracemini_roots(id bigserial primary key,project_id bigint,device_id bigint,binding_id text,binding_secret_hash text,root_hash text,root_label text,repository_key text,status text,approved_by bigint,approved_at timestamptz,last_heartbeat_at timestamptz,revoked_at timestamptz,unique(project_id,device_id,root_hash));
    create table tracemini_request_nonces(binding_id text,nonce text,primary key(binding_id,nonce));
    create table tracemini_runtime_settings(singleton boolean,tracemini_embedded_enabled boolean,tracemini_global_pause boolean);
    create table files_agent_rate_limits(scope_key text,window_start timestamptz,event_count integer,primary key(scope_key,window_start));
    create table files_agent_events(device_id bigint,payload jsonb,captured_at timestamptz);
    create table project_tracemini_events(project_id bigint,device_id bigint,root_id bigint,event_key text,kind text,action text,agent text,run_id text,repository_key text,occurred_at timestamptz,provenance jsonb,evidence_eligible boolean,resume_epoch integer,unique(root_id,event_key));
    insert into companies values(1),(2);
    insert into app_users(id,company_id) values(11,1),(12,1),(21,2);
    insert into files_agent_devices(id,company_id,user_id,credential_hash) values(101,1,11,'${hash('fad_device')}');
    insert into projects(id,company_id,client_id,git_repository_key) values(1001,1,12,'github.com/acme/repo');
    insert into project_memberships values(1001,11,'active');
    insert into tracemini_runtime_settings values(true,true,false);
  `);
  await db.exec(read('migrations/020_tracemini_project_discovery.sql'));
  const previous=process.env.FILES_AGENT_BINDING_KEY;
  process.env.FILES_AGENT_BINDING_KEY='test-only-key-'.repeat(4);
  t.after(()=>{if(previous===undefined)delete process.env.FILES_AGENT_BINDING_KEY;else process.env.FILES_AGENT_BINDING_KEY=previous;});
  const api=load('lib/tracemini-discovery.ts',pool), ingest=load('lib/embedded-tracemini-ingest.ts',pool);
  const session={id:'11',company_id:'1'};
  await t.test('idle authenticated polling refreshes liveness with bounded writes', async () => {
    assert.equal((await api.claimDeviceWork('fad_device')).work.length,0);
    const seen=()=>query('select last_seen_at from files_agent_devices').then(r=>r.rows[0].last_seen_at);
    assert.ok(await seen(), 'idle polling must initialize last_seen_at without bindings');
    await query(`update files_agent_devices set last_seen_at=now()-interval '10 seconds'`);
    const recent=await seen(); await api.claimDeviceWork('fad_device');
    assert.equal(String(await seen()),String(recent),'recent polling must not write again');
    await query(`update files_agent_devices set last_seen_at=now()-interval '3 minutes'`);
    const stale=await seen(); await api.claimDeviceWork('fad_device');
    assert.notEqual(String(await seen()),String(stale));
    await query(`update files_agent_devices set revoked_at=now()`);
    const before=await seen();
    await assert.rejects(api.claimDeviceWork('fad_device'),e=>e.status===401);
    assert.equal(String(await seen()),String(before));
    await query(`update files_agent_devices set revoked_at=null`);
  });
  const scan=await api.createRepositoryScan(session,'101');
  const lease=(await api.claimDeviceWork('fad_device')).work[0];
  const repo={display_name:'repo',repository_key:event().repository_key,fingerprint:{device_id:1,inode:2},head_sha:'a'.repeat(40)};
  const publish={scan_id:scan.requestId,claim_token:lease.claim_token,repositories:[repo]};
  await query(`update tracemini_scan_requests set claimed_at=now()-interval '11 minutes'`);
  const renewed=(await api.claimDeviceWork('fad_device')).work[0];
  assert.notEqual(renewed.claim_token,lease.claim_token);
  await assert.rejects(api.publishRepositoryCandidates('fad_device',publish),e=>e.status===409);
  publish.claim_token=renewed.claim_token;
  await api.publishRepositoryCandidates('fad_device',publish);
  let candidate=(await api.listRepositoryCandidates(session))[0];
  const selection=await api.selectRepositoryCandidate(session,candidate.id,true,candidate.revision);
  assert.equal(JSON.stringify(selection).includes('binding'),false,'browser never receives a binding');
  let work=(await api.claimDeviceWork('fad_device')).work.find(x=>x.kind==='selection');
  assert.ok(work.binding?.binding_secret,'fresh GUI Track issues binding over device-auth work only');
  const root=(await query('select * from project_tracemini_roots')).rows[0];
  assert.equal(root.binding_secret_hash,hash(work.binding.binding_secret));
  assert.notEqual(root.binding_secret_hash,work.binding.binding_secret);
  // An unchanged rescan does not silently invalidate an in-flight selection.
  await api.publishRepositoryCandidates('fad_device',publish);
  candidate=(await api.listRepositoryCandidates(session))[0]; assert.equal(candidate.revision,selection.revision);
  const completion={kind:'selection',work_id:work.work_id,revision:work.revision,claim_token:work.claim_token,tracked:true};
  await query(`update tracemini_repository_candidates set revision=revision+1`);
  await assert.rejects(api.completeDeviceWork('fad_device',completion),e=>e.status===409);
  await query(`update tracemini_repository_candidates set revision=revision-1`);
  await query(`update project_memberships set membership_status='inactive'`);
  await assert.rejects(api.completeDeviceWork('fad_device',completion),e=>e.status===409);
  await query(`update project_memberships set membership_status='active'`);
  await api.completeDeviceWork('fad_device',completion);
  assert.equal((await api.listRepositoryCandidates(session))[0].tracking_state,'tracking');
  for (const [name,change] of [
    ['membership', `update project_memberships set membership_status='inactive'`],
    ['approval', `update projects set approval_status='pending'`],
    ['repository', `update projects set git_repository_key='github.com/acme/other'`],
    ['root revocation', `update project_tracemini_roots set revoked_at=now()`],
    ['root approval', `update project_tracemini_roots set status='pending'`],
    ['root repository', `update project_tracemini_roots set repository_key='github.com/acme/other'`],
    ['root identity', `update project_tracemini_roots set root_hash='wrong'`],
    ['missing binding', `delete from project_tracemini_roots`],
  ]) await t.test(`listing revalidates ${name}`, async () => {
    await query('begin');
    try {
      await query(change);
      const current=(await api.listRepositoryCandidates(session))[0];
      assert.notEqual(current.tracking_state,'tracking');
      if (['membership','approval','repository'].includes(name)) {
        assert.equal(current.matched_project_id,null); assert.equal(current.match_status,'unmatched');
      }
    } finally { await query('rollback'); }
  });
  function signed(body,path='/api/files-agent/tracemini') {
    const raw=Buffer.from(JSON.stringify(body)),timestamp=String(Math.floor(Date.now()/1000)),nonce=crypto.randomBytes(16).toString('hex');
    const signature=crypto.createHmac('sha256',work.binding.binding_secret).update(['POST',path,timestamp,nonce,hash(raw)].join('\n')).digest('hex');
    return [raw,{bindingId:work.binding.binding_id,signature,timestamp,nonce,path}];
  }
  const body={events:[event()]}; let [raw,auth]=signed(body);
  const result=await ingest.ingestEmbeddedEvents('fad_device',raw,body,auth); assert.equal(result.accepted,1);
  const stored=(await query('select * from project_tracemini_events')).rows[0];
  assert.equal(stored.evidence_eligible,false); assert.equal(stored.agent,null); assert.equal(stored.run_id,null);
  const executionId='b'.repeat(32);
  const runId=crypto.createHmac('sha256',work.binding.binding_secret).update(`approved-execution:${executionId}`).digest('hex');
  await query(`insert into files_agent_events values(101,$1::jsonb,now())`,[JSON.stringify({run_id:runId,agent:'codex'})]);
  for(const [key,run,eligible] of [['same-root',runId,true],['other-root',crypto.createHmac('sha256','another-root-secret').update(`approved-execution:${executionId}`).digest('hex'),false]]) {
    // Even a matching durable files run for another binding is insufficient.
    if(!eligible) await query(`insert into files_agent_events values(101,$1::jsonb,now())`,[JSON.stringify({run_id:run,agent:'codex'})]);
    const ai={events:[{event_key:key,kind:'file_activity',action:'approved_agent_mutation',agent:'codex',run_id:run,occurred_at:new Date().toISOString(),repository_key:'github.com/acme/repo',provenance:{execution_id:executionId,files_changed:1}}]};
    const [aiRaw,aiAuth]=signed(ai);
    await ingest.ingestEmbeddedEvents('fad_device',aiRaw,ai,aiAuth);
    assert.equal((await query('select evidence_eligible from project_tracemini_events where event_key=$1',[key])).rows[0].evidence_eligible,eligible);
  }
  await query(`update project_memberships set membership_status='inactive'`);
  [raw,auth]=signed(body);
  await assert.rejects(ingest.ingestEmbeddedEvents('fad_device',raw,body,auth),e=>e.status===403);
  [raw,auth]=signed({},'/api/files-agent/tracemini/heartbeat');
  await assert.rejects(ingest.heartbeatEmbeddedBinding('fad_device',raw,auth),e=>e.status===403);
  await assert.rejects(api.selectRepositoryCandidate(session,candidate.id,true,candidate.revision),e=>e.status===409);
  await query(`update project_memberships set membership_status='active'`);
  candidate=(await api.listRepositoryCandidates(session))[0];
  await api.selectRepositoryCandidate(session,candidate.id,false,candidate.revision);
  assert.equal((await query('select status from project_tracemini_roots')).rows[0].status,'revoked');
  const stopped=(await api.claimDeviceWork('fad_device')).work.find(x=>x.kind==='selection');
  assert.equal(stopped.binding,undefined);
  await assert.rejects(api.completeDeviceWork('fad_device',completion),e=>e.status===409);
  // Revoked membership clears cached match and bumps the candidate revision on rescan.
  await query(`update project_memberships set membership_status='inactive'`);
  await api.publishRepositoryCandidates('fad_device',publish);
  candidate=(await api.listRepositoryCandidates(session))[0]; assert.equal(candidate.matched_project_id,null);
  assert.equal(candidate.match_status,'unmatched');
});
