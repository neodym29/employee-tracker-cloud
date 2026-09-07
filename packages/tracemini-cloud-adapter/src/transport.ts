/** Compatibility boundary: only metadata allowlists reach the cloud. Local paths,
 * credential-bearing remotes, diffs, messages, authors and document data stay local. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {stateDir, enqueue, type Config} from './config.js';
import {normalizeRemote, inspectRepo, repositoryFingerprint, preflightHooks} from './git.js';
import {api as authApi} from './auth-transport.js';
type Work={kind:string;work_id:string;claim_token:string;revision?:number;desired_tracking?:boolean;repository_key?:string;fingerprint?:{digest:string};project_id?:string;candidate_id?:string;branch?:string;expected_head_sha?:string;occurred_at?:string};
type Mapping={localPath:string;digest:string;key:string;normalized:string;candidate?:string;project?:number;revision?:number;claim?:string};
const polls=new Map<string,Work[]>();
const hash=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
const fail=():never=>{throw new Error('Cloud Git request failed or identity/lease unavailable; no synchronization acknowledged');};
function scope(c:Config){return hash(c.serverUrl+'\0'+c.agentToken);}
function directory(c:Config){const dir=path.join(stateDir(),'cloud-git',scope(c));fs.mkdirSync(dir,{recursive:true,mode:0o700});return dir;}
function save(c:Config,m:Mapping){const file=path.join(directory(c),m.digest+'.json'),tmp=file+'.'+crypto.randomUUID();fs.writeFileSync(tmp,JSON.stringify(m),{mode:0o600});fs.renameSync(tmp,file);}
function load(c:Config,digest:unknown):Mapping{if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))return fail();try{return JSON.parse(fs.readFileSync(path.join(directory(c),digest+'.json'),'utf8'));}catch{return fail();}}
export function safeRepositoryKey(remote:string,opaque:string){
  if(/^(local(?:-device-\d+)?:|file:|\/|[a-z]:[\\/])/i.test(remote))return 'local:'+opaque;
  let key:string;
  try{const url=new URL(remote);if(!['https:','http:','ssh:','git:'].includes(url.protocol))return fail();url.username='';url.password='';url.search='';url.hash='';key=normalizeRemote(url.toString());}
  catch{if(!/^(?:[^@/:]+@)?[a-z0-9.-]+:[a-z0-9._/-]+$/i.test(remote))return fail();key=normalizeRemote(remote);}
  if(!/^[a-z0-9][a-z0-9._/-]*$/.test(key)||key.includes('..'))return fail();return key;
}
function mapRepository(c:Config,input:any){
  if(typeof input.localKey!=='string'||typeof input.identityFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(input.identityFingerprint))return fail();
  const localPath=fs.realpathSync(input.localKey);
  if(!c.watchedPaths.some(root=>{try{const relative=path.relative(fs.realpathSync(root),localPath);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}catch{return false;}}))return fail();
  if(repositoryFingerprint(localPath)!==input.identityFingerprint)return fail();
  const info=inspectRepo(localPath), opaque=crypto.createHmac('sha256',c.agentToken!).update(localPath+'\0'+input.identityFingerprint).digest('hex');
  const key=safeRepositoryKey(info.remoteUrl,opaque);
  let prior:Partial<Mapping>={};try{prior=load(c,input.identityFingerprint);}catch{}
  if(prior.localPath && (prior.localPath!==localPath||prior.key!==key))prior={};
  const m={...prior,localPath,digest:input.identityFingerprint,key,normalized:normalizeRemote(info.remoteUrl)} as Mapping;save(c,m);return m;
}
async function send(c:Config,operation:string,body:unknown){
  try{
    const origin=new URL(c.serverUrl);
    if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname))))return fail();
    if(!/^etn_[A-Za-z0-9_-]{43}$/.test(c.agentToken||''))return fail();
    const r=await fetch(origin.origin+'/api/agents/git/'+operation,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+c.agentToken},body:JSON.stringify(body),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});
    if(!r.ok)return fail();const text=await r.text();if(text.length>512*1024)return fail();return JSON.parse(text);
  }catch{return fail();}
}
function lease(c:Config,kind:string,id?:string){const found=(polls.get(scope(c))||[]).find(w=>w.kind===kind&&(!id||String(w.work_id)===id));if(!found)return fail();return found;}
export async function api<T=any>(config:unknown,url:string,init:RequestInit={},agent=true):Promise<T>{
  const c=config as Config;
  if(['/api/agents/install/exchange','/api/agents/install/abort','/api/agents/status'].includes(url))return authApi<T>(c,url,init,agent);
  if(!agent)return fail();
  const input=typeof init.body==='string'?JSON.parse(init.body):{};
  if(url==='/api/agents/sync'&&(!init.method||init.method==='GET')){
    for(const clone of c.clones||[]){
      try {
        const m=load(c,clone.repositoryFingerprint);
        if(!m.candidate||!m.claim||m.localPath!==clone.path||m.project!==clone.workspaceId)throw new Error();
        mapRepository(c,{localKey:clone.path,identityFingerprint:clone.repositoryFingerprint});
        preflightHooks(clone.path);
      } catch {throw new Error('Explicit repository reselect required; legacy or unsafe clone cannot be adopted');}
    }
    const result=await send(c,'sync',{});if(!Array.isArray(result.work))return fail();const work=result.work as Work[];polls.set(scope(c),work);
    const selections=work.filter(w=>w.kind==='selection').map(w=>{
      const m=load(c,w.fingerprint?.digest);if(m.key!==w.repository_key)return fail();
      const project=w.desired_tracking?w.project_id:(m.project||w.project_id);
      if(!Number.isSafeInteger(Number(project))||Number(project)<1)return fail();
      m.candidate=String(w.work_id);m.project=Number(project);m.revision=w.revision;m.claim=w.claim_token;save(c,m);
      return {id:w.work_id,workspace_id:m.project,local_key:m.localPath,normalized_remote:m.normalized,repository_fingerprint:m.digest,revision:w.revision,desired_traced:w.desired_tracking};
    });
    const pushes=work.filter(w=>w.kind==='push').map(w=>{const m=load(c,w.fingerprint?.digest);if(m.key!==w.repository_key)return fail();const info=inspectRepo(m.localPath);return {id:w.work_id,local_key:m.localPath,repository_id:Number(w.candidate_id),repository_fingerprint:m.digest,remote_name:'origin',remote_url:info.remoteUrl,ref:w.branch,expected_sha:w.expected_head_sha,occurred_at:w.occurred_at};});
    // Account context is deliberately NOT a project workspace. Do not substitute
    // it for project authority or call upstream workspace reconciliation with it.
    return {jobs:[],workspaceIds:result.workspaceIds,refreshRequests:work.filter(w=>w.kind==='scan').map(w=>({id:w.work_id,workspace_id:result.contextId})),repositorySelections:selections,pushes} as T;
  }
  if(init.method!=='POST')return fail();
  if(url==='/api/agents/workspace') return send(c,'workspace',{workspaceId:input.workspaceId});
  if(url==='/api/agents/repository-candidates'){
    let automatic=false;
    if(!(polls.get(scope(c))||[]).some(w=>w.kind==='scan')) {
      const result=await send(c,'scan',{});if(!Array.isArray(result.work))return fail();
      polls.set(scope(c),[...(polls.get(scope(c))||[]),...result.work]);automatic=true;
    }
    const scan=lease(c,'scan');if(!Array.isArray(input.repositories))return fail();
    const repositories=input.repositories.map((r:any)=>{const m=mapRepository(c,r);return {repository_key:m.key,display_name:m.key.startsWith('local:')?'local-repository':m.key.split('/').pop(),fingerprint:{digest:m.digest}};});
    const result=await send(c,'candidates',{scan_id:scan.work_id,claim_token:scan.claim_token,repositories});
    if(automatic){await send(c,'complete',{kind:'scan',work_id:scan.work_id,claim_token:scan.claim_token,count:repositories.length});polls.set(scope(c),(polls.get(scope(c))||[]).filter(w=>w!==scan));}
    return result;
  }
  const match=url.match(/^\/api\/agents\/(refresh-requests|repository-selections|pushes)\/(\d+)\/(claim|complete)$/);
  if(match){
    const kind=match[1]==='refresh-requests'?'scan':match[1]==='repository-selections'?'selection':'push',w=lease(c,kind,match[2]);
    if(kind==='selection'&&(Number(input.revision)!==w.revision||input.desiredTraced!==w.desired_tracking))return fail();
    // sync already acquired this exact cloud lease, not a simulated claim.
    if(match[3]==='claim')return {claimed:true} as T;
    const pushMapping=kind==='push'?load(c,w.fingerprint?.digest):undefined;
    if(pushMapping&&(pushMapping.key!==w.repository_key||String(pushMapping.candidate)!==String(w.candidate_id)||repositoryFingerprint(pushMapping.localPath)!==pushMapping.digest||normalizeRemote(inspectRepo(pushMapping.localPath).remoteUrl)!==pushMapping.normalized))return fail();
    const common={kind,work_id:w.work_id,claim_token:w.claim_token,...(pushMapping?{candidate_id:pushMapping.candidate,digest:pushMapping.digest,repository_key:pushMapping.key,observed_sha:input.observedSha}: {})};
    const body=kind==='scan'?{...common,count:input.error?0:input.repositoriesFound,...(input.error?{error:'Local Git scan failed'}:{})}:kind==='selection'?{...common,revision:w.revision,tracked:input.error?false:input.traced,...(input.error?{error:'Local Git activation failed'}:{})}:{...common,branch:w.branch,expected_head_sha:w.expected_head_sha,status:input.status==='confirmed'&&input.observedSha===w.expected_head_sha?'verified':'pending'};
    return send(c,'complete',body);
  }
  if(url==='/api/repositories/register'){
    const m=mapRepository(c,input);if(!m.candidate||Number(input.workspaceId)!==m.project)return fail();
    preflightHooks(m.localPath); // Must fail BEFORE registering or marking active.
    const result=await send(c,'register',{candidate_id:m.candidate,digest:m.digest,repository_key:m.key,revision:m.revision,claim_token:m.claim,project_id:m.project});
    return {...result,normalized_remote:m.normalized} as T;
  }
  if(url==='/api/pushes/pending') {
    const m=load(c,input.identityFingerprint),info=inspectRepo(m.localPath);
    if(m.localPath!==input.localKey||Number(m.candidate)!==Number(input.repositoryId)||repositoryFingerprint(m.localPath)!==m.digest||normalizeRemote(info.remoteUrl)!==m.normalized||input.remoteName!=='origin'||input.remoteUrl!==info.remoteUrl)return fail();
    if(!c.clones.some(clone=>clone.path===m.localPath&&clone.repositoryFingerprint===m.digest&&clone.repositoryId===Number(m.candidate)&&clone.workspaceId===m.project))return fail();
    if(typeof input.ref!=='string'||!/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(input.ref)||input.ref.includes('..')||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(input.expectedSha)||!/^[a-f0-9]{64}$/.test(input.eventKey))return fail();
    // Original locked per-device queue survives process exit, outages and crashes.
    // Store no remote URL in it: the approved mapping resolves that at confirmation.
    enqueue(c,{eventKey:input.eventKey,workspaceId:m.project!,repositoryId:Number(m.candidate),localKey:m.localPath,identityFingerprint:m.digest,type:'push',occurredAt:input.occurredAt,data:{pendingPush:true,ref:input.ref,expectedSha:input.expectedSha},attempts:0,nextAttempt:0});
    return {queued:true} as T;
  }
  if(url==='/api/activity'){
    const m=load(c,input.identityFingerprint);if(m.localPath!==input.localKey||Number(m.candidate)!==Number(input.repositoryId)||(input.workspaceId!=null&&Number(input.workspaceId)!==m.project))return fail();
    if(repositoryFingerprint(m.localPath)!==m.digest||normalizeRemote(inspectRepo(m.localPath).remoteUrl)!==m.normalized)return fail();
    const data=input.data||{}, provenance:Record<string,unknown>={};
    if(input.type==='push'&&data.pendingPush===true)return send(c,'push',{candidate_id:m.candidate,digest:m.digest,repository_key:m.key,claim_token:m.claim,branch:data.ref,expected_head_sha:data.expectedSha,event_key:input.eventKey,occurred_at:input.occurredAt});
    for(const [from,to] of [['commitSha','head_sha'],['headSha','head_sha'],['remoteHeadSha','remote_head_sha'],['oldHeadSha','old_head_sha'],['newHeadSha','new_head_sha'],['filesChanged','files_changed'],['insertions','insertions'],['deletions','deletions']])if(data[from]!=null)provenance[to]=data[from];
    const result=await send(c,'activity',{candidate_id:m.candidate,digest:m.digest,repository_key:m.key,claim_token:m.claim,event_key:input.eventKey,kind:input.type,occurred_at:input.occurredAt,history:data.importedFromHistory===true,provenance});

    return result;
  }
  return fail();
}
