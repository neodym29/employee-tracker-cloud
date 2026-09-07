import 'server-only';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {PoolClient} from 'pg';
import type {SessionUser} from './auth';
import {getPool} from './db';
import {ensureNodeInstallSchema, NodeInstallError, exactBody} from './tracemini-install';
import {claimDeviceWork, publishRepositoryCandidates, completeDeviceWork, createPendingPush, createRepositoryScan, deviceForCredential, listRepositoryCandidates, repositoryScanStatus, selectRepositoryCandidate} from './tracemini-discovery';

let schema:Promise<void>|undefined;
async function ensure(){
  if(!schema) schema=(async()=>{await ensureNodeInstallSchema();await getPool().query(fs.readFileSync(path.join(process.cwd(),'migrations/022_tracemini_node_git.sql'),'utf8'));})().catch(e=>{schema=undefined;throw e;});
  await schema;
}
const fail=(status=409,code='node_git_identity_or_lease_unavailable'):never=>{throw new NodeInstallError(status,code);};
const digest=(value:unknown)=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))return fail(400,'invalid_digest');return value;};
const id=(value:unknown)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)return fail(400,'invalid_identifier');return String(n);};
async function transaction<T>(fn:(db:PoolClient)=>Promise<T>){await ensure();const db=await getPool().connect();try{await db.query('begin');const out=await fn(db);await db.query('commit');return out;}catch(e){await db.query('rollback');throw e;}finally{db.release();}}
async function identity(token:string){
  if(!/^etn_[A-Za-z0-9_-]{43}$/.test(token))fail(401,'invalid_node_credential');
  return transaction(async db=>{
    const n=(await db.query(`select n.* from tracemini_node_devices n join app_users u on u.id=n.user_id and u.company_id=n.company_id where n.credential_hash=$1 and n.capability='node-git-v1' and n.revoked_at is null and n.expires_at>now() and u.approval_status='approved' for update of n`,[crypto.createHash('sha256').update(token).digest('hex')])).rows[0];
    if(!n)fail(401,'invalid_node_credential');
    // No Python enrollment or usable Python credential is issued. This row only
    // supplies the foreign-key identity used by the existing discovery tables.
    await db.query(`insert into files_agent_devices(company_id,user_id,node_device_id,credential_hash,device_label,platform) values($1,$2,$3,$4,$5,'node-git') on conflict(node_device_id) do nothing`,[n.company_id,n.user_id,n.id,crypto.randomBytes(32).toString('hex'),n.machine_name]);
    return deviceForCredential(db,{nodeToken:token});
  });
}
export async function createNodeRepositoryScan(session:SessionUser,nodeId:unknown){
  await ensure();
  const row=(await getPool().query(`select d.id from files_agent_devices d join tracemini_node_devices n on n.id=d.node_device_id where n.id=$1 and n.company_id=$2 and n.user_id=$3 and n.revoked_at is null and n.expires_at>now()`,[id(nodeId),session.company_id,session.id])).rows[0];
  if(!row)fail(409,'node_must_poll_before_scan');
  return createRepositoryScan(session,row.id);
}
// Browser DTO is explicitly allowlisted: no fingerprint, local key, path or raw device error.
export async function nodeBrowserDiscovery(session:SessionUser){
  await ensure();
  const agents=(await getPool().query(`select n.id,n.user_id,d.id as device_id,d.last_seen_at,
    (d.last_seen_at>now()-interval '2 minutes') as online
    from tracemini_node_devices n join app_users u on u.id=n.user_id and u.company_id=n.company_id and u.approval_status='approved'
    left join files_agent_devices d on d.node_device_id=n.id and d.revoked_at is null
    where n.company_id=$1 and n.user_id=$2 and n.capability='node-git-v1' and n.revoked_at is null and n.expires_at>now()`,[session.company_id,session.id])).rows;
  const selections=(await getPool().query(`select c.id,c.device_id,s.desired_tracking,s.completed_at,c.tracking_state
    from tracemini_repository_candidates c join files_agent_devices d on d.id=c.device_id
    join tracemini_node_devices n on n.id=d.node_device_id
    left join tracemini_repository_selections s on s.candidate_id=c.id and s.revision=c.revision
    where c.company_id=$1 and d.user_id=$2 and n.revoked_at is null and n.expires_at>now()`,[session.company_id,session.id])).rows;
  const selected=new Map(selections.map(s=>[String(s.id),s]));
  const candidates=(await listRepositoryCandidates(session)).filter(c=>selected.has(c.id)).map(c=>{
    const s=selected.get(c.id)!;
    const desired=s.desired_tracking===true;
    const pending=s.completed_at==null && s.desired_tracking!=null;
    return {id:Number(c.id),agent_id:Number(agents.find(a=>String(a.device_id)===String(s.device_id))?.id),owner_user_id:Number(session.id),
      name:String(c.display_name || 'Repository '+c.id).split(/[\\/]/).pop()!.slice(0,120),machine_name:'Node device',normalized_remote:'',revision:c.revision,project_id:c.matched_project_id,
      selectable:c.match_status==='matched',traced:pending?!desired:c.tracking_state==='tracking',desired_traced:desired,last_seen:c.created_at,
      error:c.tracking_state==='error'||(!pending&&s.desired_tracking!=null&&desired!==(c.tracking_state==='tracking'))?'Device could not apply selection. Retry or reconnect.':undefined};
  });
  return {userId:Number(session.id),agents:agents.map(a=>({id:Number(a.id),user_id:Number(a.user_id),status:a.online?'online':'offline',last_seen:a.last_seen_at})),candidates};
}
export async function nodeBrowserMutation(session:SessionUser,body:Record<string,unknown>){
  exactBody(body,['action','nodeId','scanId','candidateId','traced','revision']);
  const state=await nodeBrowserDiscovery(session);
  if(body.action==='scan'){
    if(!state.agents.some(a=>String(a.id)===String(body.nodeId)&&a.status==='online'))fail(409,'node_offline');
    const scan=await createNodeRepositoryScan(session,body.nodeId);return {id:Number(scan.requestId),status:scan.state};
  }
  if(body.action==='status'){
    const owned=(await getPool().query(`select s.id from tracemini_scan_requests s join files_agent_devices d on d.id=s.device_id join tracemini_node_devices n on n.id=d.node_device_id where s.id=$1 and s.company_id=$2 and s.user_id=$3 and n.revoked_at is null and n.expires_at>now()`,[id(body.scanId),session.company_id,session.id])).rows[0];
    if(!owned)fail(404,'scan_unavailable');
    const scan=await repositoryScanStatus(session,body.scanId);return {id:Number(scan.requestId),status:scan.state==='failed'?'error':scan.state,repositories_found:scan.count,error:scan.error?'Device scan failed; reconnect and retry.':null};
  }
  if(body.action==='select'){
    if(typeof body.traced!=='boolean'||!state.candidates.some(c=>String(c.id)===String(body.candidateId)))fail(400,'invalid_selection');
    return selectRepositoryCandidate(session,body.candidateId,body.traced as boolean,body.revision);
  }
  fail(400,'invalid_action');
}
async function authorized(db:PoolClient,token:string,body:Record<string,unknown>,register=false){
  const device=await deviceForCredential(db,{nodeToken:token});
  const row=(await db.query(`select c.*,s.desired_tracking,s.claim_token,s.completed_at,r.id as root_id,p.tracemini_telemetry_paused,
    g.revision as registered_revision,g.claim_token as registered_claim
    from tracemini_repository_candidates c join tracemini_repository_selections s on s.candidate_id=c.id and s.revision=c.revision
    join projects p on p.id=c.matched_project_id and p.approval_status='approved' and p.git_repository_key=c.repository_key
    join app_users owner on owner.id=p.client_id and owner.company_id=c.company_id
    join project_tracemini_roots r on r.project_id=p.id and r.device_id=c.device_id and r.repository_key=c.repository_key
      and r.root_hash=encode(sha256(convert_to('tracemini-discovery-candidate:'||c.id::text,'UTF8')),'hex') and r.status='approved' and r.revoked_at is null
    left join tracemini_node_registrations g on g.candidate_id=c.id
    where c.id=$1 and c.device_id=$2 and c.company_id=$3 and s.owner_user_id=$4 and s.desired_tracking=true
    and c.fingerprint=$5::jsonb and c.repository_key=$6
    and (p.client_id=$4 or exists(select 1 from project_memberships m where m.project_id=p.id and m.user_id=$4 and m.membership_status='active'))
    and (select count(*) from projects q join app_users qo on qo.id=q.client_id and qo.company_id=$3 where q.approval_status='approved' and q.git_repository_key=c.repository_key and (q.client_id=$4 or exists(select 1 from project_memberships qm where qm.project_id=q.id and qm.user_id=$4 and qm.membership_status='active')))=1
    for update of c,s,r,p`,[id(body.candidate_id),device.id,device.company_id,device.user_id,JSON.stringify({digest:digest(body.digest)}),body.repository_key])).rows[0];
  if(!row)fail();
  if(register){if(row.completed_at || String(row.revision)!==id(body.revision) || row.claim_token!==body.claim_token || String(row.matched_project_id)!==id(body.project_id))fail();}
  else if(String(row.registered_revision)!==String(row.revision)||row.registered_claim!==row.claim_token||(!row.completed_at&&body.claim_token!==row.claim_token))fail();
  return {row,device};
}
function pushTarget(body:Record<string,unknown>) {
  if(typeof body.expected_head_sha!=='string'||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(body.expected_head_sha)||/^0+$/.test(body.expected_head_sha))fail(400,'invalid_push_sha');
  const ref=body.branch;if(typeof ref!=='string'||ref.length>255||!/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(ref)||ref.includes('..')||ref.includes('//')||ref.endsWith('/')||ref.endsWith('.')||ref.split('/').some(s=>s.startsWith('.')||s.endsWith('.lock')))fail(400,'invalid_push_ref');
}
async function telemetryAllowed(db:PoolClient,row:{tracemini_telemetry_paused:boolean}) {
  const settings=(await db.query(`select tracemini_global_pause,tracemini_embedded_enabled from tracemini_runtime_settings where singleton=true`)).rows[0];
  if(row.tracemini_telemetry_paused||!settings?.tracemini_embedded_enabled||settings.tracemini_global_pause)fail(503,'git_telemetry_paused');
}
export async function nodeGitRequest(token:string,operation:string,body:Record<string,unknown>={}){
  const device=await identity(token), credential={nodeToken:token};
  if(operation==='sync'){
    exactBody(body,[]);
    const claimed=await claimDeviceWork(credential);
    const projects=await getPool().query(`select c.id,c.matched_project_id from tracemini_repository_candidates c where c.device_id=$1`,[device.id]);
    const projectByCandidate=new Map(projects.rows.map(r=>[String(r.id),r.matched_project_id]));
    const access=await getPool().query(`select distinct p.id from projects p join app_users owner on owner.id=p.client_id and owner.company_id=$2
      join tracemini_repository_candidates c on c.matched_project_id=p.id and c.repository_key=p.git_repository_key and c.device_id=$1
      join project_tracemini_roots r on r.project_id=p.id and r.device_id=c.device_id and r.status='approved' and r.revoked_at is null
      where p.approval_status='approved' and (p.client_id=$3 or exists(select 1 from project_memberships m where m.project_id=p.id and m.user_id=$3 and m.membership_status='active'))`,[device.id,device.company_id,device.user_id]);
    return {workspaceIds:access.rows.map(r=>Number(r.id)),contextId:Number(device.context_id),work:claimed.work.map(w=>{const {binding,...safe}=w;return {...safe,project_id:projectByCandidate.get(String(w.kind==='push'?w.candidate_id:w.work_id))};})};
  }
  if(operation==='scan') {
    exactBody(body,[]);
    await createRepositoryScan({id:String(device.user_id),company_id:String(device.company_id)} as SessionUser,device.id);
    return claimDeviceWork(credential);
  }
  if(operation==='workspace') {
    exactBody(body,['workspaceId']);
    const rows=(await getPool().query(`select c.id,c.fingerprint,c.repository_key from tracemini_repository_candidates c join tracemini_node_registrations g on g.candidate_id=c.id where c.device_id=$1 and c.matched_project_id=$2`,[device.id,id(body.workspaceId)])).rows;
    if(!rows.length)fail(403,'project_not_selected_for_device');
    for(const c of rows)await transaction(db=>authorized(db,token,{candidate_id:c.id,digest:c.fingerprint.digest,repository_key:c.repository_key}));
    return {workspaceId:Number(body.workspaceId),contextId:Number(device.context_id)};
  }
  if(operation==='candidates'){exactBody(body,['scan_id','claim_token','repositories']);return publishRepositoryCandidates(credential,body);}
  if(operation==='complete'&&body.kind==='push') {
    exactBody(body,['kind','work_id','claim_token','candidate_id','digest','repository_key','status','expected_head_sha','branch','observed_sha']);pushTarget(body);
    if(!['pending','verified'].includes(String(body.status))||(body.status==='verified'&&body.observed_sha!==body.expected_head_sha))fail(400,'invalid_remote_confirmation');
    return transaction(async db=>{
      const {row,device}=await authorized(db,token,body);await telemetryAllowed(db,row);
      const result=await db.query(`update tracemini_pending_pushes set status=$2,verified_at=case when $2='verified' then now() else null end
        where id=$1 and candidate_id=$3 and status='pending' and node_event_key is not null and claim_token=$4 and expected_head_sha=$5 and branch=$6
        returning node_event_key,created_at`,[id(body.work_id),body.status,row.id,body.claim_token,body.expected_head_sha,body.branch]);
      const push=result.rows[0];if(!push)fail();
      if(body.status==='verified')await db.query(`insert into project_tracemini_events(project_id,device_id,root_id,event_key,kind,action,repository_key,occurred_at,provenance,evidence_eligible,resume_epoch)
        select p.id,$2,$3,$4,'push','git_push',$5,$6,$7::jsonb,false,p.tracemini_resume_epoch from projects p where p.id=$1 on conflict(root_id,event_key) do nothing`,
        [row.matched_project_id,device.id,row.root_id,push.node_event_key,row.repository_key,push.created_at,JSON.stringify({head_sha:body.expected_head_sha,remote_head_sha:body.observed_sha})]);
      return {completed:true};
    });
  }
  if(operation==='complete'){exactBody(body,['kind','work_id','claim_token','revision','tracked','error','count','status','expected_head_sha','branch']);return completeDeviceWork(credential,body);}
  if(operation==='push') {
    exactBody(body,['candidate_id','digest','repository_key','claim_token','branch','expected_head_sha','event_key','occurred_at']);
    digest(body.event_key);pushTarget(body);
    const occurred=new Date(String(body.occurred_at));if(!Number.isFinite(occurred.getTime())||occurred.getTime()>Date.now()+300000)fail(400,'invalid_event_time');
    return transaction(async db=>{
      const {row}=await authorized(db,token,body);await telemetryAllowed(db,row);
      const result=await db.query(`insert into tracemini_pending_pushes(candidate_id,expected_head_sha,branch,next_check_at,node_event_key,created_at)
        values($1,$2,$3,now(),$4,$5) on conflict(candidate_id,node_event_key) where node_event_key is not null do update set node_event_key=excluded.node_event_key
        where tracemini_pending_pushes.expected_head_sha=excluded.expected_head_sha and tracemini_pending_pushes.branch=excluded.branch returning id`,[row.id,body.expected_head_sha,body.branch,body.event_key,occurred.toISOString()]);
      if(!result.rows[0])fail();return {pushId:String(result.rows[0].id)};
    });
  }
  if(operation==='register'){
    exactBody(body,['candidate_id','digest','repository_key','revision','claim_token','project_id']);
    return transaction(async db=>{const {row}=await authorized(db,token,body,true);await db.query(`insert into tracemini_node_registrations(candidate_id,revision,claim_token) values($1,$2,$3) on conflict(candidate_id) do update set revision=excluded.revision,claim_token=excluded.claim_token`,[row.id,row.revision,row.claim_token]);return {id:Number(row.id),project_id:Number(row.matched_project_id),normalized_remote:row.repository_key,name:row.display_name};});
  }
  if(operation==='activity'){
    exactBody(body,['candidate_id','digest','repository_key','claim_token','event_key','kind','occurred_at','provenance','history']);
    if(!['commit','branch','merge','rewrite','pull','stage','push'].includes(String(body.kind)))fail(400,'unsupported_git_event');
    digest(body.event_key);
    const occurred=new Date(String(body.occurred_at));
    if(!Number.isFinite(occurred.getTime())||occurred.getTime()>Date.now()+300000||occurred.getTime()<Date.now()-91*86400000)fail(400,'invalid_event_time');
    const provenance=body.provenance as Record<string,unknown>;
    if(!provenance||typeof provenance!=='object'||Array.isArray(provenance))fail(400,'invalid_provenance');
    exactBody(provenance,['head_sha','remote_head_sha','old_head_sha','new_head_sha','files_changed','insertions','deletions']);
    for(const [k,v] of Object.entries(provenance))if(k.endsWith('_sha')?typeof v!=='string'||!/^[a-f0-9]{40,64}$/.test(v):typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>1e9)fail(400,'invalid_provenance');
    return transaction(async db=>{
      const {row,device}=await authorized(db,token,body);
      const settings=(await db.query(`select tracemini_global_pause,tracemini_embedded_enabled from tracemini_runtime_settings where singleton=true`)).rows[0];
      if(row.tracemini_telemetry_paused||!settings?.tracemini_embedded_enabled||settings.tracemini_global_pause)fail(503,'git_telemetry_paused');
      const result=await db.query(`insert into project_tracemini_events(project_id,device_id,root_id,event_key,kind,action,repository_key,occurred_at,provenance,evidence_eligible,resume_epoch)
        select p.id,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,false,p.tracemini_resume_epoch from projects p where p.id=$1 on conflict(root_id,event_key) do nothing returning id`,[row.matched_project_id,device.id,row.root_id,body.event_key,body.kind,body.history===true&&body.kind==='commit'?'commit_history':'git_'+body.kind,row.repository_key,occurred.toISOString(),JSON.stringify(provenance)]);
      return {accepted:result.rowCount,duplicates:result.rowCount?0:1};
    });
  }
  fail(404,'unsupported_node_git_operation');
}
