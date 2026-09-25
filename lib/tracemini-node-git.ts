import 'server-only';
import { saveOriginalTraceMiniSummary } from './tracemini-original-summaries';
import crypto from 'node:crypto';
import { saveAcceptedEngineerEvents } from './project-engineer-journal';
import fs from 'node:fs';
import path from 'node:path';
import type {PoolClient} from 'pg';
import type {SessionUser} from './auth';
import {getPool} from './db';
import {canonicalRepositoryKey} from './git-remote';
import {safeGitWorkText, safeReportText} from './tracemini-work-evidence';
import {generateDailyProjectSummary, generatePluginProgressEstimate, generateTraceReport} from './project-chat';
import {createProject, listAvailableClients} from './projects';
import {normalizeDeploymentUrl} from './deployment-url';
import {getProjectOverview} from './project-overview';
import {listClientRequests, updateClientRequest} from './client-requests';
import {ensureNodeInstallSchema, NodeInstallError, exactBody} from './tracemini-install';
import {claimDeviceWork, publishRepositoryCandidates, completeDeviceWork, createPendingPush, createRepositoryScan, deviceForCredential, listRepositoryCandidates, repositoryScanStatus, selectRepositoryCandidate} from './tracemini-discovery';

let schema:Promise<void>|undefined;
async function ensure(){
  if(!schema) schema=(async()=>{await ensureNodeInstallSchema();for(const migration of ['022_tracemini_node_git.sql','023_tracemini_candidate_project_binding.sql','027_tracemini_observer_receipts.sql','030_codex_plugin_connections.sql','031_codex_plugin_daily_summaries.sql','032_codex_daily_summary_v2.sql','033_codex_plugin_work_updates.sql','034_codex_plugin_other_work.sql','035_codex_plugin_project_bindings.sql','036_codex_plugin_repository_work_attribution.sql'])await getPool().query(fs.readFileSync(path.join(process.cwd(),'migrations',migration),'utf8'));})().catch(e=>{schema=undefined;throw e;});
  await schema;
}
const fail=(status=409,code='node_git_identity_or_lease_unavailable'):never=>{throw new NodeInstallError(status,code);};
const digest=(value:unknown)=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))return fail(400,'invalid_digest');return value;};
const id=(value:unknown)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)return fail(400,'invalid_identifier');return String(n);};
type TraceHealth = {candidateId:number;projectId:string;projectTitle:string;repository:string;device:string;state:'healthy'|'attention'|'failed';code:string;label:string;detail:string;repairable:boolean;revision:number;desiredTracing:boolean;traced:boolean;lastCheckedAt:string};
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
  const agents=(await getPool().query(`select n.id,n.user_id,n.machine_name,d.id as device_id,d.last_seen_at,
    (d.last_seen_at>now()-interval '2 minutes') as online
    from tracemini_node_devices n join app_users u on u.id=n.user_id and u.company_id=n.company_id and u.approval_status='approved'
    left join files_agent_devices d on d.node_device_id=n.id and d.user_id=n.user_id and d.company_id=n.company_id and d.revoked_at is null
    where n.company_id=$1 and n.user_id=$2 and n.capability='node-git-v1' and n.revoked_at is null and n.expires_at>now()`,[session.company_id,session.id])).rows;
  const selections=(await getPool().query(`select c.id,c.device_id,s.desired_tracking,s.completed_at,c.tracking_state
    from tracemini_repository_candidates c join files_agent_devices d on d.id=c.device_id
    join tracemini_node_devices n on n.id=d.node_device_id and n.user_id=d.user_id and n.company_id=d.company_id and n.capability='node-git-v1'
    join tracemini_repository_selections s on s.candidate_id=c.id and s.revision=c.revision
    where c.company_id=$1 and d.user_id=$2 and n.revoked_at is null and n.expires_at>now()`,[session.company_id,session.id])).rows;
  const selected=new Map(selections.map(s=>[String(s.id),s]));
  // Creation does not grant tracking consent. Current approved project authority
  // is independently revalidated by discovery, selection and every device call.
  const formed=(await getPool().query(`select c.id,p.id project_id from tracemini_repository_candidates c join files_agent_devices d on d.id=c.device_id and d.company_id=c.company_id join projects p on p.id=c.explicit_project_id and p.creation_requested_by=$2 where c.company_id=$1 and d.user_id=$2 and d.revoked_at is null and p.approval_status='approved' and p.status<>'archived' and (p.client_id=$2 or exists(select 1 from project_memberships m where m.project_id=p.id and m.user_id=$2 and m.membership_status='active'))`,[session.company_id,session.id])).rows;
  const formedProjects=new Map(formed.map(p=>[String(p.id),String(p.project_id)]));
  const candidates=(await listRepositoryCandidates(session)).map(c=>{
    const s=selected.get(c.id);
    // A deleted/archived project is no longer an active trace target. Ignore
    // its historical selection row so a fresh discovery is shown as untraced.
    const activeProject=Boolean(c.matched_project_id);
    const desired=activeProject && s?.desired_tracking===true;
    const pending=Boolean(activeProject && s && s.completed_at==null);
    return {id:Number(c.id),agent_id:Number(agents.find(a=>String(a.device_id)===String(c.device_id))?.id),owner_user_id:Number(session.id),
      name:String(c.display_name || 'Repository '+c.id).split(/[\\/]/).pop()!.slice(0,120),machine_name:String(agents.find(a=>String(a.device_id)===String(c.device_id))?.machine_name || 'Node device').slice(0,120),normalized_remote:'',branch:c.branch?String(c.branch).slice(0,120):undefined,revision:c.revision,project_id:c.matched_project_id??formedProjects.get(c.id)??null,
      selectable:c.match_status==='matched',traced:pending?!desired:c.tracking_state==='tracking',desired_traced:desired,last_seen:c.created_at,delivery_health:c.delivery_health,
      error:activeProject && s && (c.tracking_state==='error'||(!pending&&desired!==(c.tracking_state==='tracking')))?'Device could not apply selection. Retry or reconnect.':undefined};
  });
  const projects=(await getPool().query(`select p.id,p.title,p.status from projects p join app_users owner on owner.id=p.client_id and owner.approval_status='approved' where p.approval_status='approved' and p.status<>'archived' and exists(select 1 from app_users u where u.id=$2 and u.company_id=$1 and u.approval_status='approved') and (p.client_id=$2 or exists(select 1 from project_memberships m where m.project_id=p.id and m.user_id=$2 and m.membership_status='active')) order by p.title,p.id`,[session.company_id,session.id])).rows;
  const projectTitles=new Map(projects.map(project=>[String(project.id),String(project.title)]));
  const checkedAt=new Date().toISOString();
  const health:TraceHealth[]=candidates.filter(candidate=>candidate.project_id).map(candidate=>{
    const delivery=candidate.delivery_health?.state;
    const projectId=String(candidate.project_id);
    if(candidate.error) return {candidateId:candidate.id,projectId,projectTitle:projectTitles.get(projectId)||projectId,repository:candidate.name,device:candidate.machine_name,state:'failed',code:'activation_failed',label:'Neo-Nexus activation failed',detail:candidate.error,repairable:true,revision:candidate.revision,desiredTracing:candidate.desired_traced,traced:candidate.traced,lastCheckedAt:checkedAt};
    if(candidate.desired_traced && !candidate.traced) return {candidateId:candidate.id,projectId,projectTitle:projectTitles.get(projectId)||projectId,repository:candidate.name,device:candidate.machine_name,state:'attention',code:'activation_pending',label:'Neo-Nexus activation is pending',detail:'The device has not acknowledged tracking yet.',repairable:true,revision:candidate.revision,desiredTracing:true,traced:false,lastCheckedAt:checkedAt};
    if(!candidate.desired_traced && !candidate.traced) return {candidateId:candidate.id,projectId,projectTitle:projectTitles.get(projectId)||projectId,repository:candidate.name,device:candidate.machine_name,state:'attention',code:'not_started',label:'Tracking is not started',detail:'The repository is linked, but this device has not been asked to start tracking.',repairable:true,revision:candidate.revision,desiredTracing:false,traced:false,lastCheckedAt:checkedAt};
    if(delivery==='paused') return {candidateId:candidate.id,projectId,projectTitle:projectTitles.get(projectId)||projectId,repository:candidate.name,device:candidate.machine_name,state:'attention',code:'uploads_paused',label:'Neo-Nexus is paused',detail:candidate.delivery_health?.detail||'Uploads are paused for this project.',repairable:false,revision:candidate.revision,desiredTracing:true,traced:true,lastCheckedAt:checkedAt};
    if(delivery==='disconnected') return {candidateId:candidate.id,projectId,projectTitle:projectTitles.get(projectId)||projectId,repository:candidate.name,device:candidate.machine_name,state:'attention',code:'device_disconnected',label:'Device is disconnected',detail:candidate.delivery_health?.detail||'No recent device contact was received.',repairable:false,revision:candidate.revision,desiredTracing:true,traced:true,lastCheckedAt:checkedAt};
    if(delivery==='awaiting') return {candidateId:candidate.id,projectId,projectTitle:projectTitles.get(projectId)||projectId,repository:candidate.name,device:candidate.machine_name,state:'attention',code:'awaiting_activity',label:'Neo-Nexus is active; awaiting activity',detail:candidate.delivery_health?.detail||'The device is connected but no activity has arrived yet.',repairable:false,revision:candidate.revision,desiredTracing:true,traced:true,lastCheckedAt:checkedAt};
    return {candidateId:candidate.id,projectId,projectTitle:projectTitles.get(projectId)||projectId,repository:candidate.name,device:candidate.machine_name,state:'healthy',code:'healthy',label:'Neo-Nexus is working',detail:candidate.delivery_health?.detail||'Activity has been received from this repository.',repairable:false,revision:candidate.revision,desiredTracing:true,traced:true,lastCheckedAt:checkedAt};
  });
  for(const item of health.filter(entry=>entry.state==='failed'||entry.code==='activation_pending'||entry.code==='not_started')){
    await getPool().query(`insert into tracemini_audit_log(project_id,actor_user_id,action,details)
      select $1,$2,'trace_health_failure',$3::jsonb
      where not exists(select 1 from tracemini_audit_log where project_id=$1 and actor_user_id=$2 and action='trace_health_failure' and details->>'candidateId'=$4 and details->>'code'=$5 and created_at>now()-interval '10 minutes')`,[item.projectId,session.id,JSON.stringify({candidateId:item.candidateId,code:item.code,repository:item.repository,device:item.device,detail:item.detail}),String(item.candidateId),item.code]);
  }
  const creation = session.account_type==='client' || session.account_type==='engineer' ? {
    accountType:session.account_type,
    clients:session.account_type==='engineer' ? await listAvailableClients(session) : [],
  } : null;
  return {userId:Number(session.id),agents:agents.map(a=>({id:Number(a.id),user_id:Number(a.user_id),status:a.online?'online':'offline',last_seen:a.last_seen_at})),candidates,projects,creation,health};
}
async function attributeEarlierRepositoryWork(db:PoolClient,companyId:unknown,userId:unknown,repositoryKey:unknown,projectId:unknown){
  // Repository identity plus engineer identity is the minimum safe attribution.
  // Device identity is deliberately not required: engineers can reconnect or
  // replace a device between recording work and adding the project.
  const attributed=await db.query(`update codex_plugin_work_updates set project_id=$1
    where project_id is null and company_id=$2 and user_id=$3 and repository_key=$4
    returning id`,[projectId,companyId,userId,repositoryKey]);
  return attributed.rowCount||0;
}

