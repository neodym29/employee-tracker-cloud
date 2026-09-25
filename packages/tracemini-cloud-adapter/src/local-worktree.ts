/** Reconciliation records that a selected repository changed without claiming who
 * made the change. Signed observer receipts remain the stronger attribution path. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {enqueue, isCurrentBinding, mutateCurrentBinding, type Config} from './config.js';
import {repositoryFingerprint, preflightHooks} from './git.js';
const LIMIT=1000, CADENCE=60_000;
const observerBinding=(c:Config)=>crypto.createHash('sha256').update(c.serverUrl+'\0'+c.agentId+'\0'+c.agentToken).digest('hex');
/** Provision observerConsent only during reviewed enrollment, pinning an observer
 * Ed25519 public key. No auto-discovery, JSON label adoption, or baseline promotion. */
export function importObserverReceipts(c:Config):number {
 if(!isCurrentBinding(c))return 0;
 const consent=(c as any).observerConsent;if(!consent)return 0;
 const reject=():never=>{throw new Error('Observer receipt identity, signature or selected-root consent rejected');};
 if(consent.binding!==observerBinding(c)||consent.uid!==process.getuid?.()||!Number.isSafeInteger(consent.cursor)||consent.cursor<0||!Array.isArray(consent.roots)||consent.roots.length>64)return reject();
 const key=crypto.createPublicKey(consent.publicKey);if(key.asymmetricKeyType!=='ed25519')return reject();
 if(!path.isAbsolute(consent.spool)||fs.realpathSync(consent.spool)!==consent.spool)return reject();
 const dir=fs.lstatSync(consent.spool);if(!dir.isDirectory()||dir.uid!==consent.uid||(dir.mode&0o022))return reject();
 let count=0;
 for(let n=0;n<100;n++) {
  const sequence=consent.cursor+1,file=path.join(consent.spool,String(sequence).padStart(16,'0')+'.json');
  let fd:number;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch(e:any){if(e.code==='ENOENT')break;throw e;}
  let envelope:any;try{const st=fs.fstatSync(fd);if(!st.isFile()||st.uid!==consent.uid||(st.mode&0o022)||st.size>16384)return reject();envelope=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
  if(typeof envelope.payload!=='string'||typeof envelope.signature!=='string')return reject();
  const bytes=Buffer.from(envelope.payload,'base64'),signature=Buffer.from(envelope.signature,'base64');
  if(signature.length!==64||!crypto.verify(null,bytes,key,signature))return reject();
  const r=JSON.parse(bytes.toString('utf8')),e=r.event;
  if(r.version!==1||r.sequence!==sequence||r.binding!==consent.binding||r.uid!==consent.uid)return reject();
  const selected=consent.roots.find((s:any)=>s.path===r.root&&s.projectId===r.projectId&&s.candidateId===r.candidateId&&s.fingerprint===r.fingerprint);
  const clone=c.clones.find(s=>s.path===r.root&&s.workspaceId===r.projectId&&s.repositoryId===r.candidateId&&s.repositoryFingerprint===r.fingerprint);
  if(!selected||!clone||fs.realpathSync(r.root)!==r.root||repositoryFingerprint(r.root)!==r.fingerprint)return reject();
  preflightHooks(r.root);
  if(!c.watchedPaths.some(w=>{const rel=path.relative(fs.realpathSync(w),r.root);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}))return reject();
  if(!e||typeof e.id!=='string'||!e.id||e.id.length>128||!['create','modify','rename','delete','mkdir','rmdir','symlink','link'].includes(e.operation)||!['codex','hermes','claude'].includes(e.agent)||e.outcome!=='success'||e.path_resolved!==true||!e.session_id||![e.root_pid,e.root_start_ticks,e.writer_pid,e.writer_start_ticks].every(v=>Number.isSafeInteger(v)&&v>0)||!Number.isFinite(Date.parse(e.timestamp))||Date.parse(e.timestamp)>Date.now()+300000)return reject();
  const safePath=(p:unknown)=>{if(typeof p!=='string'||!path.isAbsolute(p)||path.normalize(p)!==p)return false;const rel=path.relative(r.root,p);return !!rel&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)&&!ignored.test(rel)&&!/[\x00-\x1f\x7f]/.test(rel);};
  if(!safePath(e.path)||(e.old_path&&!safePath(e.old_path))||(e.operation==='rename'&&!e.old_path))return reject();
  const receipt=crypto.createHash('sha256').update(bytes).digest('hex');
  const eventKey=crypto.createHash('sha256').update(consent.binding+'\0'+r.fingerprint+'\0'+e.id).digest('hex');
  if(!enqueue(c,{eventKey,workspaceId:r.projectId,repositoryId:r.candidateId,localKey:r.root,identityFingerprint:r.fingerprint,type:'file_change',occurredAt:new Date(e.timestamp).toISOString(),data:{observerProof:envelope,observer:{source:'signed-kernel-observer-v1',receipt,operation:e.operation,agent:e.agent,files_changed:1}},attempts:0,nextAttempt:0}))return reject();
  // Queue's atomic rename + fsync MUST finish first. Crash here replays the same
  // eventKey; both local queue and cloud root/event_key constraints deduplicate.
  let advanced=false;
  mutateCurrentBinding(c,current=>{const active=(current as any).observerConsent;if(!active||active.binding!==consent.binding||active.publicKey!==consent.publicKey||JSON.stringify(active.roots)!==JSON.stringify(consent.roots)||active.cursor!==sequence-1)return false;active.cursor=sequence;advanced=true;});
  if(!advanced)return reject();consent.cursor=sequence;count++;
 }
 return count;
}
const ignored=/(^|\/)(\.env(?:\..*)?|\.git|node_modules|\.cache|dist|build|coverage|.*(?:secret|credential|private[-_]?key).*|id_rsa|id_ed25519)(\/|$)|\.(?:pem|key|p12|pfx)$/i;
export const localWorktreeCapabilities={reconciliation:'selected-repository-change-metadata',approvedAgentWrites:false,uploadEligible:true,blockingRequirement:'Changes are recorded as unattributed unless a signed observer receipt establishes attribution.'};
export function reconcileLocalWorktrees(config:Config):any[] {
 const results:any[]=[];
 mutateCurrentBinding(config,current=>{
  const c=current as any, prior=c.localWorktrees||{}, next:Record<string,any>={};
  const h=(value:string)=>crypto.createHmac('sha256',current.agentToken||'').update(current.serverUrl+'\0'+current.agentId+'\0'+value).digest('hex');
  const eligible=current.clones.slice(0,64).filter(clone=>clone.repositoryFingerprint&&clone.workspaceId&&current.watchedPaths.some(w=>{try{const p=path.relative(fs.realpathSync(w),fs.realpathSync(clone.path));return p===''||(!p.startsWith('..'+path.sep)&&p!=='..'&&!path.isAbsolute(p));}catch{return false;}}));
  let scanned=false;
  for(const clone of eligible){
   const key=h(clone.path+'\0'+clone.repositoryFingerprint+'\0'+clone.workspaceId+'\0'+clone.repositoryId),old=prior[key];
   if(old)next[key]=old;
   if(scanned||old&&Date.now()-old.checkedAt<CADENCE){if(old)results.push(old);continue;}
   scanned=true;
   try{
    preflightHooks(clone.path);
    if(repositoryFingerprint(clone.path)!==clone.repositoryFingerprint)throw new Error();
    const root=fs.realpathSync(clone.path);
    const git=(args:string[],input?:string)=>execFileSync('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-C',root,...args],{encoding:'utf8',input,timeout:2000,maxBuffer:256*1024,stdio:['pipe','pipe','ignore'],env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
    const records=git(['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=all']).split('\0');
    if(records.length>LIMIT*2+1)throw new Error();
    const rows:{status:string;name:string;oldName?:string}[]=[];
    for(let i=0;i<records.length;i++){
     const record=records[i];if(!record)continue;
     const status=record.slice(0,2),name=record.slice(3),oldName=/[RC]/.test(status)?records[++i]:undefined;
     rows.push({status,name,oldName});
    }
    if(rows.length>LIMIT)throw new Error();
    let excluded=new Set<string>();
    if(rows.length){try{excluded=new Set(git(['check-ignore','--no-index','-z','--stdin'],rows.flatMap(r=>[r.name,...r.oldName?[r.oldName]:[]]).join('\0')+'\0').split('\0'));}catch(e:any){if(e.status!==1)throw e;}}
    const safe=(name:string)=>{
     if(!name||name.length>512||ignored.test(name)||excluded.has(name)||/[\x00-\x1f\x7f]/.test(name)||path.isAbsolute(name)||name.split('/').some(s=>s==='..'||s===''))return false;
     let p=root;
     for(const part of name.split('/')){p=path.join(p,part);try{if(fs.lstatSync(p).isSymbolicLink())return false;}catch(e:any){if(e.code!=='ENOENT')return false;}}
     return true;
    };
    const counts={staged:0,unstaged:0,untracked:0,deleted:0,renamed:0},entries:Record<string,string>={};
    for(const row of rows){
     if(!safe(row.name)||row.oldName&&!safe(row.oldName))continue;
     let metadata='absent';try{const s=fs.lstatSync(path.join(root,row.name));if(!s.isFile())continue;metadata=[s.size,s.mtimeMs,s.ctimeMs,s.ino].join(':');}catch(e:any){if(e.code!=='ENOENT')throw e;}
     const {status}=row;
     if(status==='??')counts.untracked++;else {if(status[0]!==' ')counts.staged++;if(status[1]!==' ')counts.unstaged++;}
     if(status.includes('D'))counts.deleted++;if(status.includes('R'))counts.renamed++;
     entries[h(row.name)]=h(status+'\0'+metadata+'\0'+(row.oldName||''));
    }
    if(repositoryFingerprint(root)!==clone.repositoryFingerprint)throw new Error();
    const signature=h(JSON.stringify(entries));
    const changed=old&&old.signature!==signature;
    const snapshot={classification:!old?'BASELINE':changed?'CHANGE_DETECTED':old.classification,attribution:'unattributed',uploadEligible:true,counts,signature,entries,checkedAt:Date.now()};
    if(changed){
      const previous=old.entries||{};
      for(const pathKey of new Set([...Object.keys(previous),...Object.keys(entries)])){ const value=entries[pathKey]||'deleted'; if(previous[pathKey]!==value){
        enqueue(config,{eventKey:h(`local-change\\0${clone.repositoryFingerprint}\\0${pathKey}\\0${value}`),workspaceId:clone.workspaceId,repositoryId:clone.repositoryId,localKey:root,identityFingerprint:clone.repositoryFingerprint,type:'file_change',occurredAt:new Date().toISOString(),data:{localSource:'local-worktree-reconciliation-v1',attribution:'unattributed',operation:'modify',files_changed:1},attempts:0,nextAttempt:0});
      }}
    }
    next[key]=snapshot;results.push(snapshot);
   }catch{results.push({classification:'BLOCKED',attribution:'unattributed',uploadEligible:false,reason:'identity-hook-boundary-or-scan-limit'});}
  }
  c.localWorktrees=next;
 });
 return results;
}
