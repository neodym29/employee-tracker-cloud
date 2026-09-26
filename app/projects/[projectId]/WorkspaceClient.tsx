'use client';
import Discovery from '../../components/trace-node/Discovery';

import { useCallback, useEffect, useRef, useState } from 'react';
import { renderTraceMiniConfirmation } from '../../../lib/tracemini-confirmation';
import DesktopCliConnection from '../../components/DesktopCliConnection';
import EngineerUpdates, { type EngineerUpdatesGroup } from '../../components/EngineerUpdates';

type Project = { id: string; title: string; description: string; status: 'draft' | 'open' | 'active' | 'completed' | 'archived'; gitRemote: string | null; deploymentUrl: string | null; createdAt: string; updatedAt: string };
type Membership = { id: string; display_name: string; membership_type: 'request' | 'invitation' | 'creator'; membership_status: string };
type AgentMessage = { id: string; role: 'user' | 'assistant'; body: string; created_at: string };
type AgentAction = { id: string; action_type: 'create_file' | 'update_file' | 'rename_file' | 'delete_file' | 'update_project_progress'; status: string; description: string; created_at: string };
type ClientRequest = { id: string; summary: string; details: string; kind: 'task' | 'issue'; status: 'open' | 'in_progress' | 'resolved'; unread?: boolean; created_at: string; updated_at: string; last_updated_by?: string | null; last_updated_via?: 'web' | 'codex_plugin' | null };
type Overview = {
  project: Project;
  stage: { label: string; closed: boolean };
  progress: { percent: number | null; summary: string; version: number; updatedAt: string; source: 'unassessed' | 'manual' | 'plugin_daily' };
  assessment: {
    state: 'not_connected' | 'connecting' | 'reading_history' | 'assessing' | 'ready' | 'attention';
    label: string; detail: string; percent: number; repositoryName: string | null;
    repositoryConnected: boolean; historyRead: boolean; contextReady: boolean;
    commitsRead: number; eventsRead: number; deviceOnline: boolean;
    firstCommitAt: string; lastCommitAt: string; lastReceivedAt: string;
  };
  clientName: string;
  analytics: { activeEngineerCount: number; confirmedActionCount: number; pendingActionCount: number; totalChatCount: number };
  clientPriorities: Array<{ id: string; summary: string; createdAt: string }>;
  timeline: Array<{ id: string; label: string; createdAt: string }>;
  recentChanges: Array<{ id: string; summary: string; status: 'in_progress' | 'completed' | 'blocked'; createdAt: string }>;
  historicalChanges: Array<{ id: string; summary: string; createdAt: string; imported: boolean }>;
};
type TraceMiniMember = { mapped: boolean; id?: string; label: string };
type TraceMiniData = {
  matchStatus: 'matched' | 'unmatched' | 'ambiguous' | 'embedded';
  matchedRepository: { id: string; name: string } | null;
  hasLocalClone: boolean;
  localCloneCount: number;
  activityTotal: number;
  recentActivity: Array<{ id: string; upstreamId?: string; evidenceEligible: boolean; type: string; occurredAt: string; repositoryName: string; member: TraceMiniMember; data: Record<string, unknown> }>;
  repositories: Array<{ id: string; name: string; archived: boolean; cloneCount: number; createdAt: string }>;
  devices: Array<{ member: TraceMiniMember; status: string; lastSeen: string }>;
  memberActivity: Array<{ member: TraceMiniMember; count: number }>;
  reports: Array<{ id: string; title: string; status: string; createdAt: string; updatedAt: string }>;
};
type TraceMiniView = { state: 'fresh' | 'stale' | 'unavailable' | 'disabled' | 'unconfigured'; stale: boolean; lastSuccessfulSync: string | null; lastError: string | null; data: TraceMiniData | null };
type TraceMiniConfig = { configured: boolean; enabled: boolean; hasCredential: boolean; approvedRoots?: number; retentionDays?: number; lastSuccessfulSync: string | null; lastError: string | null };

