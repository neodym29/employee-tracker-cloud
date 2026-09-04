import crypto from 'node:crypto';
import { ensureSchema, getPool } from './db';
import { hashFilesAgentSecret, FilesAgentError } from './files-agent';
import type { SessionUser } from './auth';

const EVENT_KINDS = new Set(['file_activity','non_git','dirty','commit','branch','merge','rewrite','pull','stage','push']);
const EVENT_FIELDS = new Set(['event_key','kind','repository_key','occurred_at','provenance','action','agent','run_id']);
const PROVENANCE_FIELDS = new Set(['branch','head_sha','remote_head_sha','files_changed','insertions','deletions','old_head_sha','new_head_sha','approved_agent','run_id','dirty','dirty_paths','root_label','repository_key']);
const AGENTS = new Set(['hermes','codex','claude']);
const MAX_EVENTS = 250;

function exact(value: Record<string, unknown>, allowed: Set<string>, label: string) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new FilesAgentError(`${label} contains unknown or prohibited field (${unknown})`, 400);
}
function text(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value,'utf8') > max || /[\u0000-\u001f\u007f]/.test(value)) throw new FilesAgentError(`${label} is invalid`, 400);
  return value.trim();
}
function safeEqualHex(actual: string, expected: string) {
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(actual,'hex'), Buffer.from(expected,'hex'));
}
function bindingKey() {
  const key = process.env.FILES_AGENT_BINDING_KEY || process.env.SESSION_SECRET;
  if (!key || Buffer.byteLength(key) < 32) throw new FilesAgentError('binding service unavailable', 503);
  return key;
}
function deriveBindingSecret(bindingId: string, deviceId: string, projectId: string) {
  return crypto.createHmac('sha256', bindingKey()).update(`${bindingId}\0${deviceId}\0${projectId}`).digest('base64url');
}
function safeProvenance(value: unknown) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FilesAgentError('provenance must be an object', 400);
  const record=value as Record<string,unknown>; exact(record,PROVENANCE_FIELDS,'provenance'); const output:Record<string,unknown>={};
  for (const [key,item] of Object.entries(record)) {
    if (typeof item === 'string' && item.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(item)) output[key]=item;
    else if (typeof item === 'number' && Number.isSafeInteger(item) && item>=0 && item<=1_000_000_000) output[key]=item;
    else if (typeof item === 'boolean' && key==='dirty') output[key]=item;
    else throw new FilesAgentError('provenance value is invalid',400);
  }
  return output;
}
export function normalizeEmbeddedIngest(body: Record<string,unknown>) {
  exact(body,new Set(['events']),'request');
  if (!Array.isArray(body.events) || body.events.length<1 || body.events.length>MAX_EVENTS) throw new FilesAgentError(`events must contain 1 to ${MAX_EVENTS} items`,400);
  return body.events.map((raw,index)=>{
    if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new FilesAgentError(`events[${index}] must be an object`,400);
    const event=raw as Record<string,unknown>; exact(event,EVENT_FIELDS,`events[${index}]`);
    const kind=text(event.kind,`events[${index}].kind`,32); if(!EVENT_KINDS.has(kind)) throw new FilesAgentError('unsupported event kind',400);
    const agent=text(event.agent,`events[${index}].agent`,16); if(!AGENTS.has(agent)) throw new FilesAgentError('unsupported approved agent',400);
    const runId=text(event.run_id,`events[${index}].run_id`,64); if(!/^[a-f0-9]{32,64}$/.test(runId)) throw new FilesAgentError('run_id is invalid',400);
    const occurred=new Date(text(event.occurred_at,`events[${index}].occurred_at`,100));
    if(Number.isNaN(occurred.getTime()) || occurred.getTime()>Date.now()+300000 || occurred.getTime()<Date.now()-7*86400000) throw new FilesAgentError('occurred_at is outside the allowed window',400);
    const repositoryKey=event.repository_key==null?null:text(event.repository_key,`events[${index}].repository_key`,1024);
    if(['commit','branch','merge','rewrite','pull','stage','push'].includes(kind) && !repositoryKey) throw new FilesAgentError('Git event requires repository_key',400);
    return {eventKey:text(event.event_key,`events[${index}].event_key`,200),kind,action:event.action==null?null:text(event.action,'action',64),agent,runId,repositoryKey,occurredAt:occurred.toISOString(),provenance:safeProvenance(event.provenance)};
  });
}

export function verifyEmbeddedBinding(rawBody: Buffer, signature: string, bindingId: string, deviceId: string, projectId: string, request?: { method?: string; path?: string; timestamp?: string; nonce?: string }) {
  const timestamp=request?.timestamp || ''; const nonce=request?.nonce || '';
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now()/1000-Number(timestamp))>300 || !/^[a-f0-9]{32}$/.test(nonce)) throw new FilesAgentError('stale or malformed binding proof',401);
  const canonical=[request?.method || 'POST',request?.path || '/api/files-agent/tracemini',timestamp,nonce,crypto.createHash('sha256').update(rawBody).digest('hex')].join('\n');
  const expected=crypto.createHmac('sha256',deriveBindingSecret(bindingId,deviceId,projectId)).update(canonical).digest('hex');
  if(!safeEqualHex(signature,expected)) throw new FilesAgentError('invalid TraceMini binding signature',401);
}

