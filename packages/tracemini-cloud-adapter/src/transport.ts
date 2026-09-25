/** Compatibility boundary: selected Git metadata only. Local paths, remotes,
 * diffs, message bodies, author emails and document data stay local. */
import {safeGitWorkText, safeReportText} from '../../../lib/tracemini-work-evidence';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {stateDir, enqueue, loadConfig, isCurrentBinding, mutateCurrentBinding, mutateCurrentQueue, type Config} from './config.js';
import {automaticDiscoveryRoots, normalizeRemote, inspectRepo, repositoryFingerprint, migrateLegacyHooks, preflightHooks} from './git.js';
import {api as authApi} from './auth-transport.js';
type Work={kind:string;work_id:string;claim_token:string;revision?:number;desired_tracking?:boolean;repository_key?:string;fingerprint?:{digest:string};project_id?:string;candidate_id?:string;branch?:string;expected_head_sha?:string;occurred_at?:string};
type Mapping={localPath:string;digest:string;key:string;normalized:string;candidate?:string;project?:number;revision?:number;claim?:string};
const polls=new Map<string,Work[]>();
const reportJobs=new Map<string,{job:any;mapping:Mapping}>();
const hash=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
const fail=():never=>{throw new Error('Cloud Git request failed or identity/lease unavailable; no synchronization acknowledged');};
function scope(c:Config){return hash(c.serverUrl+'\0'+c.agentToken);}
function directory(c:Config){const dir=path.join(stateDir(),'cloud-git',scope(c));fs.mkdirSync(dir,{recursive:true,mode:0o700});return dir;}
function save(c:Config,m:Mapping){const file=path.join(directory(c),m.digest+'.json'),tmp=file+'.'+crypto.randomUUID();fs.writeFileSync(tmp,JSON.stringify(m),{mode:0o600});fs.renameSync(tmp,file);}
function load(c:Config,digest:unknown):Mapping{if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))return fail();try{return JSON.parse(fs.readFileSync(path.join(directory(c),digest+'.json'),'utf8'));}catch{return fail();}}
function discoveryRoots(c:Config){return [...new Set([...(c.watchedPaths||[]),...automaticDiscoveryRoots()])];}
function isInsideDiscoveryRoot(c:Config,localPath:string){return discoveryRoots(c).some(root=>{try{const relative=path.relative(fs.realpathSync(root),localPath);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}catch{return false;}});}
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
  if(!isInsideDiscoveryRoot(c,localPath))return fail();
  if(repositoryFingerprint(localPath)!==input.identityFingerprint)return fail();
  const info=inspectRepo(localPath), opaque=crypto.createHmac('sha256',c.agentToken!).update(localPath+'\0'+input.identityFingerprint).digest('hex');
  const key=safeRepositoryKey(info.remoteUrl,opaque);
  let prior:Partial<Mapping>={};try{prior=load(c,input.identityFingerprint);}catch{}
  if(prior.localPath && (prior.localPath!==localPath||prior.key!==key))prior={};
  const m={...prior,localPath,digest:input.identityFingerprint,key,normalized:normalizeRemote(info.remoteUrl)} as Mapping;save(c,m);return m;
}
// Mapping representation stays path-local for transport checks; clone identity is device-scoped.
function cloneRemote(c:Config,m:Mapping) {
  const info=inspectRepo(fs.realpathSync(m.localPath));
  if(info.path!==m.localPath||repositoryFingerprint(m.localPath)!==m.digest||normalizeRemote(info.remoteUrl)!==m.normalized)return fail();
  if(!info.remoteUrl.startsWith('local:'))return m.normalized;
  if(!Number.isSafeInteger(c.agentId)||Number(c.agentId)<1)return fail();
  return normalizeRemote(`local-device-${c.agentId}:${info.path}`);
}
async function send(c:Config,operation:string,body:unknown){
  try{
    const origin=new URL(c.serverUrl);
    if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname))))return fail();
    if(!/^etn_[A-Za-z0-9_-]{43}$/.test(c.agentToken||''))return fail();
    const r=await fetch(origin.origin+'/api/agents/git/'+operation,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+c.agentToken},body:JSON.stringify(body),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(operation==='report-job' && (body as {action?:unknown})?.action==='generate' ? 210000 : 30000)});
    if(!r.ok){await r.body?.cancel();return fail();}
    if(!r.body)return fail();
    const reader=r.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try {
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
        if(size>512*1024){await reader.cancel();return fail();}chunks.push(value);
      }
    } finally {reader.releaseLock();}
    return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
  }catch{return fail();}
}
function lease(c:Config,kind:string,id?:string){const found=(polls.get(scope(c))||[]).find(w=>w.kind===kind&&(!id||String(w.work_id)===id));if(!found)return fail();return found;}
export async function api<T=any>(config:unknown,url:string,init:RequestInit={},agent=true):Promise<T>{
  const c=config as Config;
  if(['/api/agents/install/exchange','/api/agents/install/abort','/api/agents/status'].includes(url))return authApi<T>(c,url,init,agent);
  if(!agent)return fail();
  const input=typeof init.body==='string'?JSON.parse(init.body):{};
  const projectControl=url==='/api/agents/project-control';
  if(projectControl || (url==='/api/agents/sync'&&(!init.method||init.method==='GET'))){
    if(projectControl && (!/^[a-f0-9]{64}$/.test(input.digest)||!Number.isSafeInteger(input.projectId)||input.projectId<1))return fail();
    const unsafeClones=new Set<string>();
    for(const clone of projectControl?[]:c.clones||[]){
      try {
        const m=load(c,clone.repositoryFingerprint);
        if(!m.candidate||!m.claim||m.localPath!==clone.path||m.project!==clone.workspaceId)throw new Error();
        mapRepository(c,{localKey:clone.path,identityFingerprint:clone.repositoryFingerprint});
        preflightHooks(clone.path);
      } catch {unsafeClones.add(JSON.stringify([clone.path,clone.workspaceId,clone.repositoryId,clone.repositoryFingerprint]));}
    }
    if(unsafeClones.size){
      // One stale/legacy clone must fail closed without preventing unrelated
      // repositories from receiving fresh selections. Remove only the exact
      // local snapshot and its queued events; server authority is untouched and
      // the repository requires an explicit browser reselect before it can be
      // registered again.
      mutateCurrentBinding(c,current=>{
        current.clones=current.clones.filter(clone=>!unsafeClones.has(JSON.stringify([clone.path,clone.workspaceId,clone.repositoryId,clone.repositoryFingerprint])));
      });
      mutateCurrentQueue(c,queue=>{
        const retained=queue.filter(event=>!c.clones.some(clone=>unsafeClones.has(JSON.stringify([clone.path,clone.workspaceId,clone.repositoryId,clone.repositoryFingerprint]))&&event.localKey===clone.path&&event.workspaceId===clone.workspaceId));
        queue.splice(0,queue.length,...retained);
      });
      Object.assign(c,loadConfig());
      console.error(`Neo-Nexus quarantined ${unsafeClones.size} unsafe legacy registration${unsafeClones.size===1?'':'s'}; explicit repository reselect required`);
    }
    const result=await send(c,'sync',{});if(!Array.isArray(result.work))return fail();const work=(result.work as Work[]).filter(w=>!projectControl || (w.kind==='selection' && w.fingerprint?.digest===input.digest && Number(w.project_id)===input.projectId));polls.set(scope(c),work);
    // Repair one missing local registration per poll, never from discovery alone.
    // Current server authority and the original fingerprint/hook preflight are mandatory.
    if(!projectControl && !work.some(w=>w.kind==='selection')) {
      for(const entry of fs.readdirSync(directory(c)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).slice(0,64)) {
        const m=load(c,entry.slice(0,-5));
        if(!m.candidate||!m.claim||!m.project||c.clones.some(clone=>clone.path===m.localPath&&clone.workspaceId===m.project))continue;
        try {
          mapRepository(c,{localKey:m.localPath,identityFingerprint:m.digest});preflightHooks(m.localPath);
          const status=await send(c,'registration-status',{candidate_id:m.candidate,digest:m.digest,repository_key:m.key});
          if(status.registered!==true||String(status.candidate_id)!==m.candidate||status.project_id!==m.project||status.revision!==m.revision||status.claim_token!==m.claim)throw new Error();
          const info=inspectRepo(m.localPath);
          mutateCurrentBinding(c,current=>{
            const currentMapping=load(current,m.digest);
            if(currentMapping.candidate!==m.candidate||currentMapping.project!==m.project||currentMapping.revision!==m.revision||currentMapping.claim!==m.claim)return false;
            preflightHooks(m.localPath);if(repositoryFingerprint(m.localPath)!==m.digest)return false;
            if(!isInsideDiscoveryRoot(current,m.localPath))return false;
            // Patched staged config adds this monotonic identity field before bundling.
            // @ts-expect-error pristine Clone intentionally lacks the qualified patch field
            if(!current.clones.some(clone=>clone.path===m.localPath&&clone.workspaceId===m.project))current.clones.push({path:m.localPath,workspaceId:m.project,repositoryId:Number(m.candidate),normalizedRemote:cloneRemote(current,m),name:path.basename(m.localPath),repositoryFingerprint:m.digest,historyHeads:[],branch:info.branch,registrationRevision:m.revision});
          });
          Object.assign(c,loadConfig());
          break;
        } catch { /* No legacy adoption, lease replay, hook rewriting or pause changes. */ }
      }
    }
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
  // Called only by the agent's independent single-flight report lifecycle, after
  // control reconciliation. No report network request lies on the sync path.
  if(url==='/api/agents/report-poll'&&(!init.method||init.method==='GET')) {
    const jobs:any[]=[];
    for(const clone of c.clones||[]) {
      if(jobs.length)break;
      const m=load(c,clone.repositoryFingerprint);
      try {const result=await send(c,'report-poll',{candidate_id:m.candidate,digest:m.digest,repository_key:m.key});
        if(result.job){jobs.push(result.job);reportJobs.set(scope(c)+':'+result.job.id,{job:result.job,mapping:m});}
      } catch { /* Paused/unavailable reporting must not interrupt Git reconciliation. */ }
    }
    return {jobs} as T;
  }
  const report=url.match(/^\/api\/agents\/jobs\/(\d+)\/(claim|context|generate|complete|fail)$/);
  if(report) {
    const key=scope(c)+':'+report[1], entry=reportJobs.get(key);if(!entry)return fail();
    const m=entry.mapping;
    if(repositoryFingerprint(m.localPath)!==m.digest||normalizeRemote(inspectRepo(m.localPath).remoteUrl)!==m.normalized||!c.clones.some(clone=>clone.path===m.localPath&&clone.workspaceId===m.project&&clone.repositoryFingerprint===m.digest))return fail();
    const result=await send(c,'report-job',{candidate_id:m.candidate,digest:m.digest,repository_key:m.key,id:entry.job.id,lease:entry.job.lease,action:report[2],...(report[2]==='generate'?{prompt:safeReportText(input.prompt)}:{}),...(report[2]==='complete'?{markdown:safeReportText(input.markdown)}:{})});
    if(report[2]==='context')for(const event of result.events||[])event.normalized_remote=m.normalized;
    if(['complete','fail'].includes(report[2]))reportJobs.delete(key);
    return result as T;
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
    const repositories=input.repositories.map((r:any)=>{const m=mapRepository(c,r);return {repository_key:m.key,display_name:path.basename(m.localPath).replace(/[\\/\u0000-\u001f\u007f]/g,'').slice(0,120)||'Repository name unavailable',fingerprint:{digest:m.digest}};});
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
    // This call is reachable only after an authenticated browser selection and
    // a claimed server lease. That explicit repair/start is the authority to
    // replace a byte-for-byte verified legacy TraceMini wrapper.
    migrateLegacyHooks(m.localPath);
    preflightHooks(m.localPath); // Must fail BEFORE registering or marking active.
    const result=await send(c,'register',{candidate_id:m.candidate,digest:m.digest,repository_key:m.key,revision:m.revision,claim_token:m.claim,project_id:m.project});
    return {...result,normalized_remote:cloneRemote(c,m)} as T;
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
    // Original commitDataAt supplies the subject (%s), not a message body.
    if(input.type==='commit' && typeof data.commitSha==='string' && /^([a-f0-9]{40}|[a-f0-9]{64})$/.test(data.commitSha)) {
      const subject=safeGitWorkText(data.message,600), author=safeGitWorkText(data.authorName,120);
      if(subject)provenance.commit_subject=subject;
      if(author)provenance.git_author_name=author;
    }
    if(input.type==='file_change') {
      const o=data.observer;
      if(data.localSource==='local-worktree-reconciliation-v1'&&data.attribution==='unattributed'&&data.files_changed===1&&data.operation==='modify') {
        Object.assign(provenance,{local_source:data.localSource,attribution:data.attribution,operation:data.operation,files_changed:1});
      } else {
      if(!o||o.source!=='signed-kernel-observer-v1'||!/^[a-f0-9]{64}$/.test(o.receipt)||!['codex','hermes','claude'].includes(o.agent)||!['create','modify','rename','delete','mkdir','rmdir','symlink','link'].includes(o.operation)||o.files_changed!==1)return fail();
      if(!isCurrentBinding(c))return fail();
      const consent=(loadConfig() as any).observerConsent,proof=data.observerProof;
      if(!consent||consent.binding!==hash(c.serverUrl+'\0'+c.agentId+'\0'+c.agentToken)||consent.uid!==process.getuid?.()||!proof||typeof proof.payload!=='string'||proof.payload.length>22000||typeof proof.signature!=='string')return fail();
      const bytes=Buffer.from(proof.payload,'base64'),key=crypto.createPublicKey(consent.publicKey);
      if(key.asymmetricKeyType!=='ed25519'||!crypto.verify(null,bytes,key,Buffer.from(proof.signature,'base64'))||hash(bytes.toString('utf8'))!==o.receipt)return fail();
      const receipt=JSON.parse(bytes.toString('utf8'));
      // Queue files are mutable: a valid signature alone must not bypass the
      // importer's selected-path and successful-writer checks on retry.
      const event=receipt.event;
      const ignored=/(^|\/)(\.env(?:\..*)?|\.git|node_modules|\.cache|dist|build|coverage|.*(?:secret|credential|private[-_]?key).*|id_rsa|id_ed25519)(\/|$)|\.(?:pem|key|p12|pfx)$/i;
      const safePath=(value:unknown)=>{if(typeof value!=='string'||!path.isAbsolute(value)||path.normalize(value)!==value)return false;const relative=path.relative(m.localPath,value);return !!relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)&&!ignored.test(relative)&&!/[\x00-\x1f\x7f]/.test(relative);};
      if(!Number.isSafeInteger(receipt.sequence)||receipt.sequence<1||!event||typeof event.id!=='string'||!event.id||event.id.length>128||!event.session_id||![event.root_pid,event.root_start_ticks,event.writer_pid,event.writer_start_ticks].every(v=>Number.isSafeInteger(v)&&v>0)||!safePath(event.path)||(event.old_path&&!safePath(event.old_path))||(event.operation==='rename'&&!event.old_path))return fail();
      if(receipt.version!==1||receipt.binding!==consent.binding||receipt.uid!==consent.uid||receipt.root!==m.localPath||receipt.fingerprint!==m.digest||receipt.projectId!==m.project||receipt.candidateId!==Number(m.candidate)||receipt.event?.agent!==o.agent||receipt.event?.operation!==o.operation||receipt.event?.outcome!=='success'||receipt.event?.path_resolved!==true||new Date(receipt.event.timestamp).toISOString()!==input.occurredAt||hash(consent.binding+'\0'+m.digest+'\0'+receipt.event.id)!==input.eventKey||!consent.roots.some((s:any)=>s.path===m.localPath&&s.fingerprint===m.digest&&s.projectId===m.project&&s.candidateId===Number(m.candidate)))return fail();
      Object.assign(provenance,{observer_source:o.source,observer_receipt:o.receipt,operation:o.operation,agent:o.agent,files_changed:1});
      }
    }
    const result=await send(c,'activity',{candidate_id:m.candidate,digest:m.digest,repository_key:m.key,claim_token:m.claim,event_key:input.eventKey,kind:input.type,occurred_at:input.occurredAt,history:data.importedFromHistory===true,provenance});

    return result;
  }
  return fail();
}
