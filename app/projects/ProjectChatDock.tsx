'use client';

import { useEffect, useRef, useState } from 'react';

type DockProject = { id: string; title: string };
type Message = { id: string; role: 'user' | 'assistant'; body: string; created_at: string };
type Action = { id: string; status: string; description: string };
type ClientRequest = { id: string; summary: string; details: string; kind: 'task' | 'issue'; status: 'open' | 'in_progress' | 'resolved'; unread?: boolean; created_at: string; updated_at: string };

async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'The project agent is unavailable.');
  return data;
}

function time(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(date);
}

function ProjectChatWindow({ project, accountType, onClose, onRequestsChanged }: { project: DockProject; accountType: 'client' | 'engineer'; onClose: () => void; onRequestsChanged: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState('');
  const [requests, setRequests] = useState<ClientRequest[]>([]);
  const [requestNotice, setRequestNotice] = useState('');
  const [requestBusy, setRequestBusy] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef(false);

  async function load() {
    try {
      const [data, requestData] = await Promise.all([
        api(`/api/projects/${project.id}/chat`),
        api(`/api/projects/${project.id}/client-requests`),
      ]);
      setMessages(data.messages || []);
      setActions((data.actions || []).filter((action: Action) => action.status === 'pending'));
      setRequests(requestData.requests || []);
      setAvailable(data.available !== false);
      setError('');
      if (accountType === 'engineer' && (requestData.requests || []).some((request: ClientRequest) => request.unread)) {
        await api(`/api/projects/${project.id}/client-requests`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'mark_read' }),
        });
        onRequestsChanged();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'This chat could not be loaded.');
    }
  }

  useEffect(() => { void load(); }, [project.id]);
  useEffect(() => { if (!minimized) endRef.current?.scrollIntoView({ block: 'end' }); }, [messages, minimized]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy || pendingRef.current) return;
    const pending: Message = { id: `pending-${crypto.randomUUID()}`, role: 'user', body: text, created_at: new Date().toISOString() };
    pendingRef.current = true;
    setBusy(true);
    setDraft('');
    setError('');
    setMessages(current => [...current, pending]);
    try {
      const data = await api(`/api/projects/${project.id}/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text }),
      });
      setMessages(current => [...current.filter(message => message.id !== pending.id), data.userMessage, data.assistantMessage]);
      setActions(current => [...current, ...(data.actions || []).filter((action: Action) => action.status === 'pending')]);
      if (data.clientRequest) {
        setRequests(current => [data.clientRequest, ...current.filter(item => item.id !== data.clientRequest.id)]);
        setRequestNotice(`Added as an engineer ${data.clientRequest.kind === 'issue' ? 'issue flag' : 'task'}.`);
        onRequestsChanged();
      }
    } catch (failure) {
      setMessages(current => current.filter(message => message.id !== pending.id));
      setDraft(text);
      setError(failure instanceof Error ? failure.message : 'Message could not be sent.');
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  }

  async function updateRequest(request: ClientRequest, status: ClientRequest['status']) {
    setRequestBusy(request.id);
    setError('');
    try {
      const data = await api(`/api/projects/${project.id}/client-requests/${request.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }),
      });
      setRequests(current => current.map(item => item.id === request.id ? { ...item, ...data.request, unread: false } : item));
      onRequestsChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The client request could not be updated.');
    } finally { setRequestBusy(''); }
  }

  const activeRequests = requests.filter(request => request.status !== 'resolved');

  async function decide(action: Action, decision: 'confirm' | 'cancel') {
    setError('');
    try {
      await api(`/api/projects/${project.id}/agent-actions/${action.id}/${decision}`, { method: 'POST' });
      setActions(current => current.filter(candidate => candidate.id !== action.id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The proposed change could not be updated.');
    }
  }

  return <section className={`projectChatWindow ${minimized ? 'isMinimized' : ''}`} aria-label={`${project.title} project chat`}>
    <header className="projectChatWindowHeader">
      <button type="button" className="projectChatIdentity" onClick={() => setMinimized(value => !value)} aria-expanded={!minimized}>
        <span className="projectChatAvatar" aria-hidden="true">✦</span>
        <span><strong>{project.title}</strong><small>{busy ? 'Thinking…' : available ? 'Project agent' : 'Agent offline'}</small></span>
      </button>
      <div className="projectChatWindowControls">
        <a href={`/projects/${project.id}`} aria-label={`Open ${project.title} workspace`} title="Open workspace">↗</a>
        <button type="button" onClick={() => setMinimized(value => !value)} aria-label={minimized ? `Expand ${project.title} chat` : `Minimize ${project.title} chat`} title={minimized ? 'Expand' : 'Minimize'}>{minimized ? '□' : '—'}</button>
        <button type="button" onClick={onClose} aria-label={`Close ${project.title} chat`} title="Close">×</button>
      </div>
    </header>
    {!minimized && <>
      {activeRequests.length > 0 && <section className="clientRequestTray" aria-label="Client requests">
        <header><strong>Client requests</strong><span>{activeRequests.length} open</span></header>
        {activeRequests.slice(0, 3).map(request => <article key={request.id} className={`clientRequestItem ${request.kind}`}>
          <div><span className="requestKindLabel">{request.kind === 'issue' ? 'Issue flag' : 'Task'}{request.status === 'in_progress' ? ' · In progress' : ''}</span><strong>{request.summary}</strong></div>
          {accountType === 'engineer' && <div className="clientRequestActions">{request.status === 'open' && <button type="button" disabled={requestBusy === request.id} onClick={() => void updateRequest(request, 'in_progress')}>Start</button>}<button type="button" className="secondaryButton" disabled={requestBusy === request.id} onClick={() => void updateRequest(request, 'resolved')}>Resolve</button></div>}
        </article>)}
      </section>}
      {requestNotice && <p className="clientRequestNotice" role="status">✓ {requestNotice}</p>}
      <div className="projectChatMessages" aria-live="polite">
        {!messages.length && !error && <div className="projectChatEmpty"><span aria-hidden="true">✦</span><strong>Ask about {project.title}</strong><p>Use plain language—this chat stays open while you work elsewhere.</p></div>}
        {messages.map(message => <article className={`projectChatMessage ${message.role}`} key={message.id}>
          <p>{message.body}</p><time dateTime={message.created_at}>{time(message.created_at)}</time>
        </article>)}
        {busy && <div className="projectChatTyping" role="status"><i /><i /><i /><span>Project agent is thinking</span></div>}
        <div ref={endRef} />
      </div>
      {actions.length > 0 && <div className="projectChatActions"><strong>Changes to review</strong>{actions.map(action => <article key={action.id}><p>{action.description}</p><div><button type="button" onClick={() => void decide(action, 'confirm')}>Confirm</button><button type="button" className="secondaryButton" onClick={() => void decide(action, 'cancel')}>Cancel</button></div></article>)}</div>}
      {error && <p className="projectChatError" role="alert">{error}</p>}
      <form className="projectChatComposer" onSubmit={send}>
        <textarea aria-label={`Message ${project.title} project agent`} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={accountType === 'client' ? 'Add a task, report an issue, or ask…' : 'Message project agent…'} rows={2} disabled={(accountType !== 'client' && !available) || busy} />
        <button type="submit" aria-label={`Send message to ${project.title}`} disabled={(accountType !== 'client' && !available) || busy || !draft.trim()}>↑</button>
      </form>
    </>}
  </section>;
}

export default function ProjectChatDock({ projects, openIds, accountType, onClose, onRequestsChanged }: { projects: DockProject[]; openIds: string[]; accountType: 'client' | 'engineer'; onClose: (id: string) => void; onRequestsChanged: () => void }) {
  const openProjects = openIds.map(id => projects.find(project => project.id === id)).filter((project): project is DockProject => Boolean(project));
  if (!openProjects.length) return null;
  return <div className="projectChatDock" aria-label="Open project chats">
    {openProjects.map(project => <ProjectChatWindow key={project.id} project={project} accountType={accountType} onClose={() => onClose(project.id)} onRequestsChanged={onRequestsChanged} />)}
  </div>;
}
