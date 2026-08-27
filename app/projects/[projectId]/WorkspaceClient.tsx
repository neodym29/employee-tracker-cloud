'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Project = { id: string; title: string; description: string; status: string };
type Membership = { id: string; display_name: string; membership_type: 'request' | 'invitation' | 'creator'; membership_status: string };
type ProjectFile = { file_id: string; version: number; path: string; media_type: string; byte_size: number | string; created_at: string };
type AgentMessage = { id: string; role: 'user' | 'assistant'; body: string; created_at: string };
type AgentAction = {
  id: string;
  action_type: 'create_file' | 'update_file' | 'rename_file' | 'delete_file';
  input: Record<string, unknown>;
  status: string;
  result?: Record<string, unknown> | null;
  created_at: string;
};
type FileReceipt = { id: string; label: string; detail: string };

const STARTER_PROMPTS = [
  'Create a concise project brief from our structured project data.',
  'Organize the current project data into a clear delivery plan.',
  'Update the canonical progress report and project statistics.',
] as const;

async function api(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.code === 'chat_unavailable' ? 'The agent is unavailable.' : data.error || 'Request failed.');
  return data;
}

const jsonOptions = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function formatBytes(value: number | string) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = bytes / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function receiptFor(action: AgentAction): FileReceipt | null {
  if (action.action_type !== 'create_file' || action.status !== 'confirmed') return null;
  const result = action.result || {};
  const path = String(result.path || action.input.path || 'New project file');
  return { id: `receipt-${action.id}`, label: 'File created', detail: path };
}

