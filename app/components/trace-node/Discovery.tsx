'use client';
import {useCallback,useEffect,useState} from 'react';
import RepositorySelection from './RepositorySelection';
import type {RepositoryCandidate} from './repository-selection';
export default function Discovery(){
 const [data,setData]=useState<{userId:number;agents:{id:number;user_id:number;status:string}[];candidates:RepositoryCandidate[];projects?:{id:string;title:string;status:string}[]}>({userId:0,agents:[],candidates:[]});
 const [error,setError]=useState('');
 const reload=useCallback(async()=>{try{const r=await fetch('/api/agents/discovery',{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw Error();setData(await r.json());setError('');}catch{setData({userId:0,agents:[],candidates:[]});setError('Node discovery unavailable. Refresh to retry.');}},[]);
 useEffect(()=>{void reload();const timer=setInterval(()=>void reload(),10000);return()=>clearInterval(timer);},[reload]);
 return <div className="trace-node-install"><p role="status">{data.agents.some(a=>a.status==='online')?'Node CLI is polling.':'No live Node CLI poll. Enrollment alone is not a connection.'}</p><button type="button" onClick={()=>void reload()}>Refresh Node status</button>{error&&<p role="alert">{error}</p>}<RepositorySelection workspaceId={0} userId={data.userId} agents={data.agents} candidates={data.candidates} projects={data.projects} reload={reload}/></div>;
}
