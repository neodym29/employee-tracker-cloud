'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import DesktopCliConnection from './DesktopCliConnection';

type Device = { id: string; device_label: string | null; hostname: string | null; last_seen_at: string | null; revoked_at: string | null };
export type TraceRepositoryCandidate = { id: string; display_name: string; repository_key: string; branch: string | null; match_status: 'matched' | 'unmatched' | 'ambiguous'; matched_project_id: string | null; tracking_state: string; revision: number };
type Scan = { requestId: string; state: string; count?: number; error?: string | null };
type Props = { projectId?: string; selectedCandidateId?: string; onChoose?: (candidate: TraceRepositoryCandidate) => void; disabled?: boolean };

async function call(url: string, options?: RequestInit) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

export default function TraceMiniProjectDiscovery({ projectId, selectedCandidateId, onChoose, disabled = false }: Props = {}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [candidates, setCandidates] = useState<TraceRepositoryCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [scan, setScan] = useState<Scan | null>(null);
  const [fresh, setFresh] = useState(false);
  const pending = useRef(false);

  const load = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([call('/api/files-agent/devices'), call('/api/tracemini/repository-scans')]);
      const active: Device[] = d.devices.filter((device: Device) => !device.revoked_at);
      setDevices(active);
      setDeviceId(current => active.some(device => device.id === current) ? current : active[0]?.id || '');
      setCandidates(c.candidates);
      setFresh(true);
      setError('');
    } catch (failure) {
      setFresh(false);
      setError(failure instanceof Error ? failure.message : 'Discovery is temporarily unavailable.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // Keep connection age, scans and device-confirmed selections current, even after a scan completes.
  useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    const timer = setInterval(async () => {
      if (refreshing || pending.current) return;
      refreshing = true;
      try {
        if (scan && ['queued', 'running'].includes(scan.state)) {
          const result = await call(`/api/tracemini/repository-scans/${scan.requestId}`);
          if (!cancelled) setScan(result.scan);
        }
        if (!cancelled) await load();
      } catch (failure) {
        if (!cancelled) { setFresh(false); setError(failure instanceof Error ? failure.message : 'Status refresh failed.'); }
      } finally { refreshing = false; }
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [load, scan]);

  const selected = devices.find(device => device.id === deviceId);
  const age = selected?.last_seen_at ? Date.now() - Date.parse(selected.last_seen_at) : Infinity;
  const online = fresh && age >= 0 && age < 120000;
  const locked = disabled || busy || !fresh;

  async function detect() {
    if (pending.current || locked || !online) return;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = await call('/api/tracemini/repository-scans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_id: deviceId }) });
      setScan(result.scan);
      setMessage('Scan requested. Keep the CLI running; this is not tracking activation.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Scan failed.'); }
    finally { pending.current = false; setBusy(false); }
  }

  async function select(candidate: TraceRepositoryCandidate, desired: boolean) {
    if (pending.current || locked || !projectId || candidate.match_status !== 'matched' || candidate.matched_project_id !== projectId) return;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    try {
      await call(`/api/tracemini/repository-candidates/${candidate.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ desired_tracking: desired, revision: candidate.revision }) });
      setMessage('Selection saved — waiting for CLI confirmation. Keep the CLI running; refresh if this remains pending.');
      await load();
    } catch (failure) {
      // Refresh revisions after conflicts; do not automatically replay the user's request.
      await load();
      setError(failure instanceof Error ? failure.message : 'Selection failed.');
    } finally { pending.current = false; setBusy(false); }
  }

  return <div className="traceProjectSetup" style={{ minWidth: 0, marginBlock: 16 }} aria-busy={busy || loading}>
    <h3>Connect a repository with Trace</h3>
    <p className="muted">Install once, detect repositories, then choose one for this project. Creating a workspace does not activate tracking.</p>
    <p role="status">{loading ? 'Checking Trace CLI…' : !fresh ? 'CLI status unavailable' : !devices.length ? 'No Trace CLI connected' : online ? 'CLI connected · recently seen' : 'CLI offline · start the installed CLI, then refresh'}</p>
    <div className="rowActions">
      {devices.length > 0 && <label>Device to scan<select value={deviceId} disabled={locked} onChange={event => { setDeviceId(event.target.value); setScan(null); setMessage(''); }}>{devices.map(device => <option key={device.id} value={device.id}>{device.device_label || device.hostname || `Device ${device.id}`}</option>)}</select></label>}
      <button type="button" disabled={locked || !online || Boolean(scan && ['queued', 'running'].includes(scan.state))} onClick={detect}>Detect projects</button>
      <button type="button" className="secondaryButton" disabled={disabled || busy} onClick={() => void load()}>Refresh CLI status</button>
    </div>
    <details><summary>Install or reconnect the Trace CLI</summary><DesktopCliConnection projectId={projectId} /></details>
    {scan && <p role="status">Scan: {scan.state}{scan.count !== undefined ? ` · ${scan.count} repositories found` : ''}{scan.error ? ` · ${scan.error}` : ''}{['queued', 'running'].includes(scan.state) ? ' · Waiting for the selected device. An offline or older CLI may not complete this request.' : ''}</p>}
    {error && <p className="errorBanner" role="alert">{error} Refresh to retry; no activation is assumed.</p>}
    {message && <p role="status">{message}</p>}
    {projectId && <p className="muted">Project created. Detect projects again to match your repository to this new workspace, then request tracking. Unmatched or ambiguous repositories cannot activate here.</p>}
    <p className="muted smallNote">Repositories below are from all your enrolled devices; the API does not identify each candidate’s device. The device selector controls the next scan only.</p>
    {!loading && candidates.length === 0 && <p className="emptyLine">No repositories reported yet. Connect the CLI and detect projects, or enter a Git remote manually.</p>}
    <div style={{ display: 'grid', gap: 12 }}>
      {candidates.map(candidate => {
        const authorized = Boolean(projectId && candidate.match_status === 'matched' && candidate.matched_project_id === projectId);
        const tracking = candidate.tracking_state === 'tracking';
        return <article key={candidate.id} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 12, minWidth: 0, overflowWrap: 'anywhere' }}>
          <strong>{candidate.display_name}</strong>
          <p className="muted">{candidate.repository_key}{candidate.branch ? ` · ${candidate.branch}` : ''}</p>
          <p>{candidate.match_status} · {tracking ? 'Tracking confirmed by server' : candidate.tracking_state === 'pending' ? 'Pending CLI confirmation' : candidate.tracking_state}</p>
          {!projectId && candidate.match_status === 'matched' && candidate.matched_project_id && <p><a className="secondaryButton" href={`/projects/${candidate.matched_project_id}`}>Open existing workspace</a><span className="muted"> This repository already matches a project. Creating another with the same remote may make discovery ambiguous.</span></p>}
          {!projectId && onChoose && <button type="button" className="secondaryButton" disabled={locked || candidate.repository_key.startsWith('local:')} aria-pressed={selectedCandidateId === candidate.id} onClick={() => onChoose(candidate)}>{selectedCandidateId === candidate.id ? 'Repository selected' : 'Use repository'}</button>}
          {!projectId && candidate.repository_key.startsWith('local:') && <p className="muted">This repository has no hosted Git remote. Add a remote locally and scan again, or enter a remote manually.</p>}
          {projectId && <button type="button" disabled={locked || !authorized || candidate.tracking_state === 'pending'} onClick={() => select(candidate, !tracking)}>{tracking ? 'Stop tracking' : 'Track repository'}</button>}
          {projectId && !authorized && <p className="muted">Not uniquely matched to this project. Check the Git remote and workspace access, then scan again. No tracking request sent.</p>}
        </article>;
      })}
    </div>
  </div>;
}
