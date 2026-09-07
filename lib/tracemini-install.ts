import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { ensureSchema, getPool } from './db';
import type { SessionUser } from './auth';

export const NODE_PENDING = 'Repository privacy mapping, sync leases and Git ingestion are pending. No hooks, watched folders or background service are enabled.';
export class NodeInstallError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const invalid = () => new NodeInstallError(403, 'invalid_or_expired_credential');
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const secret = (prefix: string) => prefix+'_'+crypto.randomBytes(32).toString('base64url');
const valid = (s: unknown, prefix: string): s is string => typeof s === 'string' && new RegExp('^'+prefix+'_[A-Za-z0-9_-]{43}$').test(s);
let schema: Promise<void> | undefined;
export async function ensureNodeInstallSchema() {
  if (!schema) schema=(async()=>{
    await ensureSchema();
    await getPool().query(fs.readFileSync(path.join(process.cwd(),'migrations/021_tracemini_node_install.sql'),'utf8'));
  })().catch(e=>{schema=undefined;throw e;});
  await schema;
}
export function trustedNodeOrigin() {
  try {
    const url=new URL(process.env.NEXT_PUBLIC_APP_URL || '');
    if(url.username || url.password || url.search || url.hash || url.pathname!=='/' || (url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new Error();
    return url.origin;
  } catch { throw new NodeInstallError(503,'trusted_application_origin_required'); }
}
function safeId(value: unknown) {
  const id=Number(value);if(!Number.isSafeInteger(id)||id<1)throw new NodeInstallError(500,'invalid_identifier');return id;
}
export function exactBody(body: Record<string,unknown>, allowed: string[]) {
  if(Object.keys(body).some(k=>!allowed.includes(k)))throw new NodeInstallError(400,'invalid_request_fields');
}
async function transaction<T>(fn:(db:PoolClient)=>Promise<T>):Promise<T>{
  await ensureNodeInstallSchema(); const db=await getPool().connect();
  try {await db.query('begin');const out=await fn(db);await db.query('commit');return out;}
  catch(e){await db.query('rollback');throw e;}finally{db.release();}
}
export async function mintNodeInstallation(user:SessionUser) {
  return transaction(async db=>{
    const owner=await db.query(`select id from app_users where id=$1 and company_id=$2 and email=$3 and approval_status='approved' for update`,[user.id,user.company_id,user.email]);
    if(!owner.rows[0])throw invalid();
    const recent=await db.query(`select count(*)::int as n from tracemini_node_installations where user_id=$1 and company_id=$2 and created_at>now()-interval '1 hour'`,[user.id,user.company_id]);
    if(recent.rows[0].n>=5)throw new NodeInstallError(429,'installation_rate_exceeded');
    const context=await db.query(`insert into tracemini_node_contexts(company_id,user_id) values($1,$2) on conflict(company_id,user_id) do update set user_id=excluded.user_id returning id`,[user.company_id,user.id]);
    const token=secret('eti');
    const result=await db.query(`insert into tracemini_node_installations(context_id,company_id,user_id,token_hash,expires_at) values($1,$2,$3,$4,now()+interval '10 minutes') returning expires_at`,[context.rows[0].id,user.company_id,user.id,hash(token)]);
    return {token,expiresAt:new Date(result.rows[0].expires_at).toISOString()};
  });
}
export async function validateNodeInstallation(token:unknown) {
  if(!valid(token,'eti'))throw invalid();await ensureNodeInstallSchema();
  const r=await getPool().query(`select e.id from tracemini_node_installations e join app_users u on u.id=e.user_id and u.company_id=e.company_id where e.token_hash=$1 and e.used_at is null and e.expires_at>now() and e.scope='node-git-install-v1' and u.approval_status='approved'`,[hash(token)]);
  if(!r.rows[0])throw invalid();
}
export async function exchangeNodeInstallation(body:Record<string,unknown>,previousToken:string) {
  exactBody(body,['installToken','machineName','installationId']);
  if(!valid(body.installToken,'eti'))throw invalid();
  if(typeof body.installationId!=='string'|| !/^[a-f0-9]{64}$/.test(body.installationId) || typeof body.machineName!=='string' || !/^[^\x00-\x1f\x7f]{1,80}$/.test(body.machineName))throw new NodeInstallError(400,'invalid_device_details');
  const token=body.installToken, installationHash=hash(body.installationId), machine=body.machineName;
  return transaction(async db=>{
    // Lock approval + enrollment together, and serialize all devices for this account.
    const r=await db.query(`select e.* from tracemini_node_installations e join app_users u on u.id=e.user_id and u.company_id=e.company_id where e.token_hash=$1 and e.used_at is null and e.expires_at>now() and e.scope='node-git-install-v1' and u.approval_status='approved' for update of u,e`,[hash(token)]);
    const e=r.rows[0];if(!e)throw invalid();
    const existing=await db.query(`select id,credential_hash,expires_at from tracemini_node_devices where context_id=$1 and installation_hash=$2 and revoked_at is null for update`,[e.context_id,installationHash]);
    let deviceId, credential, created=false;
    if(existing.rows[0]){
      const old=existing.rows[0];
      if(!valid(previousToken,'etn') || hash(previousToken)!==old.credential_hash || new Date(old.expires_at).getTime()<=Date.now())throw invalid();
      // Keep the credential: rollback must never strand an existing installation.
      deviceId=old.id;credential=previousToken;
    }else{
      const count=await db.query(`select count(*)::int as n from tracemini_node_devices where context_id=$1 and revoked_at is null and expires_at>now()`,[e.context_id]);
      if(count.rows[0].n>=10)throw new NodeInstallError(429,'node_device_limit');
      credential=secret('etn');created=true;
      const inserted=await db.query(`insert into tracemini_node_devices(context_id,company_id,user_id,installation_hash,credential_hash,machine_name) values($1,$2,$3,$4,$5,$6) returning id`,[e.context_id,e.company_id,e.user_id,installationHash,hash(credential),machine]);deviceId=inserted.rows[0].id;
    }
    await db.query('update tracemini_node_installations set used_at=now() where id=$1',[e.id]);
    return {agentId:safeId(deviceId),agentToken:credential,workspaceId:safeId(e.context_id),contextKind:'account-discovery',capability:'node-git-v1',created,state:'pending_sync',syncEnabled:false,message:NODE_PENDING};
  });
}
export async function nodeDeviceStatus(token:string,abort=false){
  if(!valid(token,'etn'))throw invalid();
  return transaction(async db=>{
    const r=await db.query(`select d.id,d.context_id from tracemini_node_devices d join app_users u on u.id=d.user_id and u.company_id=d.company_id where d.credential_hash=$1 and d.capability='node-git-v1' and d.revoked_at is null and d.expires_at>now() and u.approval_status='approved' for update of u,d`,[hash(token)]);
    const d=r.rows[0];if(!d)throw invalid();
    await db.query(abort?'update tracemini_node_devices set revoked_at=now() where id=$1':'update tracemini_node_devices set authenticated_at=now() where id=$1',[d.id]);
    return {agentId:safeId(d.id),workspaceId:safeId(d.context_id),contextKind:'account-discovery',capability:'node-git-v1',state:abort?'revoked':'pending_sync',syncEnabled:false,message:NODE_PENDING};
  });
}
export async function listNodeInstallations(user:SessionUser){
  await ensureNodeInstallSchema();
  const r=await getPool().query(`select d.id,d.machine_name,d.revoked_at from tracemini_node_devices d join app_users u on u.id=d.user_id and u.company_id=d.company_id where d.user_id=$1 and d.company_id=$2 and u.email=$3 and u.approval_status='approved' and d.revoked_at is null and d.expires_at>now() order by d.id`,[user.id,user.company_id,user.email]);
  return {agents:r.rows.map(d=>({id:safeId(d.id),machine_name:d.machine_name,status:'pending_sync',capability:'node-git-v1'})),state:'pending_sync',syncEnabled:false,message:NODE_PENDING};
}
