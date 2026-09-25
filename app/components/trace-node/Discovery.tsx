'use client';
import {useCallback,useEffect,useState} from 'react';
import RepositorySelection, {type ProjectCreationOptions} from './RepositorySelection';
import type {RepositoryCandidate} from './repository-selection';
export default function Discovery({projectId,creationOnly,onComplete}:{projectId?:string;creationOnly?:boolean;onComplete?:()=>void}={}){
 const [data,setData]=useState<{userId:number;agents:{id:number;user_id:number;status:string}[];candidates:RepositoryCandidate[];projects?:{id:string;title:string;status:string}[];creation?:ProjectCreationOptions}>({userId:0,agents:[],candidates:[]});
 const [error,setError]=useState('');
 const reload=useCallback(async()=>{try{
   let response:Response|undefined;
   for(let attempt=0;attempt<2;attempt+=1){
     try{response=await fetch('/api/agents/discovery',{credentials:'same-origin',cache:'no-store'});}catch{response=undefined;}
     if(response?.ok)break;
     if(attempt===0)await new Promise(resolve=>setTimeout(resolve,300));
   }
   if(!response?.ok)throw Error();
   setData(await response.json());setError('');
 }catch{setError('Repository discovery is temporarily unavailable. Retrying automatically.');}},[]);
 useEffect(()=>{void reload();const timer=setInterval(()=>void reload(),10000);return()=>clearInterval(timer);},[reload]);
 return <div className="trace-node-install">{!creationOnly&&<><p role="status">{data.agents.some(a=>a.status==='online')?'Node CLI is polling.':'No live Node CLI poll. Enrollment alone is not a connection.'}</p><button type="button" onClick={()=>void reload()}>Refresh Node status</button></>}{error&&<p role="alert">{error}</p>}<RepositorySelection workspaceId={0} userId={data.userId} agents={data.agents} candidates={data.candidates} projects={data.projects} creation={projectId?null:data.creation} targetProjectId={projectId} creationOnly={creationOnly} reload={reload} onComplete={onComplete}/></div>;
}
