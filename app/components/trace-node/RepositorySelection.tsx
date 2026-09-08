'use client';
// Extracted original RepositorySelection JSX from pristine TraceMini apps/web/src.tsx.
// Thin cloud auth/DTO adapter: account context is not a synthetic project.
import {useEffect,useRef,useState,useId,type ReactNode} from 'react';
import './discovery.css';
import {repositorySelectionState,type RepositoryCandidate} from './repository-selection';
async function request(url:string,init:RequestInit={}){
 const body=init.body?JSON.parse(String(init.body)):{};
 const scanId=url.match(/repository-scans\/(\d+)$/)?.[1];
 const candidateId=url.match(/repository-candidates\/(\d+)$/)?.[1];
 const payload=scanId?{action:'status',scanId}:candidateId?{action:'select',candidateId,...body}:{action:'scan',nodeId:body.agentId};
 const response=await fetch('/api/agents/discovery',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
 if(!response.ok){const failure=await response.json().catch(()=>({}));throw new Error(failure.code==='local_repository_requires_hosted_remote'?'This repository has no hosted remote. Add a hosted Git remote on your device and rescan before linking.':failure.code==='stop_acknowledgement_required'?'Stop tracing and wait for the device to acknowledge cleanup before changing its project.':response.status===409?'State changed or Node is offline. Refresh and retry.':'Discovery request failed. Check your project access and retry.');}
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

export default function RepositorySelection({workspaceId, candidates, agents, userId, reload, projects=[]}: {workspaceId: number; candidates: RepositoryCandidate[]; agents: any[]; userId: number; reload: () => Promise<void>; projects?: {id:string;title:string;status:string}[]}) {
  type ScanRequest = {id: number; agent_id?: number; agentId?: number; status: "queued" | "running" | "completed" | "error"; repositories_found?: number | null; error?: string | null};
  const [changing, setChanging] = useState<number>();
  const [linking,setLinking]=useState<number>();
  const [projectId,setProjectId]=useState('');
  const [scanning, setScanning] = useState(false);
  const [scanRequests, setScanRequests] = useState<ScanRequest[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const active = () => mounted.current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
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
  return <section className="card settings-card repository-selection-card">
    <div className="stacked-heading"><span>Local Git discovery</span><h2 className="heading-with-tip">Account repositories <InfoTip label="Repository discovery">First run <code>employee-trace watch</code> for an absolute folder on your device. Scanning then finds Git repositories only inside approved folders.</InfoTip></h2></div>
    <p className="muted">Scan only folders you previously approved with <code>employee-trace watch</code>. The device sends bounded metadata; you choose repositories from your own devices and Managers see their safe workspace identity and status.</p>
    <button className="button secondary" disabled={scanning || scanActive || ownAgents.length === 0} onClick={async () => {
      setScanning(true); setError(""); setMessage("");
      try {
        const requested: ScanRequest[] = [];
        for (const agent of ownAgents) requested.push(await request(`/workspaces/${workspaceId}/repository-scans`, {method: "POST", body: JSON.stringify({agentId: agent.id})}));
        if (!active()) return;
        setScanRequests(requested.map(scan => ({...scan, agent_id: scan.agent_id ?? scan.agentId})));
        await reload();
      } catch (caught: any) { if (active()) setError(caught.message); }
      finally { if (active()) setScanning(false); }
    }}>{scanning ? <BusyIndicator label="Requesting scan…" /> : scanActive ? <BusyIndicator label="Scanning repositories…" /> : "Scan repositories on my devices"}</button>
    {ownAgents.length === 0 && <p className="muted">Install or reconnect the TraceMini device agent before scanning.</p>}
    {scanActive && <div className="alert progress action-progress" role="status" aria-live="polite" aria-busy="true">
      <BusyIndicator label={scanRequests.some(scan => scan.status === "running") ? "Scanning approved folders on your devices…" : "Waiting for your devices to begin scanning…"} />
      <span>Waiting for an authenticated Node poll. Offline devices cannot complete this scan.</span>
      <ProgressTrack label="Repository scan in progress" />
    </div>}
    {message && <div className="alert success" role="status">{message}</div>}
    {error && <div className="alert error" role="alert">{error}</div>}
    {candidates.length ? <div className="repository-choice-list" role="group" tabIndex={candidates.length >= 10 ? 0 : undefined} aria-label="Discovered workspace repositories">{candidates.map(candidate => {
      const state = repositorySelectionState(candidate);
      const canSelect = candidate.owner_user_id === userId && (candidate.selectable || candidate.desired_traced || candidate.traced);
      return <div className="repository-choice" key={candidate.id}>
        <span><strong>{candidate.name}</strong><small>{candidate.owner_name ? `${candidate.owner_name} · ` : ""}{candidate.machine_name} · {candidate.branch || "detached"}</small>{candidate.project_id && <a href={`/projects/${candidate.project_id}`}>Open existing project</a>}{!candidate.selectable && <small>No unique authorized project match</small>}{candidate.error && <small className="error-text">{candidate.error}</small>}</span>
        <span className={`selection-state ${state.tone}`}>
          {!candidate.selectable && candidate.owner_user_id===userId && <>
            <button type="button" disabled={state.pending||candidate.traced||candidate.desired_traced||changing===candidate.id} onClick={()=>{setLinking(candidate.id);setProjectId('');}}>Link to existing project</button>
            {linking===candidate.id && <span>
              <select aria-label={`Existing project for ${candidate.name}`} value={projectId} onChange={e=>setProjectId(e.target.value)}><option value="">Choose authorized project</option>{projects.map(p=><option key={p.id} value={p.id}>{p.title} ({p.status})</option>)}</select>
              {!projects.length&&<small>No authorized projects. Ask the project owner for active membership.</small>}
              <button type="button" disabled={!projectId||changing===candidate.id} onClick={async()=>{setChanging(candidate.id);setError('');try{await request(`/workspaces/${workspaceId}/repository-candidates/${candidate.id}`,{body:JSON.stringify({action:'link',projectId,revision:candidate.revision})});setLinking(undefined);await reload();}catch(e:any){setError(e.message);}finally{setChanging(undefined);}}}>Confirm link</button>
              <button type="button" onClick={()=>setLinking(undefined)}>Cancel</button>
            </span>}
          </>}
          {changing === candidate.id
            ? <><BusyIndicator label="Saving selection…" /><ProgressTrack label={`Saving ${candidate.name} selection`} /></>
            : state.pending
              ? <><BusyIndicator label={state.label} />{state.detail && <small>{state.detail}</small>}<ProgressTrack label={`${state.label} ${candidate.name}`} /></>
              : candidate.traced || candidate.error ? state.label : canSelect ? "Not selected" : "Not selected by member"}
        </span>
        <input type="checkbox" role="switch" aria-label={`${canSelect ? "Trace" : "Member repository selection"} for ${candidate.name} on ${candidate.machine_name}`} checked={state.checked} disabled={!canSelect || state.pending || changing === candidate.id} onChange={async event => {
          setChanging(candidate.id); setError("");
          try { await request(`/workspaces/${workspaceId}/repository-candidates/${candidate.id}`, {method: "PATCH", body: JSON.stringify({traced: event.target.checked, revision: candidate.revision})}); if (active()) await reload(); }
          catch (caught: any) { if (active()) setError(caught.message); }
          finally { if (active()) setChanging(undefined); }
        }} />
      </div>;
    })}</div> : <p className="muted">No repositories found yet. Request a scan after configuring an approved folder on your device.</p>}
  </section>;
}
