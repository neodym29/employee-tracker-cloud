'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { renderTraceMiniConfirmation } from '../../../lib/tracemini-confirmation';

type Project = { id: string; title: string; description: string; status: 'draft' | 'open' | 'active' | 'completed' | 'archived'; createdAt: string; updatedAt: string };
type Membership = { id: string; display_name: string; membership_type: 'request' | 'invitation' | 'creator'; membership_status: string };
type AgentMessage = { id: string; role: 'user' | 'assistant'; body: string; created_at: string };
type AgentAction = { id: string; action_type: 'create_file' | 'update_file' | 'rename_file' | 'delete_file' | 'update_project_progress'; status: string; description: string; created_at: string };
type Overview = {
  project: Project;
  stage: { label: string; closed: boolean };
  progress: { percent: number; summary: string; version: number; updatedAt: string };
  clientName: string;
  analytics: { activeEngineerCount: number; confirmedActionCount: number; pendingActionCount: number; totalChatCount: number };
  clientPriorities: Array<{ id: string; summary: string; createdAt: string }>;
  timeline: Array<{ id: string; label: string; createdAt: string }>;
};
type TraceMiniMember = { mapped: boolean; id?: string; label: string };
type TraceMiniData = {
  activityTotal: number;
  recentActivity: Array<{ id: string; type: string; occurredAt: string; repositoryName: string; member: TraceMiniMember; data: Record<string, unknown> }>;
  repositories: Array<{ id: string; name: string; archived: boolean; cloneCount: number; createdAt: string }>;
  devices: Array<{ member: TraceMiniMember; status: string; lastSeen: string }>;
  memberActivity: Array<{ member: TraceMiniMember; count: number }>;
  reports: Array<{ id: string; title: string; status: string; createdAt: string; updatedAt: string }>;
};
type TraceMiniView = { state: 'fresh' | 'stale' | 'unavailable' | 'disabled' | 'unconfigured'; stale: boolean; lastSuccessfulSync: string | null; lastError: string | null; data: TraceMiniData | null };
type TraceMiniConfig = { configured: boolean; enabled: boolean; hasCredential: boolean; baseUrl: string | null; workspaceId: string | null; lastSuccessfulSync: string | null; lastError: string | null };

const STARTER_PROMPTS = [
  'Summarize current progress and next steps.',
  'Turn the latest client request into a delivery plan.',
  'Update the project progress report.',
] as const;

async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.code === 'chat_unavailable' ? 'The agent is unavailable.' : data.error || 'Request failed.');
  return data;
}

const jsonOptions = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}