export async function ingestEmbeddedEvents(credential:string, rawBody:Buffer, body:Record<string,unknown>, auth:{bindingId:string;signature:string;timestamp:string;nonce:string;path?:string}) {
  if(!credential.startsWith('fad_')) throw new FilesAgentError('invalid device credential',401);
  const events=normalizeEmbeddedIngest(body); await ensureSchema(); const pool=getPool(); const client=await pool.connect();
  try {
    await client.query('begin');
    const device=(await client.query(`select d.id,d.user_id from files_agent_devices d join app_users u on u.id=d.user_id where d.credential_hash=$1 and d.revoked_at is null and u.approval_status='approved' for update of d`,[hashFilesAgentSecret(credential)])).rows[0];
    if(!device) throw new FilesAgentError('invalid or revoked device credential',401);
    const binding=(await client.query(`select r.id,r.project_id,r.device_id,r.binding_id,r.binding_secret_hash from project_tracemini_roots r where r.binding_id=$1 and r.device_id=$2 and r.status='approved' and r.revoked_at is null and r.last_heartbeat_at > now()-interval '15 minutes' for update`,[auth.bindingId,device.id])).rows[0];
    if(!binding) throw new FilesAgentError('invalid, revoked, or stale TraceMini binding',401);
    const derived=deriveBindingSecret(binding.binding_id,String(device.id),String(binding.project_id));
    if(!safeEqualHex(binding.binding_secret_hash,hashFilesAgentSecret(derived))) throw new FilesAgentError('invalid binding secret',401);
    verifyEmbeddedBinding(rawBody,auth.signature,binding.binding_id,String(device.id),String(binding.project_id),auth);
    const replay=await client.query(`insert into tracemini_request_nonces(binding_id,nonce) values($1,$2) on conflict do nothing returning nonce`,[binding.binding_id,auth.nonce]);
    if(!replay.rows[0]) throw new FilesAgentError('replayed binding proof',401);
    const settings=(await client.query(`select tracemini_global_pause,tracemini_embedded_enabled from tracemini_runtime_settings where singleton=true`)).rows[0];
    if(!settings?.tracemini_embedded_enabled || settings.tracemini_global_pause) throw new FilesAgentError('TraceMini telemetry is paused',503);
    const rate=await client.query(`insert into files_agent_rate_limits(scope_key,window_start,event_count) values($1,date_trunc('minute',now()),$2) on conflict(scope_key,window_start) do update set event_count=files_agent_rate_limits.event_count+excluded.event_count where files_agent_rate_limits.event_count+excluded.event_count<=5000 returning event_count`,[`tracemini:${device.id}`,events.length]);
    if(!rate.rows[0]) throw new FilesAgentError('ingest_rate exceeded; retry later',429);
    let accepted=0;
    for(const event of events) {
      // A client assertion such as push_verified is never accepted as proof.
      // Push evidence is eligible only after a future server-side remote check.
      const evidenceEligible=['file_activity','non_git','dirty'].includes(event.kind)
        && event.provenance.approved_agent === true
        && event.provenance.run_id === event.runId;
      const result=await client.query(`insert into project_tracemini_events(project_id,device_id,root_id,event_key,kind,action,agent,run_id,repository_key,occurred_at,provenance,evidence_eligible,resume_epoch) select r.project_id,r.device_id,r.id,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,p.tracemini_resume_epoch from project_tracemini_roots r join projects p on p.id=r.project_id where r.id=$1 and r.device_id=$2 and r.status='approved' and p.tracemini_telemetry_paused=false on conflict(root_id,event_key) do nothing`,[binding.id,device.id,event.eventKey,event.kind,event.action,event.agent,event.runId,event.repositoryKey,event.occurredAt,JSON.stringify(event.provenance),evidenceEligible]);
      accepted+=result.rowCount||0;
    }
    await client.query(`update files_agent_devices set last_seen_at=now() where id=$1`,[device.id]);
    await client.query('commit'); return {accepted,duplicates:events.length-accepted,received:events.length};
  } catch(error){await client.query('rollback');throw error;} finally {client.release();}
}

