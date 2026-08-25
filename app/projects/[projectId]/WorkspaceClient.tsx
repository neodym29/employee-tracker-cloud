'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type Project = { id: string; title: string; description: string; status: string };
type Membership = { id: string; display_name: string; membership_type: 'request' | 'invitation'; membership_status: string };
type RecordRow = { id: string; record_id: string; version: number; title: string; body: unknown; created_at: string };
type Artifact = { id: string; filename: string; media_type: string; size_bytes: number; sha256: string; storage_key?: string | null };
type ChatMessage = { id: string; role: 'user' | 'assistant'; body: string };
type AgentAction = { id: string; action_type: string; input: Record<string, unknown>; status: string };

async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.code === 'chat_unavailable' ? 'Chat is unavailable.' : data.error || 'Request failed.');
  return data;
}
const jsonOptions = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export default function WorkspaceClient({ projectId, accountType }: { projectId: string; accountType: 'client' | 'engineer' }) {
  const base = `/api/projects/${projectId}`;
  const [project, setProject] = useState<Project | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [chatAvailable, setChatAvailable] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [recordTitle, setRecordTitle] = useState('');
  const [recordBody, setRecordBody] = useState('{}');
  const [editing, setEditing] = useState<RecordRow | null>(null);
  const [artifact, setArtifact] = useState({ filename: '', mediaType: 'application/octet-stream', sizeBytes: '', sha256: '', storageKey: '' });
  const [chatMessage, setChatMessage] = useState('');

  const load = useCallback(async () => {
    try {
      const requests: Promise<unknown>[] = [api(base), api(`${base}/records`), api(`${base}/artifacts`), api(`${base}/chat`)];
      if (accountType === 'client') requests.push(api(`${base}/requests`));
      const [projectData, recordData, artifactData, chatData, memberData] = await Promise.all(requests) as any[];
      setProject(projectData.project); setRecords(recordData.records); setArtifacts(artifactData.artifacts);
      setMessages(chatData.messages); setActions(chatData.actions); setChatAvailable(chatData.available !== false);
      if (memberData) setMemberships(memberData.memberships);
    } catch { setError('This workspace is unavailable or you no longer have access.'); }
  }, [accountType, base]);
  useEffect(() => { void load(); }, [load]);

  const latestRecords = useMemo(() => {
    const seen = new Set<string>();
    return records.filter((record) => { if (seen.has(record.record_id)) return false; seen.add(record.record_id); return true; });
  }, [records]);

  async function run(key: string, work: () => Promise<unknown>, fallback: string) {
    setBusy(key); setError('');
    try { await work(); await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : fallback); }
    setBusy('');
  }
  async function saveRecord(event: React.FormEvent) {
    event.preventDefault();
    let body: unknown; try { body = JSON.parse(recordBody); } catch { setError('Record body must be valid JSON.'); return; }
    const url = editing ? `${base}/records/${editing.record_id}` : `${base}/records`;
    await run('record', () => api(url, jsonOptions({ title: recordTitle, body })), 'Record could not be saved.');
    setRecordTitle(''); setRecordBody('{}'); setEditing(null);
  }
  function editRecord(record: RecordRow) { setEditing(record); setRecordTitle(record.title); setRecordBody(JSON.stringify(record.body, null, 2)); document.getElementById('record-form')?.scrollIntoView({ behavior: 'smooth' }); }
  async function saveArtifact(event: React.FormEvent) {
    event.preventDefault();
    await run('artifact', () => api(`${base}/artifacts`, jsonOptions({ ...artifact, sizeBytes: Number(artifact.sizeBytes), storageKey: artifact.storageKey || null })), 'Artifact metadata could not be saved.');
    setArtifact({ filename: '', mediaType: 'application/octet-stream', sizeBytes: '', sha256: '', storageKey: '' });
  }
  async function sendChat(event: React.FormEvent) {
    event.preventDefault(); if (!chatMessage.trim()) return;
    const text = chatMessage; setBusy('chat'); setError('');
    try {
      const data = await api(`${base}/chat`, jsonOptions({ message: text }));
      setMessages((current) => [...current, data.userMessage, data.assistantMessage]);
      setActions((current) => [...current, ...data.actions]);
      setChatMessage('');
    } catch (failure) { const text = failure instanceof Error ? failure.message : 'Chat is unavailable.'; setError(text); if (/unavailable/i.test(text)) setChatAvailable(false); }
    setBusy('');
  }

  if (!project) return <section className="card"><p className="muted">Loading workspace...</p>{error && <p className="errorBanner">{error}</p>}</section>;
  return <div className="workspaceShell">
    <a className="backLink" href="/projects">← Back to projects</a>
    <header className="workspaceHeader"><div><span className="pill">Project workspace</span><h1>{project.title}</h1><p>{project.description || 'No description yet.'}</p></div><div className="statusControl"><span className="statusBadge">{project.status}</span>{accountType === 'client' && <select aria-label="Project status" value={project.status} onChange={(event) => run('status', () => api(base, jsonOptions({ ...project, status: event.target.value }, 'PATCH')), 'Status could not be updated.')}><option value="draft">Draft</option><option value="open">Open</option><option value="active">Active</option><option value="completed">Completed</option><option value="archived">Archived</option></select>}</div></header>
    {error && <p className="errorBanner" role="alert">{error}</p>}
    {accountType === 'client' && <section className="dashboardPanel memberPanel"><div className="panelHeader"><h2>Members</h2></div>{memberships.length ? memberships.map((member) => <div className="memberRow" key={member.id}><div><strong>{member.display_name}</strong><span>{member.membership_type} · {member.membership_status}</span></div>{member.membership_type === 'request' && member.membership_status === 'pending' && <div className="rowActions"><button onClick={() => run(member.id, () => api(`${base}/memberships/${member.id}`, jsonOptions({ action: 'approve' })), 'Request failed.')}>Approve</button><button className="secondaryButton" onClick={() => run(member.id, () => api(`${base}/memberships/${member.id}`, jsonOptions({ action: 'reject' })), 'Request failed.')}>Reject</button></div>}</div>) : <p className="emptyLine padded">No engineer memberships yet.</p>}</section>}
    <div className="workspaceGrid">
      <div className="workspaceMain">
        <section className="dashboardPanel"><div className="panelHeader"><div><span className="sectionLabel">Shared knowledge</span><h2>Project records</h2></div></div><div className="recordList">{latestRecords.length ? latestRecords.map((record) => <article className="recordRow" key={record.record_id}><div><strong>{record.title}</strong><span>Version {record.version}</span><pre>{JSON.stringify(record.body, null, 2)}</pre></div><button className="secondaryButton" onClick={() => editRecord(record)}>Update record</button></article>) : <p className="emptyLine padded">No project records yet.</p>}</div>
          <form className="panelForm" id="record-form" onSubmit={saveRecord}><h3>{editing ? 'Update record' : 'Create record'}</h3><label>Title<input value={recordTitle} maxLength={160} onChange={(e) => setRecordTitle(e.target.value)} required /></label><label>JSON body<textarea rows={6} value={recordBody} onChange={(e) => setRecordBody(e.target.value)} required /></label><div className="rowActions"><button disabled={busy === 'record'}>{busy === 'record' ? 'Saving...' : editing ? 'Save new version' : 'Create record'}</button>{editing && <button type="button" className="secondaryButton" onClick={() => { setEditing(null); setRecordTitle(''); setRecordBody('{}'); }}>Cancel edit</button>}</div></form>
        </section>
        <section className="dashboardPanel"><div className="panelHeader"><div><span className="sectionLabel">Files by reference only</span><h2>Artifact metadata</h2></div></div><div className="artifactList">{artifacts.length ? artifacts.map((item) => <article className="artifactRow" key={item.id}><div><strong>{item.filename}</strong><span>{item.media_type} · {item.size_bytes} bytes</span></div><code title={item.sha256}>{item.sha256}</code></article>) : <p className="emptyLine padded">No artifacts registered.</p>}</div><form className="panelForm" onSubmit={saveArtifact}><h3>Register artifact</h3><div className="grid"><label>Filename<input value={artifact.filename} onChange={(e) => setArtifact({ ...artifact, filename: e.target.value })} required /></label><label>Media type<input value={artifact.mediaType} onChange={(e) => setArtifact({ ...artifact, mediaType: e.target.value })} required /></label><label>Size in bytes<input type="number" min="0" value={artifact.sizeBytes} onChange={(e) => setArtifact({ ...artifact, sizeBytes: e.target.value })} required /></label><label>Storage key, optional<input value={artifact.storageKey} onChange={(e) => setArtifact({ ...artifact, storageKey: e.target.value })} /></label></div><label>SHA256<input value={artifact.sha256} pattern="[a-fA-F0-9]{64}" maxLength={64} onChange={(e) => setArtifact({ ...artifact, sha256: e.target.value })} required /></label><button disabled={busy === 'artifact'}>{busy === 'artifact' ? 'Registering...' : 'Register metadata'}</button></form></section>
      </div>
      <aside className="chatPanel dashboardPanel"><div className="panelHeader"><div><span className="sectionLabel">Confirm before changing data</span><h2>Project chat</h2></div></div>{!chatAvailable && <div className="chatUnavailable" role="status"><strong>Chat is unavailable</strong><p>Chat has not been configured for this workspace. Records and artifacts still work normally.</p></div>}<div className="messageList" aria-live="polite">{messages.length ? messages.map((message) => <article className={`message ${message.role}`} key={message.id}><span>{message.role === 'assistant' ? 'Trace assistant' : 'You'}</span><p>{message.body}</p></article>) : <p className="emptyLine">No messages yet.</p>}</div>{actions.length > 0 && <div className="actionList"><h3>Proposed actions</h3>{actions.map((action) => <article className="proposedAction" key={action.id}><strong>{action.action_type.replaceAll('_', ' ')}</strong><pre>{JSON.stringify(action.input, null, 2)}</pre><div className="rowActions"><button disabled={busy === action.id} onClick={() => run(action.id, () => api(`${base}/agent-actions/${action.id}/confirm`, { method: 'POST' }), 'Action could not be confirmed.')}>Confirm</button><button disabled={busy === action.id} className="secondaryButton" onClick={() => run(action.id, () => api(`${base}/agent-actions/${action.id}/cancel`, { method: 'POST' }), 'Action could not be cancelled.')}>Cancel</button></div></article>)}</div>}<form className="chatForm" onSubmit={sendChat}><label htmlFor="chat-message">Message</label><textarea id="chat-message" rows={3} maxLength={4000} value={chatMessage} onChange={(e) => setChatMessage(e.target.value)} disabled={!chatAvailable} placeholder="Ask about this project" /><button disabled={!chatAvailable || busy === 'chat'}>{busy === 'chat' ? 'Waiting...' : 'Send message'}</button></form></aside>
    </div>
  </div>;
}