export default function WorkspaceClient({ projectId, accountType, canManageTraceMini }: { projectId: string; accountType: 'admin' | 'client' | 'engineer'; canManageTraceMini: boolean }) {
  const base = `/api/projects/${projectId}`;
  const [overview, setOverview] = useState<Overview | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [agentAvailable, setAgentAvailable] = useState(true);
  const [error, setError] = useState('');
  const [chatError, setChatError] = useState('');
  const [busy, setBusy] = useState('');
  const [agentCommand, setAgentCommand] = useState('');
  const [traceView, setTraceView] = useState<TraceMiniView | null>(null);
  const [traceConfig, setTraceConfig] = useState<TraceMiniConfig | null>(null);
  const [traceBaseUrl, setTraceBaseUrl] = useState('');
  const [traceWorkspaceId, setTraceWorkspaceId] = useState('');
  const [traceCredential, setTraceCredential] = useState('');
  const [traceBusy, setTraceBusy] = useState('');
  const [traceMessage, setTraceMessage] = useState('');
  const submissionPendingRef = useRef(false);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);

  const loadOverview = useCallback(async () => {
    const data = await api(`${base}/overview`);
    setOverview(data.overview);
  }, [base]);

  const loadWorkspace = useCallback(async () => {
    setError('');
    try {
      const requests: Promise<unknown>[] = [api(`${base}/overview`)];
      if (accountType !== 'admin') requests.push(api(`${base}/chat`));
      if (accountType === 'client') requests.push(api(`${base}/requests`));
      const responses = await Promise.all(requests) as any[];
      setOverview(responses[0].overview);
      if (accountType !== 'admin') {
        const agentData = responses[1];
        setMessages(agentData.messages);
        setActions(agentData.actions);
        setAgentAvailable(agentData.available !== false);
        if (accountType === 'client' && responses[2]) setMemberships(responses[2].memberships);
      } else setAgentAvailable(false);
    } catch {
      setError('This workspace is unavailable or you no longer have access.');
    }
  }, [accountType, base]);

  const loadTraceMini = useCallback(async () => {
    try {
      const result = await api(`${base}/tracemini/data`);
      setTraceView(result.tracemini);
    } catch { setTraceView({ state: 'unavailable', stale: false, lastSuccessfulSync: null, lastError: 'TraceMini data is unavailable.', data: null }); }
    if (canManageTraceMini) {
      try {
        const result = await api(`${base}/tracemini`);
        setTraceConfig(result.config);
        setTraceBaseUrl(result.config.baseUrl || '');
        setTraceWorkspaceId(result.config.workspaceId || '');
      } catch { setTraceConfig(null); }
    }
  }, [base, canManageTraceMini]);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  useEffect(() => { void loadTraceMini(); }, [loadTraceMini]);
  useEffect(() => { conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, actions]);

  async function run(key: string, work: () => Promise<unknown>, fallback: string) {
    setBusy(key);
    setError('');
    try { await work(); await loadWorkspace(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : fallback); }
    finally { setBusy(''); }
  }

  async function updateTraceMini(kind: string, request: () => Promise<unknown>) {
    setTraceBusy(kind);
    setTraceMessage('');
    try { await request(); setTraceCredential(''); setTraceMessage(kind === 'test' ? 'Connection verified.' : 'TraceMini settings updated.'); await loadTraceMini(); }
    catch (failure) { setTraceMessage(failure instanceof Error ? failure.message : 'TraceMini request failed.'); }
    finally { setTraceBusy(''); }
  }

  async function saveTraceMini(event: React.FormEvent) {
    event.preventDefault();
    const body: Record<string, unknown> = { baseUrl: traceBaseUrl, workspaceId: traceWorkspaceId };
    if (traceCredential) body.credential = traceCredential;
    await updateTraceMini('save', () => api(`${base}/tracemini`, jsonOptions(body, 'PUT')));
  }

  async function decideAction(action: AgentAction, decision: 'confirm' | 'cancel') {
    setBusy(`${decision}:${action.id}`);
    setError('');
    try {
      await api(`${base}/agent-actions/${action.id}/${decision}`, { method: 'POST' });
      await loadWorkspace();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The change could not be completed.');
    } finally { setBusy(''); }
  }

  async function sendCommand(event: React.FormEvent) {
    event.preventDefault();
    if (submissionPendingRef.current) return;
    const submittedDraft = agentCommand;
    const text = submittedDraft.trim();
    if (!text) return;
    const pendingId = `pending-${crypto.randomUUID()}`;
    const pendingMessage: AgentMessage = { id: pendingId, role: 'user', body: text, created_at: new Date().toISOString() };
    submissionPendingRef.current = true;
    setBusy('agent');
    setChatError('');
    setMessages((current) => [...current, pendingMessage]);
    setAgentCommand((current) => current === submittedDraft ? '' : current);
    try {
      const data = await api(`${base}/chat`, jsonOptions({ message: text }));
      setMessages((current) => [...current.filter((message) => message.id !== pendingId), data.userMessage, data.assistantMessage]);
      const returnedActions: AgentAction[] = data.actions || [];
      setActions((current) => [...current, ...returnedActions.filter((action) => action.status === 'pending')]);
      await loadOverview().catch(() => undefined);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'The agent is unavailable.';
      setMessages((current) => current.filter((message) => message.id !== pendingId));
      setAgentCommand((current) => current ? current : submittedDraft);
      setChatError(`${message} Your message was restored. Send again.`);
    } finally {
      submissionPendingRef.current = false;
      setBusy('');
    }
  }

  if (!overview) return <section className="card"><p className="muted">{error ? 'Workspace could not be loaded.' : 'Loading workspace...'}</p>{error && <><p className="errorBanner" role="alert">{error}</p><button type="button" onClick={() => void loadWorkspace()}>Retry</button></>}</section>;
  const { project, analytics } = overview;
  const actionTotal = analytics.confirmedActionCount + analytics.pendingActionCount;
  const actionPercent = actionTotal ? Math.round((analytics.confirmedActionCount / actionTotal) * 100) : 0;
  const latestPriority = overview.clientPriorities[0];

  return <div className="workspaceShell agentWorkspace">
    <a className="backLink" href="/projects">← Back to projects</a>
    {error && <p className="errorBanner" role="alert">{error}</p>}

    <div className="workspaceGrid agentGrid">
      <section className="overviewPanel" aria-labelledby="project-overview-title">
        <header className="projectContext dashboardPanel">
          <div className="projectContextCopy">
            <span className="sectionLabel">Project overview</span>
            <h1 id="project-overview-title">{project.title}</h1>
            {project.description && <p>{project.description}</p>}
            {latestPriority && <blockquote><span>Latest client priority</span>{latestPriority.summary}</blockquote>}
          </div>
          <div className="projectContextMeta">
            <span className="statusBadge">{overview.stage.label}</span>
            <span>Client: {overview.clientName}</span>
            <time dateTime={project.updatedAt}>Updated {formatTimestamp(project.updatedAt)}</time>
            {accountType === 'client' && <select aria-label="Project status" value={project.status} disabled={busy === 'status'} onChange={(event) => run('status', () => api(base, jsonOptions({ title: project.title, description: project.description, status: event.target.value }, 'PATCH')), 'Status could not be updated.')}>
              <option value="draft">Draft</option><option value="open">Open</option><option value="active">Active</option><option value="completed">Completed</option><option value="archived">Archived</option>
            </select>}
          </div>
        </header>

        {accountType === 'client' && memberships.some((member) => member.membership_status === 'pending') && <details className="memberRequests dashboardPanel">
          <summary>Pending member requests</summary>
          {memberships.filter((member) => member.membership_status === 'pending').map((member) => <div className="memberRow" key={member.id}>
            <div><strong>{member.display_name}</strong><span>{member.membership_type}</span></div>
            <div className="rowActions"><button onClick={() => run(member.id, () => api(`${base}/memberships/${member.id}`, jsonOptions({ action: 'approve' })), 'Request failed.')}>Approve</button><button className="secondaryButton" onClick={() => run(member.id, () => api(`${base}/memberships/${member.id}`, jsonOptions({ action: 'reject' })), 'Request failed.')}>Reject</button></div>
          </div>)}
        </details>}

        <section className="dashboardPanel progressPanel" aria-labelledby="project-progress-title">
          <div className="overviewSectionHeader"><div><span className="sectionLabel">Delivery progress</span><h2 id="project-progress-title">Project progress</h2></div><strong>{overview.progress.percent}%</strong></div>
          <div className="progressTrack" role="progressbar" aria-label="Project delivery progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={overview.progress.percent}><span style={{ width: `${overview.progress.percent}%` }} /></div>
          <p>{overview.progress.summary}</p>
          {overview.progress.updatedAt && <time dateTime={overview.progress.updatedAt}>Progress updated {formatTimestamp(overview.progress.updatedAt)}</time>}
          <div className="actionProgress">
            <div><strong>Action completion</strong><span>{actionTotal ? `${analytics.confirmedActionCount} of ${actionTotal} confirmed` : 'No agent actions yet'}</span></div>
            <div className="progressTrack compact" role="progressbar" aria-label="Action completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={actionPercent}><span style={{ width: `${actionPercent}%` }} /></div>
          </div>
        </section>

        <section className="analyticsGrid" aria-label="Project analytics">
          <article className="dashboardPanel"><span>Active engineers</span><strong>{analytics.activeEngineerCount}</strong></article>
          <article className="dashboardPanel"><span>Chat messages</span><strong>{analytics.totalChatCount}</strong></article>
          <article className="dashboardPanel"><span>Confirmed actions</span><strong>{analytics.confirmedActionCount}</strong></article>
          <article className="dashboardPanel"><span>Pending actions</span><strong>{analytics.pendingActionCount}</strong></article>
        </section>

        <div className="overviewLists">
          <section className="dashboardPanel overviewList" aria-labelledby="client-priorities-title">
            <div className="overviewSectionHeader"><div><span className="sectionLabel">Work brief</span><h2 id="client-priorities-title">Client priorities</h2></div></div>
            {overview.clientPriorities.length ? <ul>{overview.clientPriorities.map((priority) => <li key={priority.id}><p>{priority.summary}</p><time dateTime={priority.createdAt}>{formatTimestamp(priority.createdAt)}</time></li>)}</ul> : <p className="emptyOverview">No client priorities have been recorded yet.</p>}
          </section>
          <section className="dashboardPanel overviewList" aria-labelledby="recent-activity-title">
            <div className="overviewSectionHeader"><div><span className="sectionLabel">Timeline</span><h2 id="recent-activity-title">Recent activity</h2></div></div>
            {overview.timeline.length ? <ul>{overview.timeline.map((item) => <li key={item.id}><p>{item.label}</p><time dateTime={item.createdAt}>{formatTimestamp(item.createdAt)}</time></li>)}</ul> : <p className="emptyOverview">No recent project activity.</p>}
          </section>
        </div>

        <section className="dashboardPanel traceMiniPanel" aria-labelledby="tracemini-title">
          <div className="overviewSectionHeader traceMiniHeader">
            <div><span className="sectionLabel">Data from TraceMini</span><h2 id="tracemini-title">Git delivery activity</h2></div>
            <span className={`statusBadge ${traceView?.state === 'fresh' ? '' : 'subtle'}`}>{traceView?.state || 'loading'}</span>
          </div>
          {traceView?.lastSuccessfulSync && <p className="traceFreshness">Last successful refresh {formatTimestamp(traceView.lastSuccessfulSync)}{traceView.stale ? ' · showing stale cached data' : ''}</p>}
          {traceView?.lastError && <p className="errorBanner" role="status">{traceView.lastError}</p>}
          {!traceView?.data ? <p className="emptyOverview">{traceView?.state === 'unconfigured' ? 'TraceMini is not configured for this project.' : traceView?.state === 'disabled' ? 'TraceMini is disabled for this project.' : traceView?.state === 'unavailable' ? 'TraceMini data is unavailable. The rest of this project remains available.' : 'Loading TraceMini data...'}</p> : <>
            <section className="analyticsGrid traceMiniStats" aria-label="TraceMini totals">
              <article><span>Activity events</span><strong>{traceView.data.activityTotal}</strong></article>
              <article><span>Repositories</span><strong>{traceView.data.repositories.length}</strong></article>
              <article><span>Connected devices</span><strong>{traceView.data.devices.filter((device) => device.status === 'online' || device.status === 'active').length}</strong></article>
              <article><span>Reports</span><strong>{traceView.data.reports.length}</strong></article>
            </section>
            <div className="traceMiniGrid">
              <section><h3>Recent Git activity</h3>{traceView.data.recentActivity.length ? <ul>{traceView.data.recentActivity.slice(0, 12).map((event) => { const confirmation = renderTraceMiniConfirmation(event.data.confirmation); return <li key={event.id}><strong>{event.type}</strong><span>{event.member.label}{event.repositoryName ? ` · ${event.repositoryName}` : ''}{confirmation ? ` · ${confirmation}` : ''}</span><time dateTime={event.occurredAt}>{formatTimestamp(event.occurredAt)}</time></li>; })}</ul> : <p className="muted">No recent activity.</p>}</section>
              <section><h3>Repository summaries</h3>{traceView.data.repositories.length ? <ul>{traceView.data.repositories.map((repository) => <li key={repository.id}><strong>{repository.name}</strong><span>{repository.archived ? 'Archived' : 'Active'} · {repository.cloneCount} clones</span></li>)}</ul> : <p className="muted">No repositories.</p>}</section>
              <section><h3>Connected-device status</h3>{traceView.data.devices.length ? <ul>{traceView.data.devices.map((device, index) => <li key={`${device.member.id || 'unmapped'}-${index}`}><strong>{device.member.label}</strong><span>{device.status}{device.lastSeen ? ` · ${formatTimestamp(device.lastSeen)}` : ''}</span></li>)}</ul> : <p className="muted">No device status.</p>}</section>
              <section><h3>Member activity</h3>{traceView.data.memberActivity.length ? <ul>{traceView.data.memberActivity.map((member, index) => <li key={`${member.member.id || 'unmapped'}-${index}`}><strong>{member.member.label}</strong><span>{member.count} events</span></li>)}</ul> : <p className="muted">No member activity.</p>}</section>
              <section><h3>Report metadata</h3>{traceView.data.reports.length ? <ul>{traceView.data.reports.map((report) => <li key={report.id}><strong>{report.title}</strong><span>{report.status || 'Available'}{report.updatedAt ? ` · ${formatTimestamp(report.updatedAt)}` : ''}</span></li>)}</ul> : <p className="muted">No reports.</p>}</section>
            </div>
          </>}
        </section>

        {canManageTraceMini && <details className="dashboardPanel traceMiniSettings">
          <summary>TraceMini settings</summary>
          <form onSubmit={saveTraceMini}>
            <p className="muted">Read-only connection. The session token is encrypted and is never returned to the browser.</p>
            <label>Trusted base URL<input type="url" required value={traceBaseUrl} onChange={(event) => setTraceBaseUrl(event.target.value)} placeholder="https://tracemini.example.com" /></label>
            <label>Workspace ID<input required value={traceWorkspaceId} onChange={(event) => setTraceWorkspaceId(event.target.value)} /></label>
            <label>Session token<input type="password" autoComplete="off" required={!traceConfig?.hasCredential} value={traceCredential} onChange={(event) => setTraceCredential(event.target.value)} placeholder={traceConfig?.hasCredential ? 'Leave blank to keep current token' : 'Required'} /></label>
            <div className="rowActions">
              <button disabled={Boolean(traceBusy)}>{traceBusy === 'save' ? 'Saving...' : 'Save settings'}</button>
              {traceConfig?.configured && <><button type="button" className="secondaryButton" disabled={Boolean(traceBusy)} onClick={() => updateTraceMini('test', () => api(`${base}/tracemini`, jsonOptions({ action: 'test' })))}>Test connection</button><button type="button" className="secondaryButton" disabled={Boolean(traceBusy)} onClick={() => updateTraceMini('toggle', () => api(`${base}/tracemini`, jsonOptions({ action: traceConfig.enabled ? 'disable' : 'enable' })))}>{traceConfig.enabled ? 'Disable' : 'Enable'}</button><button type="button" className="secondaryButton" disabled={Boolean(traceBusy)} onClick={() => window.confirm('Remove this TraceMini connection?') && updateTraceMini('remove', () => api(`${base}/tracemini`, { method: 'DELETE' }))}>Remove</button></>}
            </div>
            {traceConfig?.lastSuccessfulSync && <small>Last success: {formatTimestamp(traceConfig.lastSuccessfulSync)}</small>}
            {traceConfig?.lastError && <p className="errorBanner">{traceConfig.lastError}</p>}
            {traceMessage && <p role="status" className={traceMessage.endsWith('updated.') || traceMessage.endsWith('verified.') ? 'good' : 'errorBanner'}>{traceMessage}</p>}
          </form>
        </details>}
      </section>

      <aside className="agentPanel chatRail dashboardPanel" aria-labelledby="project-agent-title">
        <header className="agentHeader">
          <div className="agentMark" aria-hidden="true">✦</div>
          <div><span className="sectionLabel">Project chat</span><h2 id="project-agent-title">Project agent</h2></div>
          <span className={`agentState ${agentAvailable ? 'online' : ''} ${busy === 'agent' ? 'working' : ''}`}>{busy === 'agent' ? 'Working' : agentAvailable ? 'Ready' : 'Offline'}</span>
        </header>
        <p className="agentCapability">Ask for help using authorized structured project data. Changes still require confirmation when applicable.</p>
        {!agentAvailable && <div className="chatUnavailable" role="status"><strong>Agent unavailable</strong><p>The agent is not configured for this workspace.</p></div>}
        {messages.length === 0 && <div className="starterPrompts" aria-label="Starter prompts"><strong>Try asking</strong><div>{STARTER_PROMPTS.map((prompt) => <button type="button" key={prompt} onClick={() => setAgentCommand(prompt)} disabled={!agentAvailable}>{prompt}</button>)}</div></div>}

        <div className="messageList agentConversation" aria-live="polite" aria-label="Conversation">
          <h3 className="srOnly">Conversation</h3>
          {messages.length ? messages.map((message) => <article className={`message ${message.role}`} key={message.id}><span>{message.role === 'assistant' ? 'Project agent' : 'Project member'}</span><p>{message.body}</p><time dateTime={message.created_at}>{formatTimestamp(message.created_at)}</time></article>) : <div className="conversationEmpty"><strong>What should we accomplish?</strong><p>Describe an outcome or ask about the project.</p></div>}
          {busy === 'agent' && <article className="message assistant agentWorking" role="status" aria-label="Project agent is working"><span>Project agent</span><div className="agentWorkingBody"><span className="typingDots" aria-hidden="true"><i /><i /><i /></span><p>Project agent is working...</p></div></article>}
          <div ref={conversationEndRef} aria-hidden="true" />
        </div>

        {actions.length > 0 && <section className="actionList" aria-labelledby="pending-changes-title"><h3 id="pending-changes-title">Pending changes</h3>{actions.map((action) => { const actionBusy = busy === `confirm:${action.id}` || busy === `cancel:${action.id}`; return <article className="proposedAction" key={action.id}><div><span className="changeKind">Agent proposal</span><strong>{action.description}</strong><p>Review this specific project change before it runs.</p></div><div className="rowActions"><button disabled={actionBusy} onClick={() => decideAction(action, 'confirm')}>{busy === `confirm:${action.id}` ? 'Updating...' : 'Confirm'}</button><button disabled={actionBusy} className="secondaryButton" onClick={() => decideAction(action, 'cancel')}>{busy === `cancel:${action.id}` ? 'Canceling...' : 'Cancel'}</button></div></article>; })}</section>}

        <form className="chatForm agentComposer" onSubmit={sendCommand} aria-busy={busy === 'agent'}>
          <label htmlFor="agent-command">Message the project agent</label>
          <textarea id="agent-command" rows={3} value={agentCommand} onChange={(event) => setAgentCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} disabled={!agentAvailable || busy === 'agent'} placeholder="Describe the outcome you want..." />
          <div className="chatSubmit"><span role="status">{busy === 'agent' ? 'Sending...' : 'Enter to send'}</span><button disabled={!agentAvailable || busy === 'agent' || !agentCommand.trim()}>{busy === 'agent' ? 'Sending...' : 'Send'}</button></div>
          {chatError && <p className="errorBanner" role="alert">{chatError}</p>}
        </form>
      </aside>
    </div>
  </div>;
}
