import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
export type Clone={path:string;workspaceId?:number;repositoryId:number;normalizedRemote:string;name:string;branch?:string;headSha?:string;remoteHeadSha?:string;historyHeads?:string[];repositoryFingerprint?:string};
export type WatchedRoot={path:string;workspaceId:number};
export type LocalDocument={localId:string;workspaceId:number;displayName:string;format:'pdf'|'pptx';mediaType:string;byteSize:number;sha256?:string;pageOrSlideCount:number;consentedAt:string;metadata:Record<string,unknown>};
export type Config={serverUrl:string;userToken?:string;agentToken?:string;agentId?:number;workspaceId?:number;watchedPaths:string[];watchedRoots?:WatchedRoot[];clones:Clone[];documents?:LocalDocument[];reporter:'codex'|'hermes';pollMs:number};
export type Queued={eventKey:string;workspaceId?:number;repositoryId:number;localKey?:string;identityFingerprint?:string;type:string;occurredAt:string;data:Record<string,unknown>;attempts:number;nextAttempt:number;claimId?:string;claimedAt?:number};
export const stateDir=()=>process.env.TRACEMINI_HOME||path.join(os.homedir(),'.tracemini');
const file=(n:string)=>path.join(stateDir(),n);const defaults=():Config=>({serverUrl:'http://localhost:3000',watchedPaths:[],watchedRoots:[],clones:[],documents:[],reporter:'codex',pollMs:60000});
function readStored():Partial<Config>{try{return JSON.parse(fs.readFileSync(file('config.json'),'utf8'))}catch{return {}}}
function hydrate(stored:Partial<Config>):Config{const watchedPaths=[...new Set([...(stored.watchedPaths||[]),...(stored.watchedRoots||[]).map(root=>root.path)].map(root=>path.resolve(root)))];return {...defaults(),...stored,watchedPaths,watchedRoots:[],clones:(stored.clones||[]).map(clone=>({...clone,workspaceId:clone.workspaceId??stored.workspaceId})),documents:(stored.documents||[]).filter(document=>document&&Number.isInteger(document.workspaceId))}}
function sameBinding(a:Partial<Config>,b:Partial<Config>){return a.serverUrl===b.serverUrl&&a.agentId===b.agentId&&a.agentToken===b.agentToken}
export function isCurrentBinding(c:Config){const current=readStored();return sameBinding(c,current)}
export function loadConfig():Config{fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});return hydrate(readStored())}
const wait=(milliseconds:number)=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,milliseconds);
function withConfigLock<T>(operation:()=>T):T{
  const lock=file('config.lock');
  const recovery=file('config.lock.recovery');
  const deadline=Date.now()+5_000;
  const lockIsStale=()=>{
    try{
      const owner=Number(fs.readFileSync(path.join(lock,'owner'),'utf8'));
      if(Number.isInteger(owner)&&owner>0){try{process.kill(owner,0);return false}catch(signal:any){return signal?.code==='ESRCH'}}
      return Date.now()-fs.statSync(lock).mtimeMs>30_000;
    }catch{try{return Date.now()-fs.statSync(lock).mtimeMs>30_000}catch{return false}}
  };
  let acquired=false;
  while(!acquired){
    try{
      fs.mkdirSync(lock,{mode:0o700});
      fs.writeFileSync(path.join(lock,'owner'),String(process.pid),{mode:0o600});
      acquired=true;
    }catch(error:any){
      if(error?.code!=='EEXIST')throw error;
      if(lockIsStale()){
        let recovering=false;
        try{fs.mkdirSync(recovery,{mode:0o700});recovering=true}catch(recoveryError:any){if(recoveryError?.code!=='EEXIST')throw recoveryError}
        if(recovering){
          try{if(lockIsStale())fs.rmSync(lock,{recursive:true,force:true})}finally{fs.rmdirSync(recovery)}
          continue;
        }
      }
      if(Date.now()>=deadline)throw new Error('timed out waiting for TraceMini config lock');
      wait(10);
    }
  }
  try{return operation()}finally{fs.rmSync(lock,{recursive:true,force:true})}
}
function writeConfig(c:Config){
  const target=file('config.json');
  const temporary=`${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(c,null,2),{mode:0o600});
  fs.renameSync(temporary,target);
}
export function mutateCurrentBinding(c:Config, operation:(current:Config)=>void|false){
  fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});
  return withConfigLock(()=>{
    const stored=readStored();
    if(!sameBinding(c,stored))return false;
    const current=hydrate(stored);
    if(operation(current)===false)return true;
    writeConfig(current);
    Object.assign(c,current);
    return true;
  });
}
export function saveConfig(c:Config, options:{preserveCurrentScalars?:boolean;replaceRepositoryState?:boolean;replaceCollections?:boolean;beforeRepositoryStateReplace?:(current:Config)=>void}={}){
  fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});
  return withConfigLock(()=>{
  // The systemd agent and interactive commands are separate processes. Preserve
  // roots/clones added by `tracemini watch` if an older in-memory agent snapshot
  // is saved at the same time.
  const current=readStored();
  const replaceRepositoryState=options.replaceRepositoryState||options.replaceCollections;
  if(replaceRepositoryState&&options.beforeRepositoryStateReplace){
    options.beforeRepositoryStateReplace(hydrate(current));
  }
  const currentHasBinding=current.workspaceId!==undefined||current.agentId!==undefined||current.agentToken!==undefined;
  const sameWorkspace=!currentHasBinding||sameBinding(c,current);
  const sources=replaceRepositoryState?[c]:options.preserveCurrentScalars&&!sameWorkspace?[current]:options.preserveCurrentScalars?[c,current]:[current,c];
  const cloneKey=(clone:Clone)=>`${clone.workspaceId || ''}\0${clone.path}`;
  const clones=new Map<string,Clone>();
  if(options.preserveCurrentScalars&&sameWorkspace&&!replaceRepositoryState){
    for(const clone of c.clones)clones.set(cloneKey(clone),clone);
    for(const clone of current.clones||[]){
      const key=cloneKey(clone);
      const background=clones.get(key);
      clones.set(key,background?.repositoryId===clone.repositoryId?{...clone,...background}:clone);
    }
  }else for(const source of sources)for(const clone of source.clones||[])clones.set(cloneKey(clone),clone);
  const scalarConfig=options.preserveCurrentScalars?{...defaults(),...current}:c;
  const watchedPaths=[...new Set(sources.flatMap(source=>[...(source.watchedPaths||[]),...(source.watchedRoots||[]).map(root=>root.path)]).map(root=>path.resolve(root)))];
  const documentMap=new Map<string,LocalDocument>();
  const documentSources=replaceRepositoryState?[c.documents||[]]:options.preserveCurrentScalars?[c.documents||[],current.documents||[]]:[current.documents||[],c.documents||[]];
  for(const documents of documentSources)for(const document of documents)documentMap.set(document.localId,document);
  const merged={...scalarConfig,watchedPaths,watchedRoots:[],clones:[...clones.values()],documents:[...documentMap.values()]};
  writeConfig(merged);
  });
}
export function loadQueue():Queued[]{try{
  const config=hydrate(readStored());
  return JSON.parse(fs.readFileSync(file('queue.json'),'utf8')).map((event:Queued)=>{
    if(event.workspaceId!=null)return event;
    const candidates=config.clones.filter(clone=>
      event.localKey===clone.path&&event.repositoryId===clone.repositoryId&&
      (!event.identityFingerprint||event.identityFingerprint===clone.repositoryFingerprint)&&clone.workspaceId!=null
    );
    const workspaceIds=[...new Set(candidates.map(clone=>clone.workspaceId!))];
    return workspaceIds.length===1?{...event,workspaceId:workspaceIds[0]}:event;
  });
}catch{return[]}}
export function saveQueue(q:Queued[], binding?:Config){
  fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});
  return withConfigLock(()=>{
    if(binding&&!sameBinding(binding,readStored()))return false;
    const target=file('queue.json');
    const temporary=`${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(q,null,2),{mode:0o600});
    fs.renameSync(temporary,target);
    return true;
  });
}
export function updateConfig(operation:(current:Config)=>Config|void):Config{
  fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});
  return withConfigLock(()=>{
    const stored=readStored();
    const current=hydrate(stored);
    const updated=operation(current)||current;
    writeConfig(updated);
    return updated;
  });
}
export function mutateQueue<T>(operation:(queue:Queued[])=>T):T{
  fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});
  return withConfigLock(()=>{
    const queue=loadQueue();
    const result=operation(queue);
    const target=file('queue.json');
    const temporary=`${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(queue,null,2),{mode:0o600});
    fs.renameSync(temporary,target);
    return result;
  });
}
export function mutateCurrentQueue<T>(binding:Config,operation:(queue:Queued[])=>T):T|undefined{
  fs.mkdirSync(stateDir(),{recursive:true,mode:0o700});
  return withConfigLock(()=>{
    if(!sameBinding(binding,readStored()))return undefined;
    const queue=loadQueue();
    const result=operation(queue);
    const target=file('queue.json');
    const temporary=`${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(queue,null,2),{mode:0o600});
    fs.renameSync(temporary,target);
    return result;
  });
}
export function enqueue(binding:Config,event:Queued):boolean{
  return mutateCurrentQueue(binding,queue=>{
    const stored=hydrate(readStored());
    if(event.workspaceId==null||!event.localKey||!event.identityFingerprint||!stored.clones.some(clone=>clone.workspaceId===event.workspaceId&&clone.path===event.localKey&&clone.repositoryId===event.repositoryId&&clone.repositoryFingerprint===event.identityFingerprint))return false;
    if(queue.some(current=>current.eventKey===event.eventKey))return true;
    queue.push(event);return true;
  })??false;
}
export const eventKey=(parts:unknown[])=>crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