const ENGINEER_STARTER_PROMPTS = [
  'Summarize current progress and next steps.',
  'Update the project progress report.',
] as const;
const CLIENT_STARTER_PROMPTS = [
  'Submit a client task with the requested outcome and acceptance criteria.',
  'Summarize current progress and next steps.',
  'Turn the latest client request into a delivery plan.',
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


export default function WorkspaceClient({ projectId, accountType, canManageTraceMini, canDeleteProject }: { projectId: string; accountType: 'admin' | 'client' | 'engineer'; canManageTraceMini: boolean; canDeleteProject: boolean }) {
  const base = `/api/projects/${projectId}`;
  const [overview, setOverview] = useState<Overview | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [clientRequests, setClientRequests] = useState<ClientRequest[]>([]);
  const [engineerUpdates, setEngineerUpdates] = useState<EngineerUpdatesGroup[]>([]);
  const [requestNotice, setRequestNotice] = useState('');
  const [requestBusy, setRequestBusy] = useState('');
  const [agentAvailable, setAgentAvailable] = useState(true);
  const [error, setError] = useState('');
  const [chatError, setChatError] = useState('');
  const [busy, setBusy] = useState('');
  const [agentCommand, setAgentCommand] = useState('');
  const [traceView, setTraceView] = useState<TraceMiniView | null>(null);
  const [traceConfig, setTraceConfig] = useState<TraceMiniConfig | null>(null);
  const [traceBusy, setTraceBusy] = useState('');
  const [traceMessage, setTraceMessage] = useState('');
  const [gitRemote, setGitRemote] = useState('');
  const [gitAttachBusy, setGitAttachBusy] = useState(false);
  const [deploymentBusy, setDeploymentBusy] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const submissionPendingRef = useRef(false);
  const mountedRef = useRef(true);
  const workspaceRequestRef = useRef(0);
  const traceRequestRef = useRef(0);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);

  const loadOverview = useCallback(async () => {
    const data = await api(`${base}/overview`);
    setOverview(data.overview);
  }, [base]);

  const loadWorkspace = useCallback(async () => {
    const requestId = workspaceRequestRef.current += 1;
    if (mountedRef.current) setError('');
    try {
      const requests: Promise<unknown>[] = [api(`${base}/overview`)];
      if (accountType !== 'admin') requests.push(api(`${base}/chat`), api(`${base}/client-requests`));
      if (accountType === 'client') requests.push(api(`${base}/requests`));
      const responses = await Promise.all(requests) as any[];
      if (!mountedRef.current || requestId !== workspaceRequestRef.current) return;
      setOverview(responses[0].overview);
      if (accountType !== 'admin') {
        const agentData = responses[1];
        setMessages(agentData.messages);
        setActions(agentData.actions);
        setAgentAvailable(agentData.available !== false);
        const requestData = responses[2];
        setClientRequests(requestData?.requests ?? []);
        if (accountType === 'engineer' && (requestData?.requests ?? []).some((request: ClientRequest) => request.unread)) {
          await api(`${base}/client-requests`, jsonOptions({ action: 'mark_read' }));
        }
        if (accountType === 'client' && responses[3]) setMemberships(responses[3].memberships);
      } else setAgentAvailable(false);
    } catch {
      if (mountedRef.current && requestId === workspaceRequestRef.current) setError('This workspace is unavailable or you no longer have access.');
    }
  }, [accountType, base]);

  const loadTraceMini = useCallback(async () => {
    const requestId = traceRequestRef.current += 1;
    let proposalEligible = false;
    try {
      const result = await api(`${base}/tracemini/data`);
      if (!mountedRef.current || requestId !== traceRequestRef.current) return;
      setTraceView(result.tracemini);
      proposalEligible = result.tracemini?.state === 'fresh' && result.tracemini?.data?.matchStatus === 'matched';
    } catch {
      if (mountedRef.current && requestId === traceRequestRef.current) setTraceView({ state: 'unavailable', stale: false, lastSuccessfulSync: null, lastError: 'Repository activity data is unavailable.', data: null });
    }
    if (canManageTraceMini) {
      try {
        const result = await api(`${base}/tracemini`);
        if (mountedRef.current && requestId === traceRequestRef.current) {
          setTraceConfig(result.config);
        }
      } catch {
        if (mountedRef.current && requestId === traceRequestRef.current) setTraceConfig(null);
      }
    }
    if (proposalEligible && mountedRef.current && requestId === traceRequestRef.current) {
      // Proposal creation is an explicit, CSRF-protected mutation. It is best-effort so
      // TraceMini data remains useful if proposal generation is temporarily unavailable.
      try {
        await api(`${base}/tracemini/data`, { method: 'POST' });
        if (mountedRef.current && requestId === traceRequestRef.current) await loadWorkspace();
      } catch { /* A later refresh can retry without hiding read-only data. */ }
    }
  }, [base, canManageTraceMini, loadWorkspace]);

  const loadEngineerUpdates = useCallback(async () => {
    if (accountType !== 'client') return;
    try {
      const result = await api(`/api/engineer-updates?projectId=${encodeURIComponent(projectId)}`);
      if (mountedRef.current) setEngineerUpdates(result.engineerUpdates ?? []);
    } catch {
      if (mountedRef.current) setEngineerUpdates([]);
    }
  }, [accountType, projectId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      workspaceRequestRef.current += 1;
      traceRequestRef.current += 1;
    };
  }, []);
  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  useEffect(() => { void loadTraceMini(); }, [loadTraceMini]);
  useEffect(() => { void loadEngineerUpdates(); }, [loadEngineerUpdates]);
  useEffect(() => {
    if (!overview || !['connecting','reading_history','assessing'].includes(overview.assessment.state)) return;
    const timer = window.setInterval(() => void loadOverview(), 4_000);
    return () => window.clearInterval(timer);
  }, [loadOverview, overview?.assessment.state]);
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
    try { await request(); setTraceMessage(kind === 'test' ? 'Embedded agent boundary verified.' : 'Repository activity settings updated.'); await loadTraceMini(); }
    catch (failure) { setTraceMessage(failure instanceof Error ? failure.message : 'Repository activity request failed.'); }
    finally { setTraceBusy(''); }
  }

  async function saveTraceMini(event: React.FormEvent) {
    event.preventDefault();
    const body: Record<string, unknown> = { enabled: traceConfig?.enabled !== false };
    await updateTraceMini('save', () => api(`${base}/tracemini`, jsonOptions(body, 'PUT')));
  }

  async function attachGitRemote(event: React.FormEvent) {
    event.preventDefault();
    setGitAttachBusy(true);
    setError('');
    try {
      await api(base, jsonOptions({ gitRemote }, 'PATCH'));
      setGitRemote('');
      await Promise.all([loadWorkspace(), loadTraceMini()]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Git remote could not be attached.');
    } finally { setGitAttachBusy(false); }
  }

  async function saveDeploymentUrl(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const deploymentUrl = String(new FormData(form).get('deploymentUrl') ?? '');
    setDeploymentBusy(true);
    setError('');
    try {
      await api(base, jsonOptions({ deploymentUrl }, 'PATCH'));
      await loadOverview();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Deployment link could not be saved.');
    } finally { setDeploymentBusy(false); }
  }

  async function deleteCurrentProject() {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    if (!window.confirm(`Delete “${overview?.project.title || 'this project'}” permanently?`)) return;
    setDeleteBusy(true);
    setError('');
    try {
      await api(base, { method: 'DELETE' });
      window.location.assign('/projects');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Project could not be deleted.');
      setDeleteArmed(false);
      setDeleteBusy(false);
    }
  }

  async function decideAction(action: AgentAction, decision: 'confirm' | 'cancel') {
    setBusy(`${decision}:${action.id}`);
    setError('');
    try {
      await api(`${base}/agent-actions/${action.id}/${decision}`, { method: 'POST' });
      await Promise.all([loadWorkspace(), loadTraceMini()]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The change could not be completed.');
    } finally { setBusy(''); }
  }

  async function updateClientRequest(request: ClientRequest, status: ClientRequest['status']) {
    setRequestBusy(request.id);
    setChatError('');
    try {
      const data = await api(`${base}/client-requests/${request.id}`, jsonOptions({ status }, 'PATCH'));
      setClientRequests((current) => current.map((item) => item.id === request.id ? { ...item, ...data.request, unread: false } : item));
    } catch (failure) {
      setChatError(failure instanceof Error ? failure.message : 'The client request could not be updated.');
    } finally { setRequestBusy(''); }
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
      if (data.clientRequest) {
        setClientRequests((current) => [data.clientRequest, ...current.filter((request) => request.id !== data.clientRequest.id)]);
        setRequestNotice(`Added as an engineer ${data.clientRequest.kind === 'issue' ? 'issue flag' : 'task'}.`);
      }
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
  const activeClientRequests = clientRequests.filter((request) => request.status !== 'resolved');
  const latestPriority = overview.clientPriorities[0];
  const starterPrompts = accountType === 'client' ? CLIENT_STARTER_PROMPTS : ENGINEER_STARTER_PROMPTS;

  return <div className="workspaceShell agentWorkspace chat-only-project">
    <div className="workspaceTopbar">
      <h1 className="workspaceTitle">{project.title}</h1>
      <div className="workspaceDeploymentActions">
        {project.deploymentUrl && <a className="liveDeploymentButton" href={project.deploymentUrl} target="_blank" rel="noreferrer">Open live app <span aria-hidden="true">↗</span></a>}
        {canDeleteProject && <details className="topDeploymentEditor">
          <summary className="secondaryButton">{project.deploymentUrl ? 'Change link' : 'Add live app'}</summary>
          <form onSubmit={saveDeploymentUrl}>
            <label>Production URL<input key={project.deploymentUrl ?? 'empty'} name="deploymentUrl" type="url" inputMode="url" required placeholder="https://your-project.vercel.app" defaultValue={project.deploymentUrl ?? ''} /></label>
            <button disabled={deploymentBusy}>{deploymentBusy ? 'Saving…' : 'Save link'}</button>
          </form>
        </details>}
      </div>
    </div>
    {error && <p className="errorBanner" role="alert">{error}</p>}
    {accountType === 'client' && <EngineerUpdates groups={engineerUpdates} projectScoped />}

    <div className="workspaceGrid agentGrid">
      <section className="overviewPanel" aria-labelledby="project-overview-title">
        <header className="projectContext dashboardPanel">
          <div className="projectContextCopy">
            <span className="sectionLabel">Project overview</span>
            <h1 id="project-overview-title">{project.title}</h1>
            {project.description && <p>{project.description}</p>}
            <p className="muted"><strong>Git remote:</strong> {project.gitRemote || 'Git link missing'}</p>
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

        {canDeleteProject && <section className="dashboardPanel projectDangerZone" aria-labelledby="delete-project-title">
          <div><span className="sectionLabel">Project controls</span><h2 id="delete-project-title">Delete project</h2><p className="muted">Permanent deletion removes this project and its linked workspace data.</p></div>
          <button type="button" className="dangerButton" disabled={deleteBusy} onClick={() => void deleteCurrentProject()}>{deleteBusy ? 'Deleting...' : deleteArmed ? 'Delete project — click again to confirm' : 'Delete project'}</button>
          {deleteArmed && !deleteBusy && <button type="button" className="secondaryButton" onClick={() => setDeleteArmed(false)}>Cancel</button>}
        </section>}

        <details className="dashboardPanel"><summary>Link local repository</summary><p>Choose a repository from your enrolled device for this existing project. Linking does not enable tracing or uploads.</p><Discovery projectId={projectId}/></details>
        {canManageTraceMini && !project.gitRemote && <section className="dashboardPanel" aria-labelledby="attach-git-title">
          <span className="sectionLabel">Legacy project setup</span>
          <h2 id="attach-git-title">Attach Git remote</h2>
          <p className="muted">Attach the exact credential-free clone remote once. It cannot be changed later.</p>
          <form onSubmit={attachGitRemote}>
            <label>Git remote<input required value={gitRemote} onChange={(event) => setGitRemote(event.target.value)} placeholder="https://github.com/owner/repository.git" /></label>
            <button disabled={gitAttachBusy || !gitRemote.trim()}>{gitAttachBusy ? 'Attaching...' : 'Attach Git remote'}</button>
          </form>
        </section>}

        {accountType === 'client' && memberships.some((member) => member.membership_status === 'pending') && <details className="memberRequests dashboardPanel">
          <summary>Pending member requests</summary>
          {memberships.filter((member) => member.membership_status === 'pending').map((member) => <div className="memberRow" key={member.id}>
            <div><strong>{member.display_name}</strong><span>{member.membership_type}</span></div>
            <div className="rowActions"><button onClick={() => run(member.id, () => api(`${base}/memberships/${member.id}`, jsonOptions({ action: 'approve' })), 'Request failed.')}>Approve</button><button className="secondaryButton" onClick={() => run(member.id, () => api(`${base}/memberships/${member.id}`, jsonOptions({ action: 'reject' })), 'Request failed.')}>Reject</button></div>
          </div>)}
        </details>}

        <section className="dashboardPanel progressPanel" aria-labelledby="project-progress-title">
          <div className="overviewSectionHeader"><div><span className="sectionLabel">Delivery progress</span><h2 id="project-progress-title">Project progress</h2></div><strong>{overview.progress.percent == null ? 'Not assessed' : `${overview.progress.percent}%`}</strong></div>
          {overview.progress.percent != null && <div className="progressTrack" role="progressbar" aria-label="Project delivery progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={overview.progress.percent}><span style={{ width: `${overview.progress.percent}%` }} /></div>}
          <p>{overview.progress.summary}</p>
          {overview.progress.source === 'plugin_daily' && <p className="muted">Estimated automatically from verified Codex plugin milestones.</p>}
          <p className="muted">Delivery progress reflects recorded project evidence. Action completion below tracks agent changes separately.</p>
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
                <div><span className="sectionLabel">Neo Nexus repository activity</span><h2 id="tracemini-title">Project activity</h2></div>
            <span className={`statusBadge ${traceView?.state === 'fresh' ? '' : 'subtle'}`}>{traceView?.state || 'loading'}</span>
          </div>
          {traceView?.lastSuccessfulSync && <p className="traceFreshness">Last successful refresh {formatTimestamp(traceView.lastSuccessfulSync)}{traceView.stale ? ' · showing stale cached data' : ''}</p>}
          {traceView?.lastError && <p className="errorBanner" role="status">{traceView.lastError}</p>}
          {!traceView?.data ? <p className="emptyOverview">{traceView?.state === 'unconfigured' ? 'Repository activity is not configured for this project.' : traceView?.state === 'disabled' ? 'Repository activity is paused for this project.' : traceView?.state === 'unavailable' ? 'Repository activity data is unavailable. The rest of this project remains available.' : 'Loading repository activity...'}</p> : <>
            <p><strong>{traceView.data.matchStatus === 'matched' ? 'Matched' : traceView.data.matchStatus === 'ambiguous' ? 'Ambiguous' : 'No match'}</strong>{traceView.data.matchedRepository ? ` · ${traceView.data.matchedRepository.name}` : ''} · {traceView.data.hasLocalClone ? `Local clone available (${traceView.data.localCloneCount})` : 'No local clone reported'}</p>
            <p className="muted">Neo Nexus reports activity from the selected repository. Progress reflects recorded changes; uncommitted work, test execution, deployment, and business outcomes are not inferred from Git history.</p>
            <section className="analyticsGrid traceMiniStats" aria-label="Repository activity totals">
              <article><span>Activity events</span><strong>{traceView.data.activityTotal}</strong></article>
              <article><span>Repositories</span><strong>{traceView.data.repositories.length}</strong></article>
              <article><span>Connected devices</span><strong>{traceView.data.devices.filter((device) => device.status === 'online' || device.status === 'active').length}</strong></article>
              <article><span>Reports</span><strong>{traceView.data.reports.length}</strong></article>
            </section>
            <div className="traceMiniGrid">
                  <section><h3>Recent project activity</h3>{traceView.data.recentActivity.length ? <ul>{traceView.data.recentActivity.slice(0, 12).map((event) => { const confirmation = renderTraceMiniConfirmation(event.data.confirmation); return <li key={event.id}><strong>{event.type}</strong><span>{event.repositoryName || 'Selected repository'}{confirmation ? ` · ${confirmation}` : ''}</span><time dateTime={event.occurredAt}>{formatTimestamp(event.occurredAt)}</time></li>; })}</ul> : <p className="muted">No recent activity.</p>}</section>
              <section><h3>Repository summaries</h3>{traceView.data.repositories.length ? <ul>{traceView.data.repositories.map((repository) => <li key={repository.id}><strong>{repository.name}</strong><span>{repository.archived ? 'Archived' : 'Active'} · {repository.cloneCount} clones</span></li>)}</ul> : <p className="muted">No repositories.</p>}</section>
              <section><h3>Connected-device status</h3>{traceView.data.devices.length ? <ul>{traceView.data.devices.map((device, index) => <li key={`${device.member.id || 'unmapped'}-${index}`}><strong>{device.member.label}</strong><span>{device.status}{device.lastSeen ? ` · ${formatTimestamp(device.lastSeen)}` : ''}</span></li>)}</ul> : <p className="muted">No device status.</p>}</section>
              <section><h3>Report metadata</h3>{traceView.data.reports.length ? <ul>{traceView.data.reports.map((report) => <li key={report.id}><strong>{report.title}</strong><span>{report.status || 'Available'}{report.updatedAt ? ` · ${formatTimestamp(report.updatedAt)}` : ''}</span></li>)}</ul> : <p className="muted">No reports.</p>}</section>
            </div>
          </>}
        </section>

        {accountType !== 'admin' && overview?.project && <DesktopCliConnection projectId={projectId} projectName={overview.project.title} />}

            {canManageTraceMini && <details className="dashboardPanel traceMiniSettings">
          <summary>Repository activity settings</summary>
          <form onSubmit={saveTraceMini}>
            <p className="muted">Neo Nexus uses approved local agents and project roots. No external URL, workspace, or session token is required.</p>
                <p className="muted">Approved roots: {traceConfig?.approvedRoots ?? 0} · Retention: {traceConfig?.retentionDays ?? 90} days</p>
                <p className="muted">Root/device approval · Select · Revoke</p>
                <label>From date<input type="date" aria-label="From date" /></label><label>To date<input type="date" aria-label="To date" /></label>
                <p className="muted">Reports · History · Regenerate · Schedule</p>
            <div className="rowActions">
              <button disabled={Boolean(traceBusy)}>{traceBusy === 'save' ? 'Saving...' : 'Save settings'}</button>
              {traceConfig?.configured && <><button type="button" className="secondaryButton" disabled={Boolean(traceBusy)} onClick={() => updateTraceMini('test', () => api(`${base}/tracemini`, jsonOptions({ action: 'test' })))}>Verify agent boundary</button><button type="button" className="secondaryButton" disabled={Boolean(traceBusy)} onClick={() => updateTraceMini('toggle', () => api(`${base}/tracemini`, jsonOptions({ action: traceConfig.enabled ? 'disable' : 'enable' })))}>{traceConfig.enabled ? 'Pause telemetry' : 'Resume telemetry'}</button></>}
            </div>
            {traceConfig?.lastSuccessfulSync && <small>Last success: {formatTimestamp(traceConfig.lastSuccessfulSync)}</small>}
            {traceConfig?.lastError && <p className="errorBanner">{traceConfig.lastError}</p>}
            {traceMessage && <p role="status" className={traceMessage.endsWith('updated.') || traceMessage.endsWith('verified.') ? 'good' : 'errorBanner'}>{traceMessage}</p>}
          </form>
        </details>}
      </section>

      <aside className="assessmentRail dashboardPanel" aria-labelledby="workspace-recent-changes-title" aria-live="polite">
        <section className="assessmentChanges" aria-labelledby="workspace-recent-changes-title">
          <div><span className="sectionLabel">{overview.recentChanges.length ? 'Codex plugin' : overview.historicalChanges?.length ? 'Repository history' : 'Project activity'}</span><h2 id="workspace-recent-changes-title">Recent changes</h2></div>
          {overview.recentChanges.length ? <ul>{overview.recentChanges.map((change) => <li className={change.status} key={change.id}><p>{change.summary}</p><time dateTime={change.createdAt}>{formatTimestamp(change.createdAt)}</time></li>)}</ul>
            : overview.historicalChanges?.length ? <><ul>{overview.historicalChanges.map(change => <li key={`history:${change.id}`}><p>{change.summary}</p><time dateTime={change.createdAt}>{formatTimestamp(change.createdAt)}{change.imported ? ' · imported history' : ' · repository'}</time></li>)}</ul><p className="assessmentChangesEmpty">Earlier repository work is shown here. No Codex plugin milestone has been posted for this project yet.</p></>
            : <p className="assessmentChangesEmpty">No recorded changes yet.</p>}
        </section>
      </aside>

      <aside className="agentPanel chatRail dashboardPanel" aria-labelledby="project-agent-title">
        <header className="agentHeader">
          <div className="agentMark" aria-hidden="true">✦</div>
          <div><span className="sectionLabel">Project chat</span><h2 id="project-agent-title">Project agent</h2></div>
          <span className={`agentState ${agentAvailable ? 'online' : ''} ${busy === 'agent' ? 'working' : ''}`}>{busy === 'agent' ? 'Working' : agentAvailable ? 'Ready' : 'Offline'}</span>
        </header>
        <p className="agentCapability">{accountType === 'client' ? 'Submit a client task or issue flag here. Active engineers will be notified.' : 'Review client requests or ask about recent plugin-recorded project changes.'} Changes still require confirmation when applicable.</p>
        {!agentAvailable && <div className="chatUnavailable" role="status"><strong>Agent unavailable</strong><p>The agent is not configured for this workspace.</p></div>}
        {activeClientRequests.length > 0 && <section className="clientRequestTray workspaceRequestTray" aria-label="Client requests">
          <header><strong>Client requests</strong><span>{activeClientRequests.length} open</span></header>
          {activeClientRequests.slice(0, 5).map((request) => <article className={`clientRequestItem ${request.kind}`} key={request.id}><div><span className="requestKindLabel">{request.kind === 'issue' ? 'Issue flag' : 'Task'}{request.status === 'in_progress' ? ' · In progress' : ''}</span><strong>{request.summary}</strong>{request.details !== request.summary && <p>{request.details}</p>}{request.last_updated_by && <small className="clientRequestActor">Updated by {request.last_updated_by}{request.last_updated_via === 'codex_plugin' ? ' in Codex' : ''}</small>}</div>{accountType === 'engineer' && <div className="clientRequestActions">{request.status === 'open' && <button type="button" disabled={requestBusy === request.id} onClick={() => void updateClientRequest(request, 'in_progress')}>Start</button>}<button type="button" className="secondaryButton" disabled={requestBusy === request.id} onClick={() => void updateClientRequest(request, 'resolved')}>Resolve</button></div>}</article>)}
        </section>}
        {requestNotice && <p className="clientRequestNotice" role="status">✓ {requestNotice}</p>}
        {messages.length === 0 && <div className="starterPrompts" aria-label="Starter prompts"><strong>{accountType === 'client' ? 'Submit or ask' : 'Try asking'}</strong><div>{starterPrompts.map((prompt) => <button type="button" key={prompt} onClick={() => setAgentCommand(prompt)} disabled={!agentAvailable}>{prompt}</button>)}</div></div>}

        <div className="messageList agentConversation" aria-live="polite" aria-label="Conversation">
          <h3 className="srOnly">Conversation</h3>
          {messages.length ? messages.map((message) => <article className={`message ${message.role}`} key={message.id}><span>{message.role === 'assistant' ? 'Project agent' : 'Project member'}</span><p>{message.body}</p><time dateTime={message.created_at}>{formatTimestamp(message.created_at)}</time></article>) : <div className="conversationEmpty"><strong>What should we accomplish?</strong><p>Describe an outcome or ask about the project.</p></div>}
          {busy === 'agent' && <article className="message assistant agentWorking" role="status" aria-label="Project agent is working"><span>Project agent</span><div className="agentWorkingBody"><span className="typingDots" aria-hidden="true"><i /><i /><i /></span><p>Project agent is working...</p></div></article>}
          <div ref={conversationEndRef} aria-hidden="true" />
        </div>

          {actions.length > 0 && <section className="actionList" aria-labelledby="pending-changes-title"><h3 id="pending-changes-title">Pending changes</h3>{actions.map((action) => { const actionBusy = busy === `confirm:${action.id}` || busy === `cancel:${action.id}`; return <article className="proposedAction" key={action.id}><div><span className="changeKind">{action.description.startsWith('Automatic progress proposal:') ? 'Automatic progress proposal' : 'Agent proposal'}</span><strong>{action.description}</strong><p>Review this specific project change before it runs.</p></div><div className="rowActions"><button disabled={actionBusy} onClick={() => decideAction(action, 'confirm')}>{busy === `confirm:${action.id}` ? 'Updating...' : 'Confirm'}</button><button disabled={actionBusy} className="secondaryButton" onClick={() => decideAction(action, 'cancel')}>{busy === `cancel:${action.id}` ? 'Canceling...' : 'Cancel'}</button></div></article>; })}</section>}

        <form className="chatForm agentComposer" onSubmit={sendCommand} aria-busy={busy === 'agent'}>
          <label htmlFor="agent-command">{accountType === 'client' ? 'Submit a task, report an issue, or ask the project agent' : 'Message the project agent'}</label>
          <textarea id="agent-command" rows={3} value={agentCommand} onChange={(event) => setAgentCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} disabled={(accountType !== 'client' && !agentAvailable) || busy === 'agent'} placeholder={accountType === 'client' ? 'Describe the task or problem…' : 'Ask about the project…'} />
          <div className="chatSubmit"><span role="status">{busy === 'agent' ? 'Sending...' : accountType === 'client' && !agentAvailable ? 'Tasks and issue flags still work while the agent is offline' : 'Enter to send'}</span><button disabled={(accountType !== 'client' && !agentAvailable) || busy === 'agent' || !agentCommand.trim()}>{busy === 'agent' ? 'Sending...' : 'Send'}</button></div>
          {chatError && <p className="errorBanner" role="alert">{chatError}</p>}
        </form>
      </aside>
    </div>
  </div>;
}