export default function WorkspaceClient({ projectId, accountType }: { projectId: string; accountType: 'client' | 'engineer' }) {
  const base = `/api/projects/${projectId}`;
  const [project, setProject] = useState<Project | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [receipts, setReceipts] = useState<FileReceipt[]>([]);
  const [agentAvailable, setAgentAvailable] = useState(true);
  const [error, setError] = useState('');
  const [chatError, setChatError] = useState('');
  const [busy, setBusy] = useState('');
  const [agentCommand, setAgentCommand] = useState('');
  const submissionPendingRef = useRef(false);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);

  const loadFiles = useCallback(async () => {
    const fileData = await api(`${base}/files`);
    setFiles(fileData.files);
  }, [base]);

  const loadWorkspace = useCallback(async () => {
    try {
      const requests: Promise<unknown>[] = [api(base), api(`${base}/files`), api(`${base}/chat`)];
      if (accountType === 'client') requests.push(api(`${base}/requests`));
      const [projectData, fileData, agentData, memberData] = await Promise.all(requests) as any[];
      setProject(projectData.project);
      setFiles(fileData.files);
      setMessages(agentData.messages);
      setActions(agentData.actions);
      setAgentAvailable(agentData.available !== false);
      if (memberData) setMemberships(memberData.memberships);
    } catch {
      setError('This workspace is unavailable or you no longer have access.');
    }
  }, [accountType, base]);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, actions, receipts]);

  async function run(key: string, work: () => Promise<unknown>, fallback: string) {
    setBusy(key);
    setError('');
    try { await work(); await loadWorkspace(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : fallback); }
    finally { setBusy(''); }
  }

  function fileForAction(action: AgentAction) {
    return files.find((file) => file.file_id === String(action.input.fileId));
  }

  function describeAction(action: AgentAction) {
    const currentPath = fileForAction(action)?.path || 'this project file';
    if (action.action_type === 'update_file') return `Replace the contents of ${currentPath} with a new version.`;
    if (action.action_type === 'rename_file') return `Move ${currentPath} to ${String(action.input.path || 'a new path')}.`;
    if (action.action_type === 'delete_file') return `Remove ${currentPath} from the project.`;
    return `Create ${String(action.input.path || 'a new project file')}.`;
  }

  async function decideAction(action: AgentAction, decision: 'confirm' | 'cancel') {
    setBusy(`${decision}:${action.id}`);
    setError('');
    try {
      const data = await api(`${base}/agent-actions/${action.id}/${decision}`, { method: 'POST' });
      setActions((current) => current.filter((item) => item.id !== action.id));
      if (decision === 'confirm' && data.action) {
        const receipt = receiptFor(data.action);
        if (receipt) setReceipts((current) => [...current, receipt]);
      }
      if (decision === 'confirm') await loadFiles();
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
      const created = returnedActions.map(receiptFor).filter((receipt): receipt is FileReceipt => Boolean(receipt));
      if (created.length) setReceipts((current) => [...current, ...created]);
      await loadFiles().catch(() => undefined);
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

  if (!project) return <section className="card"><p className="muted">Loading workspace...</p>{error && <p className="errorBanner" role="alert">{error}</p>}</section>;
  const fileActivity = busy === 'agent' ? 'Agent reviewing files…' : busy.startsWith('confirm:') ? 'Updating files…' : '';

  return <div className="workspaceShell agentWorkspace">
    <a className="backLink" href="/projects">← Back to projects</a>

    <header className="projectContext">
      <div className="projectContextCopy">
        <span className="sectionLabel">Project workspace</span>
        <h1>{project.title}</h1>
        {project.description && <p>{project.description}</p>}
      </div>
      <div className="projectContextMeta">
        <span className="statusBadge">{project.status}</span>
        {accountType === 'client' && <select aria-label="Project status" value={project.status} disabled={busy === 'status'} onChange={(event) => run('status', () => api(base, jsonOptions({ ...project, status: event.target.value }, 'PATCH')), 'Status could not be updated.')}>
          <option value="draft">Draft</option><option value="open">Open</option><option value="active">Active</option><option value="completed">Completed</option><option value="archived">Archived</option>
        </select>}
        <span>{memberships.length} {memberships.length === 1 ? 'member' : 'members'}</span>
      </div>
    </header>

    {accountType === 'client' && memberships.some((member) => member.membership_status === 'pending') && <details className="memberRequests dashboardPanel">
      <summary>Pending member requests</summary>
      {memberships.filter((member) => member.membership_status === 'pending').map((member) => <div className="memberRow" key={member.id}>
        <div><strong>{member.display_name}</strong><span>{member.membership_type}</span></div>
        <div className="rowActions"><button onClick={() => run(member.id, () => api(`${base}/memberships/${member.id}`, jsonOptions({ action: 'approve' })), 'Request failed.')}>Approve</button><button className="secondaryButton" onClick={() => run(member.id, () => api(`${base}/memberships/${member.id}`, jsonOptions({ action: 'reject' })), 'Request failed.')}>Reject</button></div>
      </div>)}
    </details>}

    {error && <p className="errorBanner" role="alert">{error}</p>}

    <main className="workspaceGrid agentGrid">
      <section className="agentPanel dashboardPanel" aria-labelledby="project-agent-title">
        <header className="agentHeader">
          <div className="agentMark" aria-hidden="true">✦</div>
          <div><span className="sectionLabel">Working in this project</span><h2 id="project-agent-title">Project agent</h2></div>
          <span className={`agentState ${agentAvailable ? 'online' : ''}`}>{agentAvailable ? 'Ready' : 'Offline'}</span>
        </header>
        <p className="agentCapability">I use your prompts and authorized structured project data to create, maintain, and organize project deliverables and canonical agent documents.</p>

        {!agentAvailable && <div className="chatUnavailable" role="status"><strong>Agent unavailable</strong><p>The agent has not been configured for this workspace. Existing agent documents remain available.</p></div>}

        {messages.length === 0 && <div className="starterPrompts" aria-label="Starter prompts">
          <strong>Starter prompts</strong>
          <div>{STARTER_PROMPTS.map((prompt) => <button type="button" key={prompt} onClick={() => setAgentCommand(prompt)} disabled={!agentAvailable}>{prompt}</button>)}</div>
        </div>}

        <div className="messageList agentConversation" aria-live="polite" aria-label="Conversation">
          <h3 className="srOnly">Conversation</h3>
          {messages.length ? messages.map((message) => <article className={`message ${message.role}`} key={message.id}>
            <span>{message.role === 'assistant' ? 'Project agent' : 'You'}</span><p>{message.body}</p>
          </article>) : <div className="conversationEmpty"><strong>What should we accomplish?</strong><p>Give the agent an outcome. It will work from authorized project data and keep its generated documents current.</p></div>}
          {busy === 'agent' && <article className="message assistant agentWorking" role="status" aria-label="Project agent is working">
            <span>Project agent</span><div className="agentWorkingBody"><span className="typingDots" aria-hidden="true"><i /><i /><i /></span><p>Project agent is working…</p></div>
          </article>}
          {receipts.map((receipt) => <article className="fileReceipt" key={receipt.id}><span aria-hidden="true">✓</span><div><strong>{receipt.label}</strong><p>{receipt.detail}</p></div></article>)}
          <div ref={conversationEndRef} aria-hidden="true" />
        </div>

        {actions.length > 0 && <section className="actionList" aria-labelledby="pending-changes-title">
          <h3 id="pending-changes-title">Pending changes</h3>
          {actions.map((action) => { const actionBusy = busy === `confirm:${action.id}` || busy === `cancel:${action.id}`; return <article className="proposedAction" key={action.id}>
            <div><span className="changeKind">Agent proposal</span><strong>{action.action_type === 'update_file' ? 'Update file' : action.action_type === 'rename_file' ? 'Rename file' : 'Delete file'}</strong><p>{describeAction(action)}</p></div>
            <div className="rowActions"><button disabled={actionBusy} onClick={() => decideAction(action, 'confirm')}>{busy === `confirm:${action.id}` ? 'Updating…' : 'Confirm'}</button><button disabled={actionBusy} className="secondaryButton" onClick={() => decideAction(action, 'cancel')}>{busy === `cancel:${action.id}` ? 'Canceling…' : 'Cancel'}</button></div>
          </article>})}
        </section>}

        <form className="chatForm agentComposer" onSubmit={sendCommand} aria-busy={busy === 'agent'}>
          <label htmlFor="agent-command">Message the project agent</label>
          <textarea id="agent-command" rows={4} value={agentCommand} onChange={(event) => setAgentCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} disabled={!agentAvailable || busy === 'agent'} placeholder="Describe the outcome you want…" />
          <div className="chatSubmit"><span role="status">{busy === 'agent' ? 'Sending…' : 'Enter to send · Shift+Enter for a new line'}</span><button disabled={!agentAvailable || busy === 'agent' || !agentCommand.trim()}>{busy === 'agent' ? 'Sending…' : 'Send'}</button></div>
          {chatError && <p className="errorBanner" role="alert">{chatError}</p>}
        </form>
      </section>

      <aside className="fileRail dashboardPanel" aria-labelledby="generated-files-title" aria-busy={Boolean(fileActivity)}>
        <div className="fileRailHeader"><div><span className="sectionLabel">Agent output</span><h2 id="generated-files-title">Agent documents</h2></div>{fileActivity ? <span className="fileLoadingState" role="status"><span className="loadingSpinner" aria-hidden="true" />{fileActivity}</span> : <span>{files.length}</span>}</div>
        {files.length ? <ul className="fileList">{files.map((file) => <li key={file.file_id}>
          <div className="fileIcon" aria-hidden="true">↗</div>
          <div className="fileInfo"><strong title={file.path}>{file.path}</strong><span>Version {file.version} · {file.media_type} · {formatBytes(file.byte_size)}</span></div>
          <a href={`${base}/files/${file.file_id}`} target="_blank" rel="noreferrer" aria-label={`Open or download ${file.path}`}>Open <span aria-hidden="true">↗</span></a>
        </li>)}</ul> : <div className="fileEmpty"><div aria-hidden="true">✦</div><strong>Preparing agent documents</strong><p>Canonical agent documents are generated automatically from authorized project data.</p></div>}
      </aside>
    </main>
  </div>;
}