export async function issueEmbeddedBindingCode(session:SessionUser,projectValue:unknown,input:Record<string,unknown>){
  exact(input,new Set(['user_id','device_id','root_label']),'request'); const project=String(projectValue??''); if(!/^\d+$/.test(project)) throw new FilesAgentError('invalid project id',400);
  const userId=text(input.user_id,'user_id',30); if(!/^\d+$/.test(userId)) throw new FilesAgentError('user_id is invalid',400);
  const deviceId=text(input.device_id,'device_id',30); if(!/^\d+$/.test(deviceId)) throw new FilesAgentError('device_id is invalid',400);
  const label=text(input.root_label,'root_label',160); if(/[\\/]/.test(label)) throw new FilesAgentError('root_label must not be a path',400);
  await ensureSchema(); const pool=getPool(); const code=`tmb_${crypto.randomBytes(32).toString('base64url')}`; const expires=new Date(Date.now()+10*60_000);
  const result=await pool.query(`insert into project_tracemini_binding_codes(project_id,requested_for_user_id,code_hash,root_label,expires_at,issued_by) select p.id,m.user_id,$3,$4,$5,$6 from projects p join project_memberships m on m.project_id=p.id and m.user_id=$2 and m.membership_status='active' join files_agent_devices d on d.id=$7 and d.user_id=m.user_id and d.revoked_at is null where p.id=$1 and p.approval_status='approved' and (p.client_id=$6 or ($8 and $9)) returning id`,[project,userId,hashFilesAgentSecret(code),label,expires,session.id,deviceId,session.role==='admin',session.account_type==='admin']);
  if(!result.rows[0]) throw new FilesAgentError('owner approval and active project member required',403); return {code,expiresAt:expires.toISOString(),rootLabel:label};
}

export async function bindEmbeddedRoot(credential:string,rawBody:Buffer,input:Record<string,unknown>,auth:{signature:string;timestamp:string;nonce:string;path?:string}){
  exact(input,new Set(['code','root_hash','repository_key']),'request'); const code=text(input.code,'code',100); if(!code.startsWith('tmb_')) throw new FilesAgentError('invalid binding code',403);
  const rootHash=text(input.root_hash,'root_hash',64); if(!/^[a-f0-9]{64}$/.test(rootHash)) throw new FilesAgentError('invalid root proof',400);
  const repositoryKey=input.repository_key==null?null:text(input.repository_key,'repository_key',1024);
  await ensureSchema(); const pool=getPool(); const client=await pool.connect(); try{
    await client.query('begin'); const device=(await client.query(`select d.id,d.user_id from files_agent_devices d join app_users u on u.id=d.user_id where d.credential_hash=$1 and d.revoked_at is null and u.approval_status='approved' for update of d`,[hashFilesAgentSecret(credential)])).rows[0]; if(!device) throw new FilesAgentError('invalid device credential',401);
    const pending=(await client.query(`select * from project_tracemini_binding_codes where code_hash=$1 and requested_for_user_id=$2 and used_at is null and expires_at>now() for update`,[hashFilesAgentSecret(code),device.user_id])).rows[0]; if(!pending) throw new FilesAgentError('invalid, expired, used, or wrong-member binding code',403);
    const proofKey=code;
    const canonical=['POST',auth.path||'/api/files-agent/tracemini/bind',auth.timestamp,auth.nonce,crypto.createHash('sha256').update(rawBody).digest('hex')].join('\n');
    const expected=crypto.createHmac('sha256',proofKey).update(canonical).digest('hex');
    if(!/^\d+$/.test(auth.timestamp)||!/^\d+$/.test(auth.nonce)||Math.abs(Date.now()/1000-Number(auth.timestamp))>300||!safeEqualHex(auth.signature,expected)) throw new FilesAgentError('invalid root possession proof',403);
    const bindingId=crypto.randomBytes(32).toString('base64url'); const secret=deriveBindingSecret(bindingId,String(device.id),String(pending.project_id));
    await client.query(`insert into project_tracemini_roots(project_id,device_id,binding_id,binding_secret_hash,root_hash,root_label,repository_key,status,approved_by,approved_at,last_heartbeat_at) values($1,$2,$3,$4,$5,$6,$7,'approved',$8,now(),now())`,[pending.project_id,device.id,bindingId,hashFilesAgentSecret(secret),rootHash,pending.root_label,repositoryKey,pending.issued_by]);
    await client.query(`update project_tracemini_binding_codes set used_at=now() where id=$1`,[pending.id]); await client.query('commit'); return {binding_id:bindingId,binding_secret:secret,root_hash:rootHash,root_label:pending.root_label};
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function heartbeatEmbeddedBinding(credential:string,rawBody:Buffer,auth:{bindingId:string;signature:string;timestamp:string;nonce:string;path?:string}){
  await ensureSchema(); const pool=getPool(); const client=await pool.connect(); try{await client.query('begin'); const row=(await client.query(`select r.id,r.project_id,r.device_id,r.binding_id from project_tracemini_roots r join files_agent_devices d on d.id=r.device_id where r.binding_id=$1 and d.credential_hash=$2 and d.revoked_at is null and r.status='approved' for update`,[auth.bindingId,hashFilesAgentSecret(credential)])).rows[0]; if(!row) throw new FilesAgentError('invalid binding',401); verifyEmbeddedBinding(rawBody,auth.signature,row.binding_id,String(row.device_id),String(row.project_id),auth); const replay=await client.query(`insert into tracemini_request_nonces(binding_id,nonce) values($1,$2) on conflict do nothing returning nonce`,[row.binding_id,auth.nonce]); if(!replay.rows[0]) throw new FilesAgentError('replayed binding proof',401); await client.query(`update project_tracemini_roots set last_heartbeat_at=now() where id=$1`,[row.id]); await client.query('commit'); return {ok:true};}catch(error){await client.query('rollback');throw error;}finally{client.release();}}
