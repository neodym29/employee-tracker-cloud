'use client';
// Extracted original RepositorySelection JSX from pristine TraceMini apps/web/src.tsx.
// Thin cloud auth/DTO adapter: account context is not a synthetic project.
import {useEffect,useRef,useState,useId,type ReactNode} from 'react';
import './discovery.css';
import {repositorySelectionState,type RepositoryCandidate} from './repository-selection';
import {repositoryDiscoveryPrompt} from '../../../lib/tracemini-repository-discovery-prompt';
async function request(url:string,init:RequestInit={}){
 const body=init.body?JSON.parse(String(init.body)):{};
 const scanId=url.match(/repository-scans\/(\d+)$/)?.[1];
 const candidateId=url.match(/repository-candidates\/(\d+)$/)?.[1];
 const payload=scanId?{action:'status',scanId}:candidateId?{action:'select',candidateId,...body}:{action:'scan',nodeId:body.agentId};
 const response=await fetch('/api/agents/discovery',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
 if(!response.ok){const failure=await response.json().catch(()=>({}));throw new Error(failure.code==='project_creation_forbidden'?'Only client and engineer accounts can create projects.':body.action==='create'&&response.status===400?'Enter a project name of 1–120 characters and choose an approved client if required.':body.action==='create'&&response.status===409&&failure.code==='conflict'?'This repository already has a creation request with different details. Refresh to see its project; do not create another.':failure.code==='stop_acknowledgement_required'?'Stop tracing and wait for the device to acknowledge cleanup before changing its project.':response.status===409?'State changed or Node is offline. Refresh and retry.':'Discovery request failed. Check your project access and retry.');}
 return response.json();
}
function InfoTip({label, children}: {label: string; children: ReactNode}) {
  const id = useId();
  return <span className="info-tip">
    <button type="button" className="info-tip-trigger" aria-label={`More information: ${label}`} aria-describedby={id} onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>i</button>
    <span className="info-tip-content" id={id} role="tooltip">{children}</span>
  </span>;
}
function BusyIndicator({ label }: { label: string }) {
  return (
    <span className="busy-indicator" role="status">
      <i className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function ProgressTrack({ label }: { label: string }) {
  return (
    <span className="progress-track" role="progressbar" aria-label={label} aria-valuetext={label}>
      <i aria-hidden="true" />
    </span>
  );
}

async function copyText(value:string) {
  if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(value);
  const input=document.createElement('textarea');
  input.value=value;input.style.position='fixed';input.style.opacity='0';document.body.append(input);input.select();
  const copied=document.execCommand('copy');input.remove();
  if(!copied)throw new Error('Copy failed. Select and copy the prompt manually.');
}

export type ProjectCreationOptions = {accountType:'client'|'engineer';clients:{id:string;display_name:string}[]} | null;
export default function RepositorySelection({workspaceId, candidates, agents, userId, reload, projects=[], creation=null, targetProjectId, creationOnly=false, onComplete}: {workspaceId: number; candidates: RepositoryCandidate[]; agents: any[]; userId: number; reload: () => Promise<void>; projects?: {id:string;title:string;status:string}[]; creation?:ProjectCreationOptions; targetProjectId?:string; creationOnly?:boolean; onComplete?:()=>void}) {
  type ScanRequest = {id: number; agent_id?: number; agentId?: number; status: "queued" | "running" | "completed" | "error"; repositories_found?: number | null; error?: string | null};
  const [changing, setChanging] = useState<number>();
  const [linking,setLinking]=useState<number>();
  const [projectId,setProjectId]=useState('');
  const [creating,setCreating]=useState<number>();
  const [title,setTitle]=useState('');
  const [clientId,setClientId]=useState('');
  const [creationError,setCreationError]=useState('');
  const createBusy=useRef(false);
  const createTrigger=useRef<HTMLButtonElement|null>(null);
  const autoStartRef=useRef(new Set<number>());
  const closeCreation=()=>{setCreating(undefined);setCreationError('');createTrigger.current?.focus();};
  const [scanning, setScanning] = useState(false);
  const [scanRequests, setScanRequests] = useState<ScanRequest[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [dismissedCandidates, setDismissedCandidates] = useState<Set<number>>(new Set());
  const [reviewDismissed,setReviewDismissed]=useState(false);
  const [finderCopied,setFinderCopied]=useState(false);
  const mounted = useRef(true);
  const active = () => mounted.current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!userId || typeof window === 'undefined') return;
    try {
      const saved = JSON.parse(window.localStorage.getItem(`employee-trace-dismissed-repositories:${userId}`) || '[]');
      if (Array.isArray(saved)) setDismissedCandidates(new Set(saved.map(value => Number(value)).filter(Number.isSafeInteger)));
    } catch { /* A blocked or malformed local preference should not break discovery. */ }
  }, [userId]);
  const dismissCandidate = (candidateId: number) => {
    setDismissedCandidates(previous => {
      const next = new Set(previous);
      next.add(candidateId);
      try { window.localStorage.setItem(`employee-trace-dismissed-repositories:${userId}`, JSON.stringify([...next])); } catch { /* best effort */ }
      return next;
    });
  };
  const restoreCandidate = (candidateId: number) => {
    setDismissedCandidates(previous => {
      const next = new Set(previous);
      next.delete(candidateId);
      try { window.localStorage.setItem(`employee-trace-dismissed-repositories:${userId}`, JSON.stringify([...next])); } catch { /* best effort */ }
      return next;
    });
    setReviewDismissed(false);
    setSearch('');
  };
  const scanActive = scanRequests.some(scan => scan.status === "queued" || scan.status === "running");
  const hasPending = candidates.some(candidate => candidate.owner_user_id === userId && candidate.desired_traced !== candidate.traced && !candidate.error);
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => void reload(), 10_000);
    return () => clearInterval(timer);
  }, [hasPending, reload]);
  useEffect(() => {
    if (!scanActive) return;
    const poll = async () => {
      try {
        const updated: ScanRequest[] = await Promise.all(scanRequests.map(scan =>
          scan.status === "queued" || scan.status === "running"
            ? request(`/workspaces/${workspaceId}/repository-scans/${scan.id}`)
            : scan,
        ));
        if (!active()) return;
        setScanRequests(updated);
        if (updated.every(scan => scan.status === "completed" || scan.status === "error")) {
          await reload();
          if (!active()) return;
          const failed = updated.filter(scan => scan.status === "error");
          const found = updated.reduce((total, scan) => total + Number(scan.repositories_found || 0), 0);
          if (failed.length) setError(failed.map(scan => scan.error || "A device could not complete its scan.").join(" "));
          else setMessage(`Scan complete on ${updated.length} device${updated.length === 1 ? "" : "s"}. Found ${found} repositor${found === 1 ? "y" : "ies"}.`);
        }
      } catch (caught: any) {
        if (active()) setError(caught.message || "Could not check repository scan progress.");
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5_000);
    return () => clearInterval(timer);
  }, [scanActive, workspaceId, reload, candidates]);
  const ownAgents = agents.filter(agent => Number(agent.user_id) === Number(userId) && agent.status === "online");
  const requestScan = async () => {
    setScanning(true); setError(""); setMessage("");
    try {
      const requested: ScanRequest[] = [];
      for (const agent of ownAgents) requested.push(await request(`/workspaces/${workspaceId}/repository-scans`, {method: "POST", body: JSON.stringify({agentId: agent.id})}));
      if (!active()) return;
      setScanRequests(requested.map(scan => ({...scan, agent_id: scan.agent_id ?? scan.agentId})));
      await reload();
    } catch (caught: any) { if (active()) setError(caught.message); }
    finally { if (active()) setScanning(false); }
  };
  const startTrace = async (candidateId: number, selectedProjectId: string) => {
    const freshResponse = await fetch('/api/agents/discovery',{credentials:'same-origin',cache:'no-store'});
    if (!freshResponse.ok) throw new Error('Linked, but could not refresh the repository revision. Refresh before retrying.');
    const freshState = await freshResponse.json();
    const freshCandidate = freshState.candidates?.find((item: RepositoryCandidate) => String(item.id) === String(candidateId));
    if (!freshCandidate) throw new Error('Linked, but the repository is no longer available. Refresh before retrying.');
    await request(`/workspaces/${workspaceId}/repository-candidates/${candidateId}`, {body:JSON.stringify({traced:true,projectId:selectedProjectId,resumeUploads:true,revision:freshCandidate.revision})});
  };
  const linkAndTrace = async (candidate: RepositoryCandidate, selectedProjectId: string) => {
    await request(`/workspaces/${workspaceId}/repository-candidates/${candidate.id}`, {body:JSON.stringify({action:'link',projectId:selectedProjectId,revision:candidate.revision})});
    await startTrace(candidate.id, selectedProjectId);
  };
  useEffect(() => {
    if (!targetProjectId) return;
    const alreadyLinked = candidates.filter(candidate =>
      candidate.owner_user_id === userId &&
      String(candidate.project_id) === String(targetProjectId) &&
      candidate.selectable &&
      !candidate.traced &&
      !candidate.desired_traced &&
      !candidate.error &&
      !autoStartRef.current.has(candidate.id),
    );
    if (!alreadyLinked.length) return;
    alreadyLinked.forEach(candidate => autoStartRef.current.add(candidate.id));
    void Promise.all(alreadyLinked.map(async candidate => {
      try {
        await request(`/workspaces/${workspaceId}/repository-candidates/${candidate.id}`, {body:JSON.stringify({traced:true,projectId:targetProjectId,resumeUploads:true,revision:candidate.revision})});
      } catch {
        autoStartRef.current.delete(candidate.id);
      }
    })).then(() => reload());
  }, [candidates, reload, targetProjectId, userId, workspaceId]);
  const searchTerm = search.trim().toLowerCase();
  const dismissedAvailable = candidates.filter(candidate => dismissedCandidates.has(candidate.id));
  const visibleCandidates = candidates.filter(candidate => reviewDismissed ? dismissedCandidates.has(candidate.id) : !dismissedCandidates.has(candidate.id));
  const filteredCandidates = visibleCandidates.filter(candidate => !searchTerm || [candidate.name, candidate.machine_name, candidate.branch, candidate.owner_name, candidate.project_id].filter(Boolean).some(value => String(value).toLowerCase().includes(searchTerm))).sort((a, b) => {
    const aRelevant = creationOnly ? (a.project_id ? 2 : a.selectable ? 0 : 1) : targetProjectId && String(a.project_id) === String(targetProjectId) ? 0 : a.selectable ? 1 : 2;
    const bRelevant = creationOnly ? (b.project_id ? 2 : b.selectable ? 0 : 1) : targetProjectId && String(b.project_id) === String(targetProjectId) ? 0 : b.selectable ? 1 : 2;
    return aRelevant - bRelevant || a.name.localeCompare(b.name);
  });
  return <section className="card settings-card repository-selection-card">
    <div className="stacked-heading">{!creationOnly&&<span>Local Git discovery</span>}<h2 className="heading-with-tip">{creationOnly ? 'Choose a scanned repository' : 'Account repositories'} {!creationOnly&&<InfoTip label="Repository discovery">The running Node CLI checks safe readable folders in your home and local mounted drives every 10 minutes. Choose a repository here before Neo Nexus connects or tracks it.</InfoTip>}</h2></div>
    <div className="repository-actions">
      <button type="button" className="button secondary" disabled={scanning || scanActive || ownAgents.length === 0} onClick={()=>void requestScan()}>{scanning ? <BusyIndicator label="Requesting scan…" /> : scanActive ? <BusyIndicator label="Scanning repositories…" /> : "Scan repositories now"}</button>
      <button type="button" className="button secondary" disabled={!reviewDismissed && dismissedAvailable.length === 0} aria-pressed={reviewDismissed} onClick={()=>{setReviewDismissed(current=>!current);setSearch('');}}>{reviewDismissed?'Back to current repositories':`Review dismissed repositories (${dismissedAvailable.length})`}</button>
      {creationOnly&&<button type="button" className="button secondary" onClick={async()=>{setError('');try{await copyText(repositoryDiscoveryPrompt());setFinderCopied(true);}catch(caught){setError(caught instanceof Error?caught.message:'Could not copy the repository finder prompt.');}}}>{finderCopied?'Repository finder copied':'Copy repository finder prompt'}</button>}
    </div>
    {!creationOnly&&<p className="muted">Neo Nexus scans safe readable folders in your home and local mounted drives. Repository metadata appears here; connecting and tracking still require your choice.</p>}
    {ownAgents.length === 0 && <p className="muted">Open or reconnect the Neo Nexus device agent before requesting an immediate scan. Automatic scans resume when it is online.</p>}
    {scanActive && <div className="alert progress action-progress" role="status" aria-live="polite" aria-busy="true">
      <BusyIndicator label={scanRequests.some(scan => scan.status === "running") ? "Scanning safe user folders and local drives…" : "Waiting for your devices to begin scanning…"} />
      <span>Waiting for an authenticated Node poll. Offline devices cannot complete this scan.</span>
      <ProgressTrack label="Repository scan in progress" />
    </div>}
    {message && <div className="alert success" role="status">{message}</div>}
    {error && <div className="alert error" role="alert">{error}</div>}
    {candidates.length ? <>
      <div className="repository-filter" role="search">
        <label htmlFor="repository-search">Find the project folder</label>
        <input id="repository-search" type="search" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search by project or repository name" />
        <small>{reviewDismissed ? `${filteredCandidates.length} of ${visibleCandidates.length} dismissed repositories shown.` : `${filteredCandidates.length} of ${visibleCandidates.length} repositories shown${dismissedAvailable.length ? ` · ${dismissedAvailable.length} dismissed` : ''}.`}</small>
        {reviewDismissed&&visibleCandidates.length>0&&<button type="button" className="button secondary" onClick={()=>{setDismissedCandidates(previous=>{const next=new Set(previous);visibleCandidates.forEach(candidate=>next.delete(candidate.id));try{window.localStorage.setItem(`employee-trace-dismissed-repositories:${userId}`,JSON.stringify([...next]));}catch{}return next;});setReviewDismissed(false);setSearch('');}}>Restore all dismissed repositories</button>}
      </div>
      {filteredCandidates.length ? <div className="repository-choice-list" role="group" tabIndex={filteredCandidates.length >= 10 ? 0 : undefined} aria-label="Discovered workspace repositories">{filteredCandidates.map(candidate => {
      const state = repositorySelectionState(candidate);
      const canSelect = candidate.owner_user_id === userId && (!targetProjectId || String(candidate.project_id)===targetProjectId) && (candidate.selectable || candidate.desired_traced || candidate.traced);
      return <div className={`repository-choice${candidate.project_id ? ' linked-repository' : ''}${reviewDismissed ? ' dismissed-repository' : ''}`} key={candidate.id}>
        <span><strong>{candidate.name}</strong>{!creationOnly&&candidate.branch&&<small>{candidate.branch}</small>}{!creationOnly&&!candidate.selectable && <small>No unique authorized project match</small>}{candidate.error && <small className="error-text">{candidate.error}</small>}</span>
        {(!creationOnly||candidate.project_id||candidate.traced||candidate.desired_traced||candidate.error)&&<span className={`selection-state ${state.tone}`}>
          {candidate.project_id && <small>Project: {projects.find(p=>String(p.id)===String(candidate.project_id))?.title || candidate.project_id}</small>}
          {!reviewDismissed && candidate.owner_user_id===userId && !creationOnly && !candidate.traced && !candidate.desired_traced && <>
            <button type="button" disabled={state.pending||changing!==undefined} onClick={async()=>{setChanging(candidate.id);setError('');try{if(targetProjectId){await linkAndTrace(candidate,targetProjectId);setMessage('Linked and tracking requested. The device will confirm the repository automatically.');}else if(candidate.project_id){await request(`/workspaces/${workspaceId}/repository-candidates/${candidate.id}`,{body:JSON.stringify({traced:true,projectId:candidate.project_id,resumeUploads:true,revision:candidate.revision})});setMessage('Tracking requested. The device will confirm the repository automatically.');}else{setCreating(undefined);setLinking(candidate.id);setProjectId('');return;}await reload();}catch(e:any){setError(e.message);}finally{setChanging(undefined);}}}>{candidate.project_id && !targetProjectId ? 'Start tracking' : 'Link and start tracking'}</button>
            {creation && !candidate.project_id && <button type="button" aria-expanded={creating===candidate.id} aria-controls={`create-project-${candidate.id}`} disabled={state.pending||changing!==undefined} onClick={event=>{createTrigger.current=event.currentTarget;setLinking(undefined);setCreating(candidate.id);setTitle(candidate.name);setClientId('');setCreationError('');setMessage('');}}>Create new project</button>}
            {linking===candidate.id && !candidate.project_id && <span>
              <select disabled={!!targetProjectId} aria-label={`Existing project for ${candidate.name}`} value={projectId} onChange={e=>setProjectId(e.target.value)}><option value="">Choose authorized project</option>{projects.map(p=><option key={p.id} value={p.id}>{p.title} ({p.status})</option>)}</select>
              {!projects.length&&<small>No authorized projects. Ask the project owner for active membership.</small>}
              <button type="button" disabled={!projectId||changing===candidate.id} onClick={async()=>{setChanging(candidate.id);setError('');try{await linkAndTrace(candidate,projectId);setLinking(undefined);setMessage('Linked and tracking requested. The device will confirm the repository automatically.');await reload();}catch(e:any){setError(e.message);}finally{setChanging(undefined);}}}>Link and start tracking</button>
              <button type="button" onClick={()=>setLinking(undefined)}>Cancel</button>
            </span>}
          </>}
          {changing === candidate.id
            ? <><BusyIndicator label="Saving selection…" /><ProgressTrack label={`Saving ${candidate.name} selection`} /></>
            : state.pending
              ? <><BusyIndicator label={state.label} />{state.detail && <small>{state.detail}</small>}<ProgressTrack label={`${state.label} ${candidate.name}`} /></>
              : candidate.traced || candidate.error ? <>{state.label}{state.detail && <small>{state.detail}</small>}</> : candidate.project_id ? <small className="repository-linked-state">Linked to project · tracing not started</small> : canSelect ? "Not selected" : "Not selected by member"}
        </span>}
        {!reviewDismissed && creationOnly && creation && candidate.owner_user_id===userId && !candidate.project_id && !candidate.traced && <button type="button" aria-expanded={creating===candidate.id} aria-controls={`create-project-${candidate.id}`} disabled={state.pending||changing!==undefined} onClick={event=>{createTrigger.current=event.currentTarget;setLinking(undefined);setCreating(candidate.id);setTitle(candidate.name);setClientId('');setCreationError('');setMessage('');}}>Create new project</button>}
        {reviewDismissed ? <button type="button" className="button secondary repository-restore" onClick={()=>restoreCandidate(candidate.id)}>Restore repository</button> : <button type="button" className="repository-dismiss" aria-label={`Dismiss ${candidate.name}`} title="Dismiss repository" onClick={() => dismissCandidate(candidate.id)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>}
        {creationOnly && candidate.project_id && <small className="repository-added-label">Already added to a project</small>}
        {creating===candidate.id && creation && <form className="repository-create-form" id={`create-project-${candidate.id}`} aria-label={`Create project for ${candidate.name}`} aria-busy={changing===candidate.id} onKeyDown={event=>{if(event.key==='Escape'&&!createBusy.current){event.preventDefault();closeCreation();}}} onSubmit={async event=>{
          event.preventDefault();if(createBusy.current)return;
          if(!title.trim()){setCreationError('Enter a project name.');return;}
          createBusy.current=true;setChanging(candidate.id);setCreationError('');
          try{
            const created=await request(`/workspaces/${workspaceId}/repository-candidates/${candidate.id}`,{body:JSON.stringify({action:'create',title,...(creation.accountType==='engineer'?{clientId}:{}),revision:candidate.revision})});
            await startTrace(candidate.id,String(created.projectId));
            if(active()){setCreating(undefined);setMessage('Project created. Neo Nexus is starting and the repository’s full Git history will be imported.');await reload();onComplete?.();}
          }catch(e){if(active())setCreationError(e instanceof Error?e.message:'Could not create project. Retry here.');}
          finally{createBusy.current=false;if(active())setChanging(undefined);}
        }}>
          <label htmlFor={`project-name-${candidate.id}`}>Project name</label>
          <input id={`project-name-${candidate.id}`} name="title" autoFocus required maxLength={120} value={title} disabled={changing===candidate.id} onChange={event=>setTitle(event.target.value)} aria-describedby={`create-note-${candidate.id}`}/>
          {creation.accountType==='engineer' && <><label htmlFor={`project-client-${candidate.id}`}>Client</label><select id={`project-client-${candidate.id}`} required value={clientId} disabled={changing===candidate.id} onChange={event=>setClientId(event.target.value)}><option value="">Choose project client</option>{creation.clients.map(client=><option key={client.id} value={client.id}>{client.display_name || `Client ${client.id}`}</option>)}</select>{!creation.clients.length&&<p>No approved clients in your company. A client account must be approved before creating a project.</p>}</>}
          <p id={`create-note-${candidate.id}`}>Creating this project starts Neo Nexus tracking for this repository and imports its full Git history.</p>
          {creationError&&<p role="alert">{creationError}</p>}
          <div className="repository-create-actions"><button type="submit" disabled={changing===candidate.id||!title.trim()||(creation.accountType==='engineer'&&!clientId)}>{changing===candidate.id?'Creating and starting tracking…':'Create project and start tracking'}</button><button type="button" disabled={changing===candidate.id} onClick={closeCreation}>Cancel</button></div>
        </form>}
      </div>;
    })}</div> : <p className="muted">{reviewDismissed?'No dismissed repository matches that search. Clear the search or return to current repositories.':'No repository matches that search. Clear the search or review dismissed repositories.'}</p>}
    </> : <p className="muted">No repositories found yet. Request a scan while the Neo Nexus device agent is online.</p>}
  </section>;
}