export async function nodeBrowserMutation(session:SessionUser,body:Record<string,unknown>){
  exactBody(body,body.action==='create'?['action','candidateId','revision','title','clientId']:['action','nodeId','scanId','candidateId','traced','revision','projectId','resumeUploads']);
  const state=await nodeBrowserDiscovery(session);
  if(body.action==='link'||body.action==='create')return transaction(async db=>{
    const c=(await db.query(`select c.* from tracemini_repository_candidates c join files_agent_devices d on d.id=c.device_id and d.company_id=c.company_id join tracemini_node_devices n on n.id=d.node_device_id and n.user_id=d.user_id and n.company_id=d.company_id join app_users u on u.id=d.user_id and u.company_id=d.company_id and u.approval_status='approved' where c.id=$1 and c.company_id=$2 and d.user_id=$3 and d.revoked_at is null and n.revoked_at is null and n.expires_at>now() and n.capability='node-git-v1' for update of c,d,n`,[id(body.candidateId),session.company_id,session.id])).rows[0];
    if(!c)fail(404,'candidate_unavailable');
    // Server-derived candidate key survives double-clicks, lost responses and page
    // reloads. The canonical service also binds it to the normalized payload.
    const hash=crypto.createHash('sha256').update(`trace-repository-project:v1:${session.company_id}:${session.id}:${c.id}`).digest('hex');
    let requestKey=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
    const creating=body.action==='create';
    let replay: {id:string;status:string}|undefined;
    if(creating){
      if(!state.creation)fail(403,'project_creation_forbidden');
      if(session.account_type==='engineer'){
        const owner=(await db.query(`select id from app_users where id=$1 and account_type='client' and approval_status='approved' for share`,[id(body.clientId)])).rows[0];
        if(!owner)fail(403,'project_not_authorized');
      }
      replay=(await db.query('select id,status from projects where creation_requested_by=$1 and creation_request_key=$2::uuid',[session.id,requestKey])).rows[0];
      // A prior project may have been archived/deleted. Do not replay that
      // tombstone as a successful creation; start a fresh idempotent request.
      if (replay?.status === 'archived') {
        replay=undefined;
        requestKey=crypto.randomUUID();
      }
    }
    let p=creating&&!replay?undefined:(await db.query(`select p.id from projects p join app_users owner on owner.id=p.client_id and owner.approval_status='approved' where p.id=$1 and p.approval_status='approved' and (p.client_id=$2 or exists(select 1 from project_memberships m where m.project_id=p.id and m.user_id=$2 and m.membership_status='active')) for update of p`,[id(replay?.id??body.projectId),session.id])).rows[0];
    if((!creating||replay)&&!p)fail(403,'project_not_authorized');
    if(!creating && c.explicit_project_id) {
      if(String(c.explicit_project_id)!==String(p.id))fail(409,'project_already_linked');
      const attributedUpdates=session.account_type==='engineer'?await attributeEarlierRepositoryWork(db,session.company_id,session.id,c.repository_key,p.id):0;
      return {linked:true,projectId:String(p.id),attributedUpdates};
    }
    if(replay&&String(c.explicit_project_id)!==String(replay.id))fail(409,'revision_conflict');
    if(!replay&&String(c.revision)!==id(body.revision))fail(409,'revision_conflict');
    let selection=(await db.query('select * from tracemini_repository_selections where candidate_id=$1 for update',[c.id])).rows[0];
    if (creating && (c.tracking_state==='tracking' || selection?.desired_tracking===true || (await db.query('select 1 from tracemini_tracked_repositories where candidate_id=$1',[c.id])).rowCount)) {
      const liveBinding = c.matched_project_id && (await db.query(`select 1 from projects where id=$1 and approval_status='approved' and status<>'archived'`,[c.matched_project_id])).rowCount;
      if (!liveBinding) {
        // The old project is gone. Clear only that stale binding so the same
        // repository can create its replacement without a stop acknowledgement.
        await db.query('delete from tracemini_tracked_repositories where candidate_id=$1',[c.id]);
        await db.query(`update project_tracemini_roots set status='revoked',revoked_at=now() where device_id=$1 and root_hash=encode(sha256(convert_to('tracemini-discovery-candidate:'||$2::text,'UTF8')),'hex')`,[c.device_id,c.id]);
        const reset=await db.query(`update tracemini_repository_candidates set explicit_project_id=null,matched_project_id=null,match_status='unmatched',tracking_state='unselected',revision=revision+1,updated_at=now() where id=$1 and revision=$2 returning revision`,[c.id,c.revision]);
        if(!reset.rows[0])fail(409,'revision_conflict');
        c.revision=Number(reset.rows[0].revision);
        c.tracking_state='unselected';
        c.matched_project_id=null;
        c.explicit_project_id=null;
        if(selection) {
          await db.query(`update tracemini_repository_selections set desired_tracking=false,revision=$2,claimed_at=null,claim_token=null,completed_at=now(),updated_at=now() where candidate_id=$1`,[c.id,c.revision]);
          selection={...selection,desired_tracking:false,revision:c.revision,completed_at:new Date()};
        }
      }
    }
    if(!replay&&(c.tracking_state==='tracking'||selection&&(selection.desired_tracking||!selection.completed_at)|| (await db.query('select 1 from tracemini_tracked_repositories where candidate_id=$1',[c.id])).rowCount))fail(409,'stop_acknowledgement_required');
    if(creating){
      // Never accept a browser-supplied remote, owner identity, tracking flag or
      // request key. Form documents/memberships and binding commit together.
      p=await createProject(session,{title:body.title,titleSource:'repository',clientId:body.clientId,
        ...(String(c.repository_key).startsWith('local:')?{sourceType:'local'}:{sourceType:'remote',gitRemote:`https://${c.repository_key}.git`}),requestKey},db);
    }
    await db.query(`update project_tracemini_roots set status='revoked',revoked_at=now() where device_id=$1 and root_hash=encode(sha256(convert_to('tracemini-discovery-candidate:'||$2::text,'UTF8')),'hex')`,[c.device_id,c.id]);
    const bound=await db.query(`update tracemini_repository_candidates set explicit_project_id=$2,matched_project_id=$2,match_status='matched',revision=revision+1,tracking_state='unselected',updated_at=now() where id=$1 and revision=$3 returning id`,[c.id,p.id,c.revision]);
    if(!bound.rows[0])fail(409,'revision_conflict');
    let attributedUpdates=0;
    if(session.account_type==='engineer'){
      await db.query(`insert into codex_plugin_project_bindings(device_id,company_id,user_id,project_id,repository_key,created_at,updated_at)
        values($1,$2,$3,$4,$5,now(),now())
        on conflict(device_id,repository_key) do update set company_id=excluded.company_id,user_id=excluded.user_id,project_id=excluded.project_id,updated_at=now()
        where codex_plugin_project_bindings.company_id=excluded.company_id and codex_plugin_project_bindings.user_id=excluded.user_id`,[c.device_id,session.company_id,session.id,p.id,c.repository_key]);
      attributedUpdates=await attributeEarlierRepositoryWork(db,session.company_id,session.id,c.repository_key,p.id);
      if(attributedUpdates>0)await db.query(`insert into tracemini_audit_log(project_id,actor_user_id,action,details)
        values($1,$2,'codex_plugin_other_work_attributed',$3::jsonb)`,[p.id,session.id,JSON.stringify({deviceId:String(c.device_id),updates:attributedUpdates})]);
    }
    return creating?{linked:true,projectId:String(p.id),attributedUpdates}:{linked:true,projectId:String(p.id),attributedUpdates};
  });
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
    if (body.resumeUploads !== undefined && typeof body.resumeUploads !== 'boolean') fail(400,'invalid_upload_consent');
    return selectRepositoryCandidate(session,body.candidateId,body.traced as boolean,body.revision,true,body.resumeUploads===true?{projectId:body.projectId,resumeUploads:true}:undefined);
  }
  fail(400,'invalid_action');
}
async function authorized(db:PoolClient,token:string,body:Record<string,unknown>,register=false){
  const device=await deviceForCredential(db,{nodeToken:token});
  const row=(await db.query(`select c.*,s.desired_tracking,s.claim_token,s.completed_at,r.id as root_id,p.tracemini_telemetry_paused,
    g.revision as registered_revision,g.claim_token as registered_claim
    from tracemini_repository_candidates c join tracemini_repository_selections s on s.candidate_id=c.id and s.revision=c.revision
    join projects p on p.id=c.matched_project_id and p.approval_status='approved' and p.status<>'archived' and (case when c.explicit_project_id is not null then p.id=c.explicit_project_id else p.git_repository_key=c.repository_key end)
    join app_users owner on owner.id=p.client_id and owner.approval_status='approved'
    join project_tracemini_roots r on r.project_id=p.id and r.device_id=c.device_id and r.repository_key=c.repository_key
      and r.root_hash=encode(sha256(convert_to('tracemini-discovery-candidate:'||c.id::text,'UTF8')),'hex') and r.status='approved' and r.revoked_at is null
    left join tracemini_node_registrations g on g.candidate_id=c.id
    where c.id=$1 and c.device_id=$2 and c.company_id=$3 and s.owner_user_id=$4 and s.desired_tracking=true
    and c.fingerprint=$5::jsonb and c.repository_key=$6
    and (p.client_id=$4 or exists(select 1 from project_memberships m where m.project_id=p.id and m.user_id=$4 and m.membership_status='active'))
    and (c.explicit_project_id=p.id or (select count(*) from projects q join app_users qo on qo.id=q.client_id and qo.approval_status='approved' where q.approval_status='approved' and q.git_repository_key=c.repository_key and (q.client_id=$4 or exists(select 1 from project_memberships qm where qm.project_id=q.id and qm.user_id=$4 and qm.membership_status='active')))=1)
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
async function reportAuthority(db:PoolClient,token:string,body:Record<string,unknown>) {
  const auth=await authorized(db,token,body); await telemetryAllowed(db,auth.row);
  await db.query('select id from project_memberships where project_id=$1 and user_id=$2 for share',[auth.row.matched_project_id,auth.device.user_id]);
  const current=await db.query(`select p.id from projects p where p.id=$1 and (p.client_id=$2 or exists(select 1 from project_memberships m where m.project_id=p.id and m.user_id=$2 and m.membership_status='active'))`,[auth.row.matched_project_id,auth.device.user_id]);
  if(!current.rowCount)fail();
  return auth;
}
async function workspaceReportAuthority(db:PoolClient,job:Record<string,any>,row:Record<string,any>,device:Record<string,any>) {
  if(job.scope!=='workspace')return;
  if(String(job.target_user_id)!==String(device.user_id)||String(job.target_device_id)!==String(device.id)||String(job.target_root_id)!==String(row.root_id))fail();
  await db.query('select id from app_users where id in ($1,$2) order by id for share',[job.requested_by,job.target_user_id]);
  const authority=await db.query(`select p.id from projects p join app_users u on u.id=$2 and u.approval_status='approved' join app_users target on target.id=$3 and target.approval_status='approved' and target.account_type='engineer' where p.id=$1 and ((u.role='admin' and u.account_type='admin') or (u.account_type='client' and p.client_id=u.id)) and exists(select 1 from project_memberships m where m.project_id=p.id and m.user_id=target.id and m.membership_status='active')`,[job.project_id,job.requested_by,job.target_user_id]);
  if(!authority.rowCount)fail(403,'workspace_report_authority_revoked');
  const roots=await db.query(`select r.id from project_tracemini_roots r join files_agent_devices d on d.id=r.device_id where r.project_id=$1 and d.user_id=$2 and r.status='approved' and r.revoked_at is null`,[job.project_id,job.target_user_id]);
  if(roots.rowCount!==1)fail(409,'unsupported_report_root_scope');
}
async function codexEngineerSession(device:Record<string,any>, projectValue:unknown) {
  const project=id(projectValue);
  const row=(await getPool().query(`select u.id,u.company_id,u.email,u.role,u.account_type,company.domain as company_domain
    from projects p
    join app_users owner on owner.id=p.client_id and owner.approval_status='approved'
    join app_users u on u.id=$2 and u.company_id=$3 and u.account_type='engineer' and u.approval_status='approved'
    join companies company on company.id=u.company_id
    where p.id=$1 and p.approval_status='approved' and p.status<>'archived'
      and exists(select 1 from project_memberships membership where membership.project_id=p.id and membership.user_id=u.id and membership.membership_status='active')
      and (
        exists(select 1 from tracemini_repository_candidates candidate
          join project_tracemini_roots root on root.project_id=p.id and root.device_id=candidate.device_id and root.repository_key=candidate.repository_key
            and root.status='approved' and root.revoked_at is null
          where candidate.matched_project_id=p.id and candidate.device_id=$4 and candidate.company_id=$3)
        or exists(select 1 from codex_plugin_project_bindings binding
          where binding.project_id=p.id and binding.device_id=$4 and binding.user_id=u.id and binding.company_id=u.company_id)
      )
    limit 1`,[project,device.user_id,device.company_id,device.id])).rows[0];
  if(!row)fail(403,'codex_project_access_denied');
  return {project,session:{id:String(row.id),company_id:String(row.company_id),email:String(row.email),role:row.role,account_type:row.account_type,company_domain:String(row.company_domain)} as SessionUser};
}
async function codexProject(device:Record<string,any>, body:Record<string,unknown>) {
  const keys=Object.keys(body);
  if(keys.length===1&&keys[0]==='workspaceId')return id(body.workspaceId);
  if(keys.length!==1||keys[0]!=='repositoryUrl')fail(400,'invalid_request_fields');
  const repositoryKey=(()=>{try{return canonicalRepositoryKey(body.repositoryUrl);}catch{return fail(400,'invalid_repository_remote');}})();
  const rows=(await getPool().query(`select distinct p.id
    from projects p
    join app_users owner on owner.id=p.client_id and owner.approval_status='approved'
    join app_users engineer on engineer.id=$3 and engineer.company_id=$2 and engineer.account_type='engineer' and engineer.approval_status='approved'
    join project_memberships membership on membership.project_id=p.id and membership.user_id=engineer.id and membership.membership_status='active'
    where p.approval_status='approved' and p.status<>'archived' and (
      exists(select 1 from tracemini_repository_candidates candidate
        join project_tracemini_roots root on root.project_id=p.id and root.device_id=candidate.device_id and root.repository_key=candidate.repository_key and root.status='approved' and root.revoked_at is null
        where candidate.matched_project_id=p.id and candidate.device_id=$1 and candidate.company_id=$2 and candidate.repository_key=$4)
      or exists(select 1 from codex_plugin_project_bindings binding
        where binding.project_id=p.id and binding.device_id=$1 and binding.company_id=$2 and binding.user_id=$3 and binding.repository_key=$4)
    )`,[device.id,device.company_id,device.user_id,repositoryKey])).rows;
  if(rows.length!==1)fail(403,'codex_project_access_denied');
  return String(rows[0].id);
}

async function codexProjectOptions(device:Record<string,any>,body:Record<string,unknown>){
  exactBody(body,['repositoryUrl','pluginVersion']);
  const pluginVersion=codexPluginVersion(body.pluginVersion);
  const repositoryKey=(()=>{try{return canonicalRepositoryKey(body.repositoryUrl);}catch{return fail(400,'invalid_repository_remote');}})();
  await codexProfile(device);
  await recordCodexPluginConnection(device,pluginVersion,true);
  const rows=(await getPool().query(`select p.id,p.title,p.git_repository_key,
      exists(select 1 from codex_plugin_project_bindings binding
        where binding.project_id=p.id and binding.device_id=$1 and binding.company_id=$2 and binding.user_id=$3 and binding.repository_key=$4) as connected
    from projects p
    join app_users owner on owner.id=p.client_id and owner.approval_status='approved'
    join project_memberships membership on membership.project_id=p.id and membership.user_id=$3 and membership.membership_status='active'
    where p.approval_status='approved' and p.status<>'archived'
    order by connected desc,(p.git_repository_key=$4) desc,p.updated_at desc,p.id desc`,[device.id,device.company_id,device.user_id,repositoryKey])).rows;
  return {repository:repositoryKey,projects:rows.map(row=>({id:String(row.id),title:String(row.title).slice(0,200),repositoryMatches:row.git_repository_key===repositoryKey,connected:row.connected===true}))};
}

async function connectCodexProject(device:Record<string,any>,body:Record<string,unknown>){
  exactBody(body,['projectId','repositoryUrl','pluginVersion']);
  const project=id(body.projectId),pluginVersion=codexPluginVersion(body.pluginVersion);
  const repositoryKey=(()=>{try{return canonicalRepositoryKey(body.repositoryUrl);}catch{return fail(400,'invalid_repository_remote');}})();
  await codexProfile(device);
  await recordCodexPluginConnection(device,pluginVersion,true);
  return transaction(async db=>{
    const selected=(await db.query(`select p.id,p.title,p.git_repository_key
      from projects p
      join app_users owner on owner.id=p.client_id and owner.approval_status='approved'
      join app_users engineer on engineer.id=$2 and engineer.company_id=$3 and engineer.account_type='engineer' and engineer.approval_status='approved'
      join project_memberships membership on membership.project_id=p.id and membership.user_id=engineer.id and membership.membership_status='active'
      where p.id=$1 and p.approval_status='approved' and p.status<>'archived'
      for update of p`,[project,device.user_id,device.company_id])).rows[0];
    if(!selected)fail(403,'codex_project_access_denied');
    if(selected.git_repository_key&&selected.git_repository_key!==repositoryKey)fail(409,'codex_repository_project_mismatch');
    const connected=(await db.query(`insert into codex_plugin_project_bindings(device_id,company_id,user_id,project_id,repository_key,created_at,updated_at)
      values($1,$2,$3,$4,$5,now(),now())
      on conflict(device_id,repository_key) do update set company_id=excluded.company_id,user_id=excluded.user_id,project_id=excluded.project_id,updated_at=now()
      where codex_plugin_project_bindings.company_id=excluded.company_id and codex_plugin_project_bindings.user_id=excluded.user_id
      returning id`,[device.id,device.company_id,device.user_id,project,repositoryKey])).rows[0];
    if(!connected)fail(403,'codex_project_access_denied');
    const attributedUpdates=await attributeEarlierRepositoryWork(db,device.company_id,device.user_id,repositoryKey,project);
    await db.query(`insert into tracemini_audit_log(project_id,actor_user_id,action,details)
      values($1,$2,'codex_plugin_project_connected',$3::jsonb)`,[project,device.user_id,JSON.stringify({deviceId:String(device.id),repositoryKey,attributedUpdates})]);
    return {ok:true,project:{id:String(selected.id),title:String(selected.title).slice(0,200)},repository:repositoryKey,attributedUpdates};
  });
}
async function codexProfile(device:Record<string,any>) {
  const row=(await getPool().query(`select engineer.id,engineer.email,engineer.display_name,node.machine_name
    from app_users engineer
    join files_agent_devices files_device on files_device.id=$1 and files_device.user_id=engineer.id and files_device.company_id=engineer.company_id and files_device.revoked_at is null
    left join tracemini_node_devices node on node.id=files_device.node_device_id and node.user_id=engineer.id and node.company_id=engineer.company_id and node.revoked_at is null and node.expires_at>now()
    where engineer.id=$2 and engineer.company_id=$3 and engineer.account_type='engineer' and engineer.approval_status='approved'
    limit 1`,[device.id,device.user_id,device.company_id])).rows[0];
  if(!row)fail(403,'codex_engineer_access_denied');
  const profileId=crypto.createHash('sha256').update(`neo-nexus-engineer-v1:${device.company_id}:${row.id}`).digest('base64url');
  const name=String(row.display_name||String(row.email).split('@')[0]).slice(0,160);
  const deviceName=String(row.machine_name||'approved device').slice(0,80);
  return {id:profileId,name,email:String(row.email),nickname:`${name} · ${deviceName}`,deviceId:String(device.id),deviceName};
}
function codexPluginVersion(value:unknown):string{
  if(typeof value!=='string'||value.length<1||value.length>80||!/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(value))fail(400,'invalid_plugin_version');
  return String(value);
}
async function recordCodexPluginConnection(device:Record<string,any>,pluginVersion:string,polling:boolean){
  const result=await getPool().query(`insert into codex_plugin_connections(device_id,company_id,user_id,plugin_version,last_seen_at,last_poll_at,updated_at)
    values($1,$2,$3,$4,now(),case when $5::boolean then now() else null end,now())
    on conflict(device_id) do update set plugin_version=excluded.plugin_version,last_seen_at=now(),last_poll_at=case when $5::boolean then now() else codex_plugin_connections.last_poll_at end,updated_at=now()
    where codex_plugin_connections.company_id=excluded.company_id and codex_plugin_connections.user_id=excluded.user_id
    returning device_id`,[device.id,device.company_id,device.user_id,pluginVersion,polling]);
  if(!result.rows[0])fail(403,'codex_engineer_access_denied');
}

function codexWorkText(value:unknown,field:'summary'|'next_step'){
  if(value===undefined&&field==='next_step')return '';
  if(typeof value!=='string')fail(400,`invalid_${field}`);
  const text=String(value).replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim();
  const minimum=field==='summary'?8:0,maximum=field==='summary'?600:500;
  if(text.length<minimum||text.length>maximum)fail(400,`invalid_${field}`);
  if(/-----BEGIN [A-Z ]+PRIVATE KEY-----|\b(?:gh[pousr]|sk|etn|eti)_[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~-]{16,}/i.test(text))fail(400,'unsafe_work_update');
  return text;
}

async function recordCodexWorkUpdate(device:Record<string,any>,body:Record<string,unknown>){
  exactBody(body,['workspaceId','status','summary','nextStep','idempotencyKey','pluginVersion']);
  const pluginVersion=codexPluginVersion(body.pluginVersion);
  const status=String(body.status||'');
  if(!['in_progress','completed','blocked'].includes(status))fail(400,'invalid_work_status');
  if(typeof body.idempotencyKey!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.idempotencyKey))fail(400,'invalid_idempotency_key');
  const {project}=await codexEngineerSession(device,body.workspaceId);
  await codexProfile(device);
  await recordCodexPluginConnection(device,pluginVersion,true);
  const summary=codexWorkText(body.summary,'summary'),nextStep=codexWorkText(body.nextStep,'next_step');
  const recorded=await transaction(async db=>{
    const recent=(await db.query(`select count(*)::int as count from codex_plugin_work_updates where user_id=$1 and created_at>now()-interval '1 hour'`,[device.user_id])).rows[0];
    if(Number(recent?.count||0)>=100)fail(429,'codex_work_update_rate_exceeded');
    let row=(await db.query(`insert into codex_plugin_work_updates(project_id,device_id,company_id,user_id,status,summary,next_step,plugin_version,idempotency_key)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid)
      on conflict(user_id,idempotency_key) do nothing
      returning id,update_date::text,status,summary,next_step,created_at`,[project,device.id,device.company_id,device.user_id,status,summary,nextStep,pluginVersion,body.idempotencyKey])).rows[0];
    if(!row)row=(await db.query(`select id,update_date::text,status,summary,next_step,created_at from codex_plugin_work_updates where user_id=$1 and idempotency_key=$2::uuid`,[device.user_id,body.idempotencyKey])).rows[0];
    if(!row)fail(409,'codex_work_update_conflict');
    await db.query(`insert into tracemini_audit_log(project_id,actor_user_id,action,details) values($1,$2,'codex_plugin_work_update',$3::jsonb)`,[project,device.user_id,JSON.stringify({updateId:String(row.id),status:String(row.status),deviceId:String(device.id)})]);
    return {ok:true,projectId:project,update:{id:String(row.id),date:String(row.update_date),status:String(row.status),summary:String(row.summary),nextStep:String(row.next_step||''),createdAt:new Date(row.created_at).toISOString()}};
  });
  let progressRefresh:Record<string,unknown>;
  try { progressRefresh=await refreshCodexProjectProgress(device,project); }
  catch { progressRefresh={status:'retry_later',updated:false}; }
  return {...recorded,progressRefresh};
}

async function updateCodexDeployment(device:Record<string,any>,body:Record<string,unknown>){
  exactBody(body,['workspaceId','deploymentUrl','pluginVersion']);
  const pluginVersion=codexPluginVersion(body.pluginVersion);
  const {project}=await codexEngineerSession(device,body.workspaceId);
  await codexProfile(device);
  await recordCodexPluginConnection(device,pluginVersion,true);
  let deploymentUrl:string|null=null;
  try { deploymentUrl=normalizeDeploymentUrl(body.deploymentUrl); }
  catch { fail(400,'invalid_deployment_url'); }
  if(!deploymentUrl)fail(400,'invalid_deployment_url');
  return transaction(async db=>{
    const row=(await db.query(`update projects set deployment_url=$2,updated_at=now()
      where id=$1 and approval_status='approved' and status<>'archived'
      returning id,title,deployment_url,updated_at`,[project,deploymentUrl])).rows[0];
    if(!row)fail(404,'project_unavailable');
    await db.query(`insert into tracemini_audit_log(project_id,actor_user_id,action,details)
      values($1,$2,'codex_plugin_deployment_updated',$3::jsonb)`,[project,device.user_id,JSON.stringify({deploymentUrl:String(row.deployment_url),deviceId:String(device.id),pluginVersion})]);
    return {ok:true,projectId:String(row.id),title:String(row.title),deploymentUrl:String(row.deployment_url),updatedAt:new Date(row.updated_at).toISOString()};
  });
}

async function refreshCodexProjectProgress(device:Record<string,any>,projectValue:unknown){
  const {project}=await codexEngineerSession(device,projectValue);
  const db=getPool();
  const current=(await db.query(`select id,title,description,status,progress_percent,progress_summary,progress_version,progress_source
    from projects where id=$1 and approval_status='approved' and status<>'archived'`,[project])).rows[0];
  if(!current)fail(404,'project_unavailable');
  if(current.progress_source==='manual'||['completed','archived'].includes(String(current.status)))return {status:'manual_or_closed',updated:false};
  const [updates,totals,requests]=await Promise.all([
    db.query(`select status,summary,next_step,created_at from codex_plugin_work_updates
      where project_id=$1 and company_id=$2 order by created_at desc,id desc limit 100`,[project,device.company_id]),
    db.query(`select count(*)::int total_updates,count(*) filter(where status='completed')::int completed_updates,
      min(created_at) first_update_at,max(created_at) last_update_at
      from codex_plugin_work_updates where project_id=$1 and company_id=$2`,[project,device.company_id]),
    db.query(`select summary,request_kind,status,updated_at from project_client_request_summaries
      where project_id=$1 and status<>'resolved' order by (request_kind='issue') desc,updated_at desc,id desc limit 10`,[project]),
  ]);
  const total=totals.rows[0]||{};
  if(Number(total.completed_updates||0)<1)return {status:'awaiting_completed_milestone',updated:false};
  const context={project:{title:safeReportText(current.title).slice(0,200),description:safeReportText(current.description).slice(0,2000),status:String(current.status)},
    currentProgress:{percent:current.progress_percent==null?null:Number(current.progress_percent),summary:safeReportText(current.progress_summary).slice(0,240),source:String(current.progress_source),version:Number(current.progress_version)},
    pluginMilestones:updates.rows.map(row=>({status:String(row.status),summary:safeReportText(row.summary).slice(0,600),nextStep:safeReportText(row.next_step).slice(0,500),recordedAt:new Date(row.created_at).toISOString()})),
    pluginTotals:{updates:Number(total.total_updates||0),completed:Number(total.completed_updates||0),firstUpdateAt:total.first_update_at?new Date(total.first_update_at).toISOString():null,lastUpdateAt:total.last_update_at?new Date(total.last_update_at).toISOString():null},
    openClientRequests:requests.rows.map(row=>({summary:safeReportText(row.summary).slice(0,160),kind:row.request_kind==='issue'?'issue':'task',status:row.status==='in_progress'?'in_progress':'open',updatedAt:new Date(row.updated_at).toISOString()}))};
  const proposed=await generatePluginProgressEstimate(JSON.stringify(context),Number(current.progress_version));
  return transaction(async lockedDb=>{
    const changed=(await lockedDb.query(`update projects set progress_percent=$2,progress_summary=$3,progress_source='plugin_daily',progress_version=progress_version+1,progress_updated_at=now(),updated_at=now()
      where id=$1 and progress_version=$4 and progress_source in ('unassessed','plugin_daily') and (progress_percent is null or progress_percent<=$2)
      returning progress_percent,progress_summary,progress_version`,[project,proposed.percent,proposed.summary,proposed.expectedVersion])).rows[0];
    if(!changed)return {status:'unchanged',updated:false};
    await lockedDb.query(`insert into tracemini_audit_log(project_id,actor_user_id,action,details)
      values($1,$2,'codex_plugin_progress_refreshed',$3::jsonb)`,[project,device.user_id,JSON.stringify({percent:Number(changed.progress_percent),version:Number(changed.progress_version),deviceId:String(device.id)})]);
    return {status:'updated',updated:true,percent:Number(changed.progress_percent),summary:String(changed.progress_summary)};
  });
}

async function recordCodexOtherWorkUpdate(device:Record<string,any>,body:Record<string,unknown>){
  exactBody(body,['status','summary','nextStep','idempotencyKey','pluginVersion','repositoryUrl','repositoryKey']);
  const pluginVersion=codexPluginVersion(body.pluginVersion);
  const status=String(body.status||'');
  if(!['in_progress','completed','blocked'].includes(status))fail(400,'invalid_work_status');
  if(typeof body.idempotencyKey!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.idempotencyKey))fail(400,'invalid_idempotency_key');
  await codexProfile(device);
  await recordCodexPluginConnection(device,pluginVersion,true);
  const summary=codexWorkText(body.summary,'summary'),nextStep=codexWorkText(body.nextStep,'next_step');
  if(body.repositoryUrl!==undefined&&body.repositoryKey!==undefined)fail(400,'invalid_repository_identity');
  let repositoryKey:string|null=null;
  if(body.repositoryUrl!==undefined){
    try{repositoryKey=canonicalRepositoryKey(body.repositoryUrl);}catch{return fail(400,'invalid_repository_remote');}
  }else if(body.repositoryKey!==undefined){
    if(typeof body.repositoryKey!=='string'||!/^local:[a-f0-9]{64}$/.test(body.repositoryKey))fail(400,'invalid_repository_identity');
    repositoryKey=String(body.repositoryKey);
  }
  let matchedProject:string|null=null;
  if(repositoryKey){
    const matches=(await getPool().query(`select distinct p.id from projects p
      join project_memberships membership on membership.project_id=p.id and membership.user_id=$2 and membership.membership_status='active'
      where p.approval_status='approved' and p.status<>'archived'
        and (p.git_repository_key=$3 or exists(select 1 from codex_plugin_project_bindings binding
          where binding.project_id=p.id and binding.company_id=$1 and binding.user_id=$2 and binding.repository_key=$3))
      limit 2`,[device.company_id,device.user_id,repositoryKey])).rows;
    if(matches.length===1)matchedProject=String(matches[0].id);
  }
  return transaction(async db=>{
    const recent=(await db.query(`select count(*)::int as count from codex_plugin_work_updates where user_id=$1 and created_at>now()-interval '1 hour'`,[device.user_id])).rows[0];
    if(Number(recent?.count||0)>=100)fail(429,'codex_work_update_rate_exceeded');
    let row=(await db.query(`insert into codex_plugin_work_updates(project_id,device_id,company_id,user_id,status,summary,next_step,plugin_version,idempotency_key,repository_key)
      values($10,$1,$2,$3,$4,$5,$6,$7,$8::uuid,$9)
      on conflict(user_id,idempotency_key) do nothing
      returning id,project_id,update_date::text,status,summary,next_step,created_at`,[device.id,device.company_id,device.user_id,status,summary,nextStep,pluginVersion,body.idempotencyKey,repositoryKey,matchedProject])).rows[0];
    if(!row)row=(await db.query(`select id,project_id,update_date::text,status,summary,next_step,created_at from codex_plugin_work_updates where user_id=$1 and idempotency_key=$2::uuid and repository_key is not distinct from $3`,[device.user_id,body.idempotencyKey,repositoryKey])).rows[0];
    if(!row)fail(409,'codex_work_update_conflict');
    if(matchedProject && !row.project_id){
      const repaired=(await db.query(`update codex_plugin_work_updates set project_id=$2 where id=$1 and project_id is null returning project_id`,[row.id,matchedProject])).rows[0];
      if(repaired)row.project_id=repaired.project_id;
    }
    return {ok:true,projectId:row.project_id?String(row.project_id):null,otherWork:!row.project_id,repositoryIdentified:repositoryKey!==null,update:{id:String(row.id),date:String(row.update_date),status:String(row.status),summary:String(row.summary),nextStep:String(row.next_step||''),createdAt:new Date(row.created_at).toISOString()}};
  });
}

type CodexDailyClaim={id:string;projectId:string;deviceId:string;companyId:string;userId:string;summaryDate:string;attemptCount:number};
async function claimCodexDailySummary(device:Record<string,any>):Promise<CodexDailyClaim|null>{
  return transaction(async db=>{
    const row=(await db.query(`with due as (
      select p.id as project_id,((now() at time zone 'Asia/Karachi')::date-1)::date as summary_date
      from projects p
      where p.approval_status='approved' and p.status<>'archived'
        and exists(select 1 from app_users engineer where engineer.id=$3 and engineer.company_id=$2 and engineer.account_type='engineer' and engineer.approval_status='approved')
        and exists(select 1 from project_memberships membership where membership.project_id=p.id and membership.user_id=$3 and membership.membership_status='active')
        and (
          exists(select 1 from project_tracemini_roots root where root.project_id=p.id and root.device_id=$1 and root.status='approved' and root.revoked_at is null)
          or exists(select 1 from codex_plugin_project_bindings binding
            where binding.project_id=p.id and binding.device_id=$1 and binding.company_id=$2 and binding.user_id=$3)
        )
        and not exists(select 1 from codex_plugin_daily_runs done where done.project_id=p.id and done.user_id=$3
          and done.summary_date=((now() at time zone 'Asia/Karachi')::date-1)::date
          and done.summary_version>=4 and (done.status='completed' or done.attempt_count>=3
            or (done.status='running' and done.updated_at>now()-interval '5 minutes')
            or (done.status='failed' and done.updated_at>now()-interval '15 minutes')))
      order by p.id
      for update of p skip locked limit 1
    )
    insert into codex_plugin_daily_runs(project_id,device_id,company_id,user_id,summary_date,status,attempt_count,summary_version,started_at,updated_at)
    select due.project_id,$1,$2,$3,due.summary_date,'running',1,4,now(),now() from due
    on conflict(project_id,user_id,summary_date) do update set
      device_id=excluded.device_id,status='running',summary_version=4,
      attempt_count=case when codex_plugin_daily_runs.summary_version<4 then 1 else codex_plugin_daily_runs.attempt_count+1 end,
      started_at=now(),completed_at=null,last_error=null,updated_at=now()
    where codex_plugin_daily_runs.summary_version<4 or (codex_plugin_daily_runs.status in ('failed','running') and codex_plugin_daily_runs.attempt_count<3)
    returning id,project_id,device_id,company_id,user_id,summary_date::text,attempt_count`,[device.id,device.company_id,device.user_id])).rows[0];
    return row?{id:String(row.id),projectId:String(row.project_id),deviceId:String(row.device_id),companyId:String(row.company_id),userId:String(row.user_id),summaryDate:String(row.summary_date),attemptCount:Number(row.attempt_count)}:null;
  });
}

async function codexDailyContext(claim:CodexDailyClaim){
  const db=getPool();
  const project=(await db.query(`select p.id,p.title,p.description,p.status,p.progress_percent,p.progress_summary,p.progress_version,p.progress_source
    from projects p join project_memberships membership on membership.project_id=p.id and membership.user_id=$2 and membership.membership_status='active'
    join app_users engineer on engineer.id=membership.user_id and engineer.company_id=$3 and engineer.account_type='engineer' and engineer.approval_status='approved'
    where p.id=$1 and p.approval_status='approved' and p.status<>'archived'
      and (
        exists(select 1 from project_tracemini_roots root join files_agent_devices device on device.id=root.device_id and device.user_id=$2 and device.company_id=$3 and device.revoked_at is null
          where root.project_id=p.id and root.device_id=$4 and root.status='approved' and root.revoked_at is null)
        or exists(select 1 from codex_plugin_project_bindings binding
          where binding.project_id=p.id and binding.device_id=$4 and binding.user_id=$2 and binding.company_id=$3)
      )`,[claim.projectId,claim.userId,claim.companyId,claim.deviceId])).rows[0];
  if(!project)fail(403,'codex_project_access_denied');
  const [daily,cumulative,totals,requests]=await Promise.all([
    db.query(`select status,summary,next_step,created_at from codex_plugin_work_updates
      where project_id=$1 and user_id=$2 and company_id=$3 and update_date=$4::date
      order by created_at desc,id desc limit 100`,[claim.projectId,claim.userId,claim.companyId,claim.summaryDate]),
    db.query(`select status,summary,next_step,update_date::text,created_at from codex_plugin_work_updates
      where project_id=$1 and user_id=$2 and company_id=$3 and update_date<=$4::date
      order by update_date desc,created_at desc,id desc limit 80`,[claim.projectId,claim.userId,claim.companyId,claim.summaryDate]),
    db.query(`select count(*)::int as total_updates,min(created_at) as first_update_at,max(created_at) as last_update_at
      from codex_plugin_work_updates where project_id=$1 and user_id=$2 and company_id=$3 and update_date<=$4::date`,[claim.projectId,claim.userId,claim.companyId,claim.summaryDate]),
    db.query(`select summary,details,request_kind,status,updated_at from project_client_request_summaries
      where project_id=$1 and status<>'resolved' order by (request_kind='issue') desc,updated_at desc,id desc limit 10`,[claim.projectId]),
  ]);
  const update=(row:Record<string,any>)=>({status:['in_progress','completed','blocked'].includes(String(row.status))?String(row.status):'in_progress',
    summary:safeReportText(row.summary).slice(0,600),nextStep:safeReportText(row.next_step).slice(0,500),createdAt:new Date(row.created_at).toISOString(),...(row.update_date?{date:String(row.update_date)}:{})});
  const total=totals.rows[0]||{};
  return {project,context:{summaryDate:claim.summaryDate,timezone:'Asia/Karachi',project:{title:safeReportText(project.title).slice(0,200),description:safeReportText(project.description).slice(0,2000),status:String(project.status)},
    currentProgress:{percent:project.progress_percent==null?null:Number(project.progress_percent),summary:safeReportText(project.progress_summary).slice(0,240),source:String(project.progress_source),version:Number(project.progress_version)},
    dailyPluginUpdates:daily.rows.map(update),recentPluginUpdates:cumulative.rows.map(update),pluginTotals:{updates:Number(total.total_updates||0),firstUpdateAt:total.first_update_at?new Date(total.first_update_at).toISOString():null,lastUpdateAt:total.last_update_at?new Date(total.last_update_at).toISOString():null},
    openClientRequests:requests.rows.map(row=>({summary:safeReportText(row.summary).slice(0,160),details:safeReportText(row.details).slice(0,1000),kind:row.request_kind==='issue'?'issue':'task',status:row.status==='in_progress'?'in_progress':'open',updatedAt:new Date(row.updated_at).toISOString()}))}};
}

async function failCodexDailySummary(claim:CodexDailyClaim){
  await getPool().query(`update codex_plugin_daily_runs set status='failed',last_error='Daily summary generation failed; the plugin will retry safely.',completed_at=null,updated_at=now() where id=$1 and status='running'`,[claim.id]);
}

async function completeCodexDailySummary(claim:CodexDailyClaim,markdown:string,progress:{percent:number;summary:string;expectedVersion:number}|null,eventCount:number){
  return transaction(async db=>{
    const run=(await db.query(`select id from codex_plugin_daily_runs where id=$1 and project_id=$2 and user_id=$3 and device_id=$4 and status='running' for update`,[claim.id,claim.projectId,claim.userId,claim.deviceId])).rows[0];
    if(!run)fail(409,'daily_summary_lease_unavailable');
    const locked=(await db.query(`select p.id,p.progress_percent,p.progress_version,p.progress_source from projects p
      join project_memberships membership on membership.project_id=p.id and membership.user_id=$2 and membership.membership_status='active'
      where p.id=$1 and p.approval_status='approved' and p.status<>'archived' for update of p`,[claim.projectId,claim.userId])).rows[0];
    if(!locked)fail(403,'codex_project_access_denied');
    const dedupe=`codex-daily-v4:${claim.projectId}:${claim.userId}:${claim.summaryDate}`;
    const report=(await db.query(`insert into project_tracemini_reports(project_id,requested_by,target_user_id,target_device_id,target_root_id,scope,reporter,name,format,prompt,start_date,end_date,include_diff,documents,status,dedupe_key,notify_slack,slack_status,markdown,completed_at)
      values($1,$2,$2,$3,null,'workspace','codex',$4,'markdown','Daily summary generated only from plain-language Codex plugin work updates.',$5,$5,false,'[]'::jsonb,'completed',$6,false,'not_requested',$7,now())
      on conflict(dedupe_key) do update set status='completed',markdown=excluded.markdown,completed_at=now(),last_error=null
      where project_tracemini_reports.project_id=excluded.project_id and project_tracemini_reports.target_user_id=excluded.target_user_id
      returning id`,[claim.projectId,claim.userId,claim.deviceId,`Daily project summary · ${claim.summaryDate}`,claim.summaryDate,dedupe,markdown])).rows[0];
    if(!report)fail(409,'daily_summary_conflict');
    let progressUpdated=false;
    if(progress&&['unassessed','plugin_daily'].includes(String(locked.progress_source))
      &&Number(locked.progress_version)===progress.expectedVersion
      &&(locked.progress_percent==null||Number(locked.progress_percent)<=progress.percent)){
      const changed=await db.query(`update projects set progress_percent=$2,progress_summary=$3,progress_source='plugin_daily',progress_version=progress_version+1,progress_updated_at=now(),updated_at=now()
        where id=$1 and progress_version=$4 and progress_source in ('unassessed','plugin_daily') and (progress_percent is null or progress_percent<=$2) returning id`,[claim.projectId,progress.percent,progress.summary,progress.expectedVersion]);
      progressUpdated=Boolean(changed.rows[0]);
    }
    await saveOriginalTraceMiniSummary(db,String(report.id),claim.userId,null,claim.deviceId);
    await db.query(`update codex_plugin_daily_runs set status='completed',report_id=$2,event_count=$3,completed_at=now(),last_error=null,updated_at=now() where id=$1`,[claim.id,report.id,eventCount]);
    await db.query(`insert into tracemini_audit_log(project_id,actor_user_id,action,details) values($1,$2,'codex_daily_summary_completed',$3::jsonb)`,[claim.projectId,claim.userId,JSON.stringify({summaryDate:claim.summaryDate,reportId:String(report.id),eventCount,progressUpdated,deviceId:claim.deviceId})]);
    return {processed:true,status:'completed',projectId:claim.projectId,summaryDate:claim.summaryDate,reportId:String(report.id),eventCount,progressUpdated};
  });
}

export async function codexPluginBrowserStatus(session:SessionUser){
  await ensure();
  if(session.account_type!=='engineer')fail(403,'codex_engineer_access_denied');
  const rows=(await getPool().query(`select files_device.id as device_id,coalesce(node.machine_name,files_device.device_label,files_device.hostname,'Approved device') as device_name,
      connection.plugin_version,connection.connected_at,connection.last_seen_at,connection.last_poll_at,
      connection.last_poll_at>now()-interval '2 minutes' as polling
    from files_agent_devices files_device
    join app_users engineer on engineer.id=files_device.user_id and engineer.company_id=files_device.company_id and engineer.account_type='engineer' and engineer.approval_status='approved'
    left join tracemini_node_devices node on node.id=files_device.node_device_id and node.user_id=files_device.user_id and node.company_id=files_device.company_id
    left join codex_plugin_connections connection on connection.device_id=files_device.id and connection.user_id=files_device.user_id and connection.company_id=files_device.company_id
    where files_device.user_id=$1 and files_device.company_id=$2 and files_device.revoked_at is null
      and (node.id is null or (node.revoked_at is null and node.expires_at>now()))
    order by (connection.last_poll_at is not null) desc,connection.last_poll_at desc nulls last,files_device.id desc`,[session.id,session.company_id])).rows;
  const devices=rows.map(row=>({
    deviceId:String(row.device_id),deviceName:String(row.device_name).slice(0,80),pluginVersion:row.plugin_version?String(row.plugin_version):null,
    status:row.polling?'polling':row.connected_at?'connected':'not_connected',
    connectedAt:row.connected_at?new Date(row.connected_at).toISOString():null,
    lastSeenAt:row.last_seen_at?new Date(row.last_seen_at).toISOString():null,
    lastPollAt:row.last_poll_at?new Date(row.last_poll_at).toISOString():null,
  }));
  const best=devices.find(device=>device.status==='polling')||devices.find(device=>device.status==='connected');
  const connectionRows=(await getPool().query(`select distinct connected.id,connected.title,connected.source
    from (
      select project.id,project.title,'plugin'::text as source
      from codex_plugin_project_bindings binding
      join projects project on project.id=binding.project_id and project.approval_status='approved' and project.status<>'archived'
      join project_memberships membership on membership.project_id=project.id and membership.user_id=$1 and membership.membership_status='active'
      join files_agent_devices device on device.id=binding.device_id and device.user_id=$1 and device.company_id=$2 and device.revoked_at is null
      where binding.user_id=$1 and binding.company_id=$2
      union
      select project.id,project.title,'trace'::text as source
      from project_tracemini_roots root
      join projects project on project.id=root.project_id and project.approval_status='approved' and project.status<>'archived'
      join project_memberships membership on membership.project_id=project.id and membership.user_id=$1 and membership.membership_status='active'
      join files_agent_devices device on device.id=root.device_id and device.user_id=$1 and device.company_id=$2 and device.revoked_at is null
      where root.status='approved' and root.revoked_at is null
    ) connected order by connected.title,connected.id,connected.source`,[session.id,session.company_id])).rows;
  const projectConnections=Array.from(connectionRows.reduce((projects:Map<string,{id:string;title:string;sources:string[]}>,row)=>{
    const key=String(row.id),current=projects.get(key)||{id:key,title:String(row.title).slice(0,200),sources:[]};
    if(!current.sources.includes(String(row.source)))current.sources.push(String(row.source));
    projects.set(key,current);return projects;
  },new Map()).values());
  const daily=(await getPool().query(`select ((now() at time zone 'Asia/Karachi')::date-1)::text as summary_date,
      count(distinct project.id)::int as connected_projects,
      count(distinct run.project_id) filter(where run.status='completed')::int as completed_projects,
      count(distinct run.project_id) filter(where run.status='running')::int as running_projects,
      count(distinct run.project_id) filter(where run.status='failed')::int as failed_projects,
      max(run.completed_at) as last_completed_at
    from projects project
    join project_memberships membership on membership.project_id=project.id and membership.user_id=$1 and membership.membership_status='active'
    left join codex_plugin_daily_runs run on run.project_id=project.id and run.user_id=$1 and run.summary_date=((now() at time zone 'Asia/Karachi')::date-1)::date and run.summary_version>=4
    where project.approval_status='approved' and project.status<>'archived'
      and (
        exists(select 1 from project_tracemini_roots root join files_agent_devices device on device.id=root.device_id and device.user_id=$1 and device.company_id=$2 and device.revoked_at is null
          where root.project_id=project.id and root.status='approved' and root.revoked_at is null)
        or exists(select 1 from codex_plugin_project_bindings binding join files_agent_devices device on device.id=binding.device_id and device.user_id=$1 and device.company_id=$2 and device.revoked_at is null
          where binding.project_id=project.id and binding.user_id=$1 and binding.company_id=$2)
      )`,[session.id,session.company_id])).rows[0]||{};
  const connected=Number(daily.connected_projects||0),completed=Number(daily.completed_projects||0),running=Number(daily.running_projects||0),failed=Number(daily.failed_projects||0);
  const dailySummary=connected===0
    ? {status:'waiting',label:'No connected projects yet',detail:'Connect a project so Codex can post work updates and daily summaries.',completedAt:null}
    : completed>=connected
      ? {status:'completed',label:'Codex daily summaries pushed',detail:`${completed} connected project${completed===1?' was':'s were'} summarized from Codex work updates for ${daily.summary_date}.`,completedAt:daily.last_completed_at?new Date(daily.last_completed_at).toISOString():null}
      : running>0
        ? {status:'running',label:'Codex summaries in progress',detail:`${completed} of ${connected} connected projects summarized from Codex work updates for ${daily.summary_date}.`,completedAt:daily.last_completed_at?new Date(daily.last_completed_at).toISOString():null}
        : failed>0
          ? {status:'failed',label:'Daily summaries will retry',detail:`${completed} of ${connected} connected projects summarized; ${failed} safely queued for retry.`,completedAt:daily.last_completed_at?new Date(daily.last_completed_at).toISOString():null}
          : {status:'waiting',label:'Waiting for Codex updates',detail:`The plugin will summarize plain-language Codex work updates for ${connected} connected project${connected===1?'':'s'}.`,completedAt:null};
  if(best?.status==='polling')return {status:'polling',label:'Connected and polling',detail:`Neo-Nexus is receiving plugin heartbeats from ${best.deviceName}.`,dailySummary,projectConnections,devices};
  if(best)return {status:'connected',label:'Connected, not currently polling',detail:`The plugin was connected on ${best.deviceName}, but no heartbeat arrived in the last two minutes. Open or restart Codex.`,dailySummary,projectConnections,devices};
  return {status:'not_connected',label:'Plugin not connected',detail:devices.length?'Install the plugin, then restart Codex on an approved device.':'Connect this device first, then install the plugin and restart Codex.',dailySummary,projectConnections,devices};
}
export async function nodeGitRequest(token:string,operation:string,body:Record<string,unknown>={}){
  if(operation==='report-poll')return transaction(async db=>{
    exactBody(body,['candidate_id','digest','repository_key']);
    const {row,device}=await reportAuthority(db,token,body);
    // First supported tranche is an individual, single-root metadata report.
    // Never silently label one repository as an entire multi-root report.
    const roots=await db.query(`select id from project_tracemini_roots where project_id=$1 and device_id=$2 and status='approved' and revoked_at is null`,[row.matched_project_id,device.id]);
    if(roots.rowCount!==1)return {job:null};
    const lease=`node-report:${device.id}:${row.id}:${crypto.randomUUID()}`;
    const r=(await db.query(`update project_tracemini_reports set status='running',lease_id=$3,lease_expires_at=now()+interval '5 minutes',attempt_count=attempt_count+1
      where id=(select id from project_tracemini_reports where project_id=$1 and ((requested_by=$2 and scope='personal' and (target_user_id is null or (target_device_id=$4 and target_root_id=$5))) or (scope='workspace' and target_user_id=$2 and target_device_id=$4 and target_root_id=$5)) and include_diff=false and format='markdown' and documents='[]'::jsonb and attempt_count<10 and (next_run_at is null or next_run_at<=now()) and (status='pending' or (status='running' and lease_expires_at<now())) order by id for update skip locked limit 1) returning *`,[row.matched_project_id,device.user_id,lease,device.id,row.root_id])).rows[0];
    if(r)await workspaceReportAuthority(db,r,row,device);
    return {job:r?{id:String(r.id),workspace_id:Number(r.project_id),lease}:null};
  });
  if(operation==='report-job') {
    exactBody(body,['candidate_id','digest','repository_key','id','lease','action','prompt','markdown']);
    const execute=async (db:PoolClient)=>{
      const {row,device}=await reportAuthority(db,token,body);
      // Recheck the supported scope on every phase, including after inference.
      const roots=await db.query(`select id from project_tracemini_roots where project_id=$1 and device_id=$2 and status='approved' and revoked_at is null`,[row.matched_project_id,device.id]);
      if(roots.rowCount!==1)fail(409,'unsupported_report_root_scope');
      if(typeof body.lease!=='string'||!body.lease.startsWith(`node-report:${device.id}:${row.id}:`))fail();
      const job=(await db.query(`select *,start_date::text as start_day,end_date::text as end_day from project_tracemini_reports where id=$1 and project_id=$2 and ((requested_by=$3 and scope='personal' and (target_user_id is null or (target_device_id=$5 and target_root_id=$6))) or (scope='workspace' and target_user_id=$3 and target_device_id=$5 and target_root_id=$6)) and include_diff=false and format='markdown' and documents='[]'::jsonb and status='running' and lease_id=$4 and lease_expires_at>now() for update`,[id(body.id),row.matched_project_id,device.user_id,body.lease,device.id,row.root_id])).rows[0];
      if(!job)fail();
      await workspaceReportAuthority(db,job,row,device);
      if(body.action==='claim')return {claimed:true};
      if(body.action==='generate')return {authorized:true};
      if(body.action==='context') {
        const events=(await db.query(`select e.id,e.kind,e.occurred_at,e.provenance from project_tracemini_events e where e.project_id=$1 and e.root_id=$2 and e.device_id=$3 and e.kind in ('commit','file_change') and e.occurred_at>=($4::date::timestamp at time zone 'UTC') and e.occurred_at<(($5::date+1)::timestamp at time zone 'UTC') order by e.occurred_at desc,e.id desc limit 100`,[job.project_id,row.root_id,device.id,job.start_day,job.end_day])).rows;
        return {job:{id:job.id,user_id:device.user_id,start_date:job.start_day,end_date:job.end_day,timezone:'UTC',include_diff:false,format:'summary',report_scope:job.scope,custom_prompt:'Evidence is limited to the newest 100 stored commits and observed file-change metadata from the selected repository. File changes are observations, not proof of content, delivery or authorship. State these limitations. '+safeReportText(job.prompt)},events:events.filter(e=>e.kind==='file_change'?(e.provenance?.local_source==='local-worktree-reconciliation-v1'||(e.provenance?.observer_source==='signed-kernel-observer-v1'&&/^[a-f0-9]{64}$/.test(e.provenance?.observer_receipt))):/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(e.provenance?.head_sha)).map(e=>{const integer=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;const subject=safeGitWorkText(e.provenance?.commit_subject,600);return {id:e.id,type:e.kind==='file_change'?'file_change':'commit',user_id:device.user_id,repository_name:row.display_name,normalized_remote:row.repository_key,occurred_at:e.occurred_at,data:e.kind==='file_change'?{operation:e.provenance.operation,filesChanged:e.provenance.files_changed}:{commitSha:e.provenance.head_sha,...(subject?{message:subject}:{}),...(integer(e.provenance?.files_changed)!==undefined?{filesChanged:integer(e.provenance.files_changed)}:{}),...(integer(e.provenance?.insertions)!==undefined?{insertions:integer(e.provenance.insertions)}:{}),...(integer(e.provenance?.deletions)!==undefined?{deletions:integer(e.provenance.deletions)}:{})}};} )};
      }
      if(body.action==='complete') {
        const markdown=safeReportText(body.markdown);if(!markdown)fail(400,'empty_report');
        await db.query(`update project_tracemini_reports set status='completed',markdown=$2,completed_at=now(),lease_id=null,lease_expires_at=null where id=$1`,[job.id,markdown]);
        await saveOriginalTraceMiniSummary(db,String(job.id),String(device.user_id),String(row.root_id),String(device.id));
        return {completed:true};
      }
      if(body.action==='fail'){
        // Retry only automatic work, on existing polls and with the same scoped job.
        const automatic=String(job.dedupe_key||'').startsWith('automatic-original:');
        const retry=automatic && Number(job.attempt_count)<10;
        await db.query(`update project_tracemini_reports set status=$2,last_error=$3,next_run_at=case when $4::boolean then now()+make_interval(secs => least(900,30*power(2,greatest(attempt_count-1,0)))) else null end,lease_id=null,lease_expires_at=null where id=$1`,[job.id,retry?'pending':'failed',retry?'Automatic summary retry scheduled':automatic?'Automatic summary retries exhausted; saved summary may be stale':'Report generation failed',retry]);return {failed:true};
      }
      fail(400,'unsupported_report_action');
    };
    const result=await transaction(execute);
    if(body.action!=='generate')return result;
    if(typeof body.prompt!=='string'||body.prompt.length>64000||safeReportText(body.prompt)!==body.prompt)fail(400,'unsafe_report_prompt');
    const markdown=await generateTraceReport(String(body.prompt));
    await transaction(execute); // Revocation/lease expiry during inference fails closed.
    return markdown;
  }

  const device=await identity(token), credential={nodeToken:token};
  if(operation==='codex-heartbeat') {
    exactBody(body,['pluginVersion']);
    const pluginVersion=codexPluginVersion(body.pluginVersion);
    await codexProfile(device);
    await recordCodexPluginConnection(device,pluginVersion,true);
    return {ok:true,polling:true,checkedAt:new Date().toISOString()};
  }
  if(operation==='codex-daily-summary') {
    exactBody(body,['pluginVersion']);
    const pluginVersion=codexPluginVersion(body.pluginVersion);
    await codexProfile(device);
    await recordCodexPluginConnection(device,pluginVersion,true);
    const claim=await claimCodexDailySummary(device);
    if(!claim)return {processed:false,status:'up_to_date',checkedAt:new Date().toISOString()};
    try {
      const {project,context}=await codexDailyContext(claim);
      const dailyCount=context.dailyPluginUpdates.length;
      const completedWork=context.recentPluginUpdates.some(update=>update.status==='completed');
      const generated=dailyCount>0
        ? await generateDailyProjectSummary(JSON.stringify(context),Number(project.progress_version),completedWork&&project.progress_source!=='manual'&&!['completed','archived'].includes(String(project.status)))
        : {markdown:`Daily Codex summary for ${claim.summaryDate}\n\nNo Codex work update was posted for this project on this day.`,progress:null};
      return await completeCodexDailySummary(claim,generated.markdown,generated.progress,dailyCount);
    } catch {
      await failCodexDailySummary(claim);
      return {processed:true,status:'failed',projectId:claim.projectId,summaryDate:claim.summaryDate,retryScheduled:claim.attemptCount<3};
    }
  }
  if(operation==='codex-profile') {
    exactBody(body,[]);
    return codexProfile(device);
  }
  if(operation==='codex-project-options') {
    return codexProjectOptions(device,body);
  }
  if(operation==='codex-project-connect') {
    return connectCodexProject(device,body);
  }
  if(operation==='codex-context') {
    const selectedProject=await codexProject(device,body);
    const {project,session}=await codexEngineerSession(device,selectedProject);
    const [overview,requests]=await Promise.all([getProjectOverview(session,project),listClientRequests(session,project)]);
    return {
      project:overview.project,
      clientName:overview.clientName,
      stage:overview.stage,
      progress:overview.progress,
      assessment:overview.assessment,
      openClientRequests:requests.filter(request=>request.status!=='resolved').slice(0,20).map(request=>({
        id:String(request.id),summary:String(request.summary??'').slice(0,160),details:String(request.details??'').slice(0,2000),
        kind:request.kind==='issue'?'issue':'task',status:request.status==='in_progress'?'in_progress':'open',unread:request.unread===true,
        lastUpdatedBy:request.last_updated_by?String(request.last_updated_by).slice(0,160):null,
        lastUpdatedVia:request.last_updated_via==='codex_plugin'?'codex_plugin':request.last_updated_via==='web'?'web':null,
        updatedAt:new Date(request.updated_at).toISOString(),
      })),
    };
  }
  if(operation==='codex-work-update') {
    return recordCodexWorkUpdate(device,body);
  }
  if(operation==='codex-deployment-update') {
    return updateCodexDeployment(device,body);
  }
  if(operation==='codex-other-work-update') {
    return recordCodexOtherWorkUpdate(device,body);
  }
  if(operation==='codex-request-status') {
    exactBody(body,['workspaceId','requestId','status']);
    const {project,session}=await codexEngineerSession(device,body.workspaceId);
    return {request:await updateClientRequest(session,project,body.requestId,body.status,{source:'codex_plugin',deviceId:device.id})};
  }
  if(operation==='retry') {
    // Explicit, one-shot CAS recovery only. This never selects a new repository,
    // acknowledges activation, changes consent, or runs from the polling loop.
    exactBody(body,['candidate_id','revision','project_id','digest','repository_key']);
    return transaction(async db=>{
      const live=await deviceForCredential(db,credential);
      const c=(await db.query(`select c.id,c.revision from tracemini_repository_candidates c
        join tracemini_repository_selections s on s.candidate_id=c.id and s.revision=c.revision
        join projects p on p.id=c.matched_project_id and p.approval_status='approved'
        join app_users owner on owner.id=p.client_id and owner.approval_status='approved'
        join project_tracemini_roots r on r.project_id=p.id and r.device_id=c.device_id and r.repository_key=c.repository_key
          and r.root_hash=encode(sha256(convert_to('tracemini-discovery-candidate:'||c.id::text,'UTF8')),'hex')
        where c.id=$1 and c.device_id=$2 and c.company_id=$3 and s.owner_user_id=$4
          and c.revision=$5 and p.id=$6 and c.fingerprint=$7::jsonb and c.repository_key=$8
          and s.desired_tracking=true and s.completed_at is not null and c.tracking_state='stopped'
          and r.status='revoked' and r.revoked_at=s.completed_at and s.claimed_at<=s.completed_at
          and (case when c.explicit_project_id is not null then p.id=c.explicit_project_id else p.git_repository_key=c.repository_key end)
          and (p.client_id=$4 or exists(select 1 from project_memberships m where m.project_id=p.id and m.user_id=$4 and m.membership_status='active'))
          and (c.explicit_project_id=p.id or (select count(*) from projects q join app_users qo on qo.id=q.client_id and qo.approval_status='approved' where q.approval_status='approved' and q.git_repository_key=c.repository_key and (q.client_id=$4 or exists(select 1 from project_memberships qm where qm.project_id=q.id and qm.user_id=$4 and qm.membership_status='active')))=1)
          and not exists(select 1 from tracemini_tracked_repositories t where t.candidate_id=c.id)
        for update of c,s,r,p,owner`,[id(body.candidate_id),live.id,live.company_id,live.user_id,id(body.revision),id(body.project_id),JSON.stringify({digest:digest(body.digest)}),body.repository_key])).rows[0];
      if(!c)fail(409,'retry_unavailable');
      // Lock current membership too: revocation must serialize with recovery.
      await db.query('select id from project_memberships where project_id=$1 and user_id=$2 for share',[id(body.project_id),live.user_id]);
      const authority=await db.query(`select p.id from projects p where p.id=$1 and (p.client_id=$2 or exists(select 1 from project_memberships m where m.project_id=p.id and m.user_id=$2 and m.membership_status='active'))`,[id(body.project_id),live.user_id]);
      if(!authority.rowCount)fail(409,'retry_unavailable');
      await db.query("update tracemini_repository_candidates set revision=revision+1,tracking_state='pending',updated_at=now() where id=$1",[c.id]);
      await db.query('update tracemini_repository_selections set revision=revision+1,claimed_at=null,claim_token=null,completed_at=null,updated_at=now() where candidate_id=$1',[c.id]);
      return {candidateId:String(c.id),revision:Number(c.revision)+1,desiredTracking:true};
    });
  }
  if(operation==='sync'){
    exactBody(body,[]);
    const claimed=await claimDeviceWork(credential);
    const projects=await getPool().query(`select c.id,c.matched_project_id from tracemini_repository_candidates c where c.device_id=$1`,[device.id]);
    const projectByCandidate=new Map(projects.rows.map(r=>[String(r.id),r.matched_project_id]));
    const access=await getPool().query(`select distinct p.id from projects p join app_users owner on owner.id=p.client_id and owner.approval_status='approved'
      join tracemini_repository_candidates c on c.matched_project_id=p.id and (case when c.explicit_project_id is not null then c.explicit_project_id=p.id else c.repository_key=p.git_repository_key end) and c.device_id=$1 and c.company_id=$2
      join project_tracemini_roots r on r.project_id=p.id and r.device_id=c.device_id and r.status='approved' and r.revoked_at is null
      where p.approval_status='approved' and p.status<>'archived' and (p.client_id=$3 or exists(select 1 from project_memberships m where m.project_id=p.id and m.user_id=$3 and m.membership_status='active'))`,[device.id,device.company_id,device.user_id]);
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
      if(body.status==='verified') {
        const inserted=await db.query(`insert into project_tracemini_events(project_id,device_id,root_id,event_key,kind,action,repository_key,occurred_at,provenance,evidence_eligible,resume_epoch)
          select p.id,$2,$3,$4,'push','git_push',$5,$6,$7::jsonb,false,p.tracemini_resume_epoch from projects p where p.id=$1 on conflict(root_id,event_key) do nothing returning id`,
          [row.matched_project_id,device.id,row.root_id,push.node_event_key,row.repository_key,push.created_at,JSON.stringify({head_sha:body.expected_head_sha,remote_head_sha:body.observed_sha})]);
        await saveAcceptedEngineerEvents(db,String(row.matched_project_id),inserted.rows.map(e=>e.id));
      }
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
  if(operation==='registration-status') {
    exactBody(body,['candidate_id','digest','repository_key']);
    return transaction(async db=>{const {row}=await authorized(db,token,body);
      if(!row.completed_at)fail(409,'selection_not_completed');
      return {registered:true,candidate_id:String(row.id),project_id:Number(row.matched_project_id),revision:Number(row.revision),claim_token:row.claim_token};
    });
  }
  if(operation==='register'){
    exactBody(body,['candidate_id','digest','repository_key','revision','claim_token','project_id']);
    return transaction(async db=>{const {row}=await authorized(db,token,body,true);await db.query(`insert into tracemini_node_registrations(candidate_id,revision,claim_token) values($1,$2,$3) on conflict(candidate_id) do update set revision=excluded.revision,claim_token=excluded.claim_token`,[row.id,row.revision,row.claim_token]);return {id:Number(row.id),project_id:Number(row.matched_project_id),normalized_remote:row.repository_key,name:row.display_name};});
  }
  if(operation==='activity'){
    exactBody(body,['candidate_id','digest','repository_key','claim_token','event_key','kind','occurred_at','provenance','history']);
    if(!['commit','branch','merge','rewrite','pull','stage','push','file_change'].includes(String(body.kind)))fail(400,'unsupported_git_event');
    digest(body.event_key);
    const occurred=new Date(String(body.occurred_at));
    // A newly selected repository imports its complete reachable Git history.
    // Only live events use the recency bound; a history event may legitimately
    // predate the installation by years.
    if(!Number.isFinite(occurred.getTime())||occurred.getTime()>Date.now()+300000||(body.history!==true&&occurred.getTime()<Date.now()-91*86400000))fail(400,'invalid_event_time');
    const provenance=body.provenance as Record<string,unknown>;
    if(!provenance||typeof provenance!=='object'||Array.isArray(provenance))fail(400,'invalid_provenance');
    if(body.kind==='file_change') {
      const localObserved=provenance.local_source==='local-worktree-reconciliation-v1'&&provenance.attribution==='unattributed';
      if(localObserved) {
        exactBody(provenance,['local_source','attribution','operation','files_changed']);
        if(body.history===true||provenance.operation!=='modify'||provenance.files_changed!==1)fail(400,'invalid_local_change');
      } else {
        exactBody(provenance,['observer_source','observer_receipt','operation','agent','files_changed']);
        if(body.history===true||provenance.observer_source!=='signed-kernel-observer-v1'||typeof provenance.observer_receipt!=='string'||!/^[a-f0-9]{64}$/.test(provenance.observer_receipt)||!['codex','hermes','claude'].includes(String(provenance.agent))||!['create','modify','rename','delete','mkdir','rmdir','symlink','link'].includes(String(provenance.operation))||provenance.files_changed!==1)fail(400,'invalid_observer_receipt');
      }
    } else exactBody(provenance,['head_sha','remote_head_sha','old_head_sha','new_head_sha','files_changed','insertions','deletions','commit_subject','git_author_name']);
    for(const [k,v] of Object.entries(provenance)) {
      if(body.kind==='file_change')continue;
      if(k==='commit_subject'||k==='git_author_name') {
        if(body.kind!=='commit'||typeof provenance.head_sha!=='string'||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(provenance.head_sha)||safeGitWorkText(v,k==='commit_subject'?600:120)!==v)fail(400,'invalid_provenance');
      } else if(k.endsWith('_sha')?typeof v!=='string'||!/^[a-f0-9]{40,64}$/.test(v):typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>1e9)fail(400,'invalid_provenance');
    }
    return transaction(async db=>{
      const {row,device}=await authorized(db,token,body);
      const settings=(await db.query(`select tracemini_global_pause,tracemini_embedded_enabled from tracemini_runtime_settings where singleton=true`)).rows[0];
      if(row.tracemini_telemetry_paused||!settings?.tracemini_embedded_enabled||settings.tracemini_global_pause)fail(503,'git_telemetry_paused');
      const result=await db.query(`insert into project_tracemini_events(project_id,device_id,root_id,event_key,kind,action,repository_key,occurred_at,provenance,evidence_eligible,resume_epoch)
        select p.id,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,false,p.tracemini_resume_epoch from projects p where p.id=$1 on conflict(root_id,event_key) do nothing returning id`,[row.matched_project_id,device.id,row.root_id,body.event_key,body.kind,body.history===true&&body.kind==='commit'?'commit_history':'git_'+body.kind,row.repository_key,occurred.toISOString(),JSON.stringify(provenance)]);
      await saveAcceptedEngineerEvents(db,String(row.matched_project_id),result.rows.map(e=>e.id));
      return {accepted:result.rowCount,duplicates:result.rowCount?0:1};
    });
  }
  fail(404,'unsupported_node_git_operation');
}
