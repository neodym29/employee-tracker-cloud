'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Discovery from '../components/trace-node/Discovery';
import ProjectChatDock from './ProjectChatDock';
import EngineerUpdates, { type EngineerUpdatesGroup } from '../components/EngineerUpdates';



type Project = { id: string; title: string; title_source?: 'legacy' | 'manual' | 'repository' | 'agent'; description: string; status: string; approval_status: 'pending' | 'approved' | 'rejected'; git_remote_url?: string | null; progress_percent?: number | string | null; progress_summary?: string | null; progress_source?: 'unassessed' | 'manual' | 'plugin_daily' | null; progress_updated_at?: string | null; can_delete?: boolean; membership_id?: string | null; membership_type?: 'invitation' | 'request' | 'creator' | null; membership_status?: string | null; open_request_count?: number; unread_request_count?: number; latest_request_summary?: string | null; latest_request_kind?: 'task' | 'issue' | null };
type Membership = { id: string; project_id: string; display_name: string; membership_type: 'invitation' | 'request' | 'creator'; membership_status: string };
type Engineer = { id: string; display_name: string };
type Client = { id: string; display_name: string };
type Props = { accountType: 'client' | 'engineer' };

async function request(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

export default function ProjectsClient({ accountType }: Props) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [engineers, setEngineers] = useState<Engineer[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [engineerUpdates, setEngineerUpdates] = useState<EngineerUpdatesGroup[]>([]);
  const [projectMemberships, setProjectMemberships] = useState<Record<string, Membership[]>>({});
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [gitRemote, setGitRemote] = useState('');
  const [sourceType, setSourceType] = useState<'remote' | 'local'>('remote');
  const [status, setStatus] = useState('open');
  const [inviteProject, setInviteProject] = useState('');
  const [engineerId, setEngineerId] = useState('');
  const [selectedEngineerIds, setSelectedEngineerIds] = useState<string[]>([]);
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState('');
  const [deleteArmed, setDeleteArmed] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [showCreator, setShowCreator] = useState(false);
  const [openChatIds, setOpenChatIds] = useState<string[]>([]);
  const [namingProjectIds, setNamingProjectIds] = useState<string[]>([]);
  const [editingProjectId, setEditingProjectId] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const sidebarOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const namingAttemptsRef = useRef(new Map<string, number>());
  const createPendingRef = useRef(false);
  const createRequestKeyRef = useRef<string | null>(null);
  const createRequestFingerprintRef = useRef<string | null>(null);
  const [error, setError] = useState('');
  const [detailsError, setDetailsError] = useState('');
  const [createError, setCreateError] = useState('');
  const createErrorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!createError) return;
    createErrorRef.current?.focus({ preventScroll: true });
    createErrorRef.current?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, [createError]);


  const load = useCallback(async () => {
    let data: {
      projects: Project[];
      engineers?: Engineer[];
      clients?: Client[];
      projectMemberships?: Record<string, Membership[]>;
      engineerUpdates?: EngineerUpdatesGroup[];
      detailsError?: boolean;
    };
    try {
      data = await request('/api/projects');
    } catch {
      setError('Projects are temporarily unavailable.');
      return;
    }
    setProjects(data.projects);
    setError('');
    if (accountType === 'client') {
      setEngineers(data.engineers ?? []);
      setEngineerUpdates(data.engineerUpdates ?? []);
      setProjectMemberships(data.projectMemberships ?? {});
      setDetailsError(data.detailsError
        ? 'Projects loaded. Some engineer or join-request controls did not refresh.'
        : '');
    } else {
      setClients(data.clients ?? []);
      setDetailsError(data.detailsError ? 'Projects loaded. Client selection did not refresh.' : '');
    }
  }, [accountType]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (accountType !== 'engineer') return;
    const refresh = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [accountType, load]);
  useEffect(() => {
    const eligible = projects.filter(project => project.can_delete && project.title_source !== 'manual' && project.title_source !== 'agent'
      && (project.title_source === 'repository' || /[_-]|\d{8,}/.test(project.title))
      && Date.now() - (namingAttemptsRef.current.get(project.id) ?? 0) > 60_000);
    if (!eligible.length) return;
    for (const project of eligible) namingAttemptsRef.current.set(project.id, Date.now());
    void (async () => {
      for (const project of eligible) {
        setNamingProjectIds(current => [...new Set([...current, project.id])]);
        try {
          const data = await request(`/api/projects/${project.id}/name`, { method: 'POST' });
          if (data.project?.title) {
            setProjects(current => current.map(candidate => candidate.id === project.id
              ? { ...candidate, title: data.project.title, title_source: data.project.title_source ?? candidate.title_source }
              : candidate));
          }
        } catch { /* Keep the existing name; a later page load can retry safely. */ }
        finally { setNamingProjectIds(current => current.filter(id => id !== project.id)); }
      }
    })();
  }, [projects]);
  useEffect(() => {
    if (accountType !== 'client') return;
    const approvedProjects = projects.filter((project) => project.approval_status === 'approved');
    if (!approvedProjects.some((project) => project.id === inviteProject)) setInviteProject(approvedProjects[0]?.id ?? '');
  }, [accountType, projects, inviteProject]);
  useEffect(() => { if (!engineerId && engineers[0]) setEngineerId(engineers[0].id); }, [engineers, engineerId]);
  useEffect(() => { if (!clientId && clients[0]) setClientId(clients[0].id); }, [clients, clientId]);

  const active = useMemo(() => projects.filter((project) => project.membership_status === 'active'), [projects]);
  const pending = useMemo(() => projects.filter((project) => project.membership_status === 'pending'), [projects]);
  const terminal = useMemo(() => projects.filter((project) => ['declined', 'rejected'].includes(project.membership_status ?? '') || project.approval_status === 'rejected'), [projects]);
  const open = useMemo(() => projects.filter((project) => project.approval_status === 'approved' && project.status === 'open' && !project.membership_status), [projects]);
  const clientProjects = useMemo(() => projects.filter((project) => project.approval_status === 'approved'), [projects]);
  const requestProjects = useMemo(() => active.filter((project) => Number(project.open_request_count ?? 0) > 0)
    .sort((left, right) => Number(right.unread_request_count ?? 0) - Number(left.unread_request_count ?? 0)), [active]);
  const chatProjects = useMemo(() => (accountType === 'client' ? clientProjects : active)
    .filter(project => project.status !== 'archived'), [accountType, active, clientProjects]);

  function openProjectChat(projectId: string) {
    setOpenChatIds(current => [...current.filter(id => id !== projectId), projectId]);
  }

  function closeProjectChat(projectId: string) {
    setOpenChatIds(current => current.filter(id => id !== projectId));
  }

  function requestsChanged() {
    void load();
    router.refresh();
  }

  function scheduleProjectChat(projectId: string) {
    if (sidebarOpenTimerRef.current) clearTimeout(sidebarOpenTimerRef.current);
    sidebarOpenTimerRef.current = setTimeout(() => {
      openProjectChat(projectId);
      sidebarOpenTimerRef.current = null;
    }, 240);
  }

  function beginRename(project: Project) {
    if (!project.can_delete) return;
    if (sidebarOpenTimerRef.current) clearTimeout(sidebarOpenTimerRef.current);
    sidebarOpenTimerRef.current = null;
    setEditingProjectId(project.id);
    setRenameValue(project.title);
    setError('');
  }

  function cancelRename() {
    setEditingProjectId('');
    setRenameValue('');
  }

  async function renameSidebarProject(event: React.FormEvent, project: Project) {
    event.preventDefault();
    const nextTitle = renameValue.trim();
    if (!nextTitle) { setError('Project name cannot be empty.'); return; }
    if (nextTitle === project.title) { cancelRename(); return; }
    setBusy(`rename:${project.id}`);
    setError('');
    try {
      const data = await request(`/api/projects/${project.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: nextTitle }),
      });
      setProjects(current => current.map(candidate => candidate.id === project.id ? { ...candidate, title: data.project.title, title_source: 'manual' } : candidate));
      cancelRename();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Project could not be renamed.');
    } finally {
      setBusy('');
    }
  }

  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    if (createPendingRef.current) return;
    createPendingRef.current = true;
    setCreateBusy(true);
    setError('');
    setCreateError('');
    const sortedEngineerIds = [...selectedEngineerIds].sort();
    const fingerprint = JSON.stringify(accountType === 'engineer'
      ? { accountType, clientId, title: title.trim(), description: description.trim(), sourceType, gitRemote: sourceType === 'local' ? '' : gitRemote.trim() }
      : { accountType, title: title.trim(), description: description.trim(), sourceType, gitRemote: sourceType === 'local' ? '' : gitRemote.trim(), status, engineerIds: sortedEngineerIds });
    if (createRequestFingerprintRef.current !== fingerprint) {
      createRequestFingerprintRef.current = fingerprint;
      createRequestKeyRef.current = crypto.randomUUID();
    }
    const requestKey = createRequestKeyRef.current!;
    try {
      const details = accountType === 'engineer'
        ? { clientId, title, description, sourceType, gitRemote: sourceType === 'local' ? undefined : gitRemote, requestKey }
        : { title, description, sourceType, gitRemote: sourceType === 'local' ? undefined : gitRemote, status, engineerIds: sortedEngineerIds, requestKey };
      const data = await request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(details) });

      setShowCreator(false);
      await load();
    } catch (failure) {
      setCreateError(failure instanceof Error ? failure.message : 'Project could not be created.');
      createPendingRef.current = false;
      setCreateBusy(false);
    }
  }
  function toggleCreationEngineer(engineerId: string) {
    setSelectedEngineerIds((current) => current.includes(engineerId)
      ? current.filter((id) => id !== engineerId)
      : [...current, engineerId].sort());
  }
  async function invite(event: React.FormEvent) {
    event.preventDefault(); setBusy('invite'); setError('');
    try { await request(`/api/projects/${inviteProject}/invitations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engineerId }) }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Invitation could not be sent.'); }
    setBusy('');
  }
  async function act(project: Project, action: 'request' | 'accept' | 'decline') {
    setBusy(project.id); setError('');
    try {
      if (action === 'request') await request(`/api/projects/${project.id}/requests`, { method: 'POST' });
      else await request(`/api/projects/${project.id}/memberships/${project.membership_id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Project request failed.'); }
    setBusy('');
  }

  async function decideMembership(projectId: string, membershipId: string, action: 'approve' | 'reject') {
    setBusy(membershipId); setError('');
    try {
      await request(`/api/projects/${projectId}/memberships/${membershipId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Join request could not be reviewed.'); }
    setBusy('');
  }

  async function deleteProject(project: Project) {
    if (deleteArmed !== project.id) { setDeleteArmed(project.id); return; }
    if (!window.confirm(`Delete “${project.title}” permanently?`)) return;
    setBusy(`delete:${project.id}`); setError('');
    try { await request(`/api/projects/${project.id}`, { method: 'DELETE' }); setDeleteArmed(''); await load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Project could not be deleted.'); setDeleteArmed(''); }
    finally { setBusy(''); }
  }

  const projectCard = (project: Project, action?: React.ReactNode) => {
    const pendingRequests = (projectMemberships[project.id] ?? []).filter((membership) => membership.membership_type === 'request' && membership.membership_status === 'pending');
    const joinRequests = project.approval_status === 'approved' ? pendingRequests : [];
    const decisions = (label: string, memberships: Membership[]) => memberships.length > 0 && <div className="memberRequests"><strong>{label}</strong>{memberships.map((membership) => <div className="memberRow" key={membership.id}><span>{membership.display_name}</span><div className="rowActions"><button disabled={busy === membership.id} onClick={() => decideMembership(project.id, membership.id, 'approve')}>Approve</button><button className="secondaryButton" disabled={busy === membership.id} onClick={() => decideMembership(project.id, membership.id, 'reject')}>Reject</button></div></div>)}</div>;
    const canChat = project.approval_status === 'approved' && project.status !== 'archived' && (accountType === 'client' || project.membership_status === 'active');
    const canSeeProgress = accountType === 'client' || project.membership_status === 'active';
    const rawProgress = project.progress_percent == null ? null : Number(project.progress_percent);
    const progressPercent = rawProgress != null && Number.isFinite(rawProgress) ? Math.max(0, Math.min(100, Math.round(rawProgress))) : null;
    const openRequests = Number(project.open_request_count ?? 0);
    const unreadRequests = Number(project.unread_request_count ?? 0);
    return <article className={`projectCard ${unreadRequests ? 'hasUnreadRequests' : ''}`} key={project.id}><div className="cardTop"><span className="statusBadge">{project.status}</span><span className="statusBadge subtle">{project.approval_status}</span>{project.membership_status && <span className="statusBadge subtle">{project.membership_status}</span>}{unreadRequests > 0 && <span className="statusBadge requestUnreadBadge">{unreadRequests} new</span>}{namingProjectIds.includes(project.id) && <span className="statusBadge namingBadge">✦ Naming…</span>}</div><h3>{project.title}</h3><p>{project.description || 'No description yet.'}</p>{openRequests > 0 && <div className="projectRequestPreview"><span>{project.latest_request_kind === 'issue' ? 'Issue flag' : 'Client task'} · {openRequests} open</span><strong>{project.latest_request_summary}</strong></div>}{canSeeProgress && <div className={`projectCardProgress ${progressPercent == null ? 'isUnassessed' : ''}`}><div><span>Progress</span><strong>{progressPercent == null ? 'Not assessed' : `${progressPercent}%`}</strong></div>{progressPercent != null && <div className="progressTrack compact" role="progressbar" aria-label={`${project.title} delivery progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}><span style={{ width: `${progressPercent}%` }} /></div>}<small>{project.progress_source === 'plugin_daily' ? 'Estimated automatically from Codex plugin milestones.' : progressPercent == null ? 'Waiting for a connected plugin work update.' : 'Set by the project owner.'}</small></div>}{(accountType === 'client' || project.membership_status === 'active') && <p className="muted"><strong>Git remote:</strong> {project.git_remote_url || 'Git link missing'}</p>}<div className="rowActions">{canChat && <button type="button" onClick={() => openProjectChat(project.id)}>{unreadRequests ? 'Review request' : 'Open chat'}</button>}{project.approval_status === 'approved' && (accountType === 'client' || project.membership_status === 'active') && <a className="secondaryButton" href={`/projects/${project.id}`}>Workspace</a>}{action}{project.can_delete && <><button type="button" className="dangerButton" disabled={busy === `delete:${project.id}`} onClick={() => void deleteProject(project)}>{busy === `delete:${project.id}` ? 'Deleting...' : deleteArmed === project.id ? 'Delete again to confirm' : 'Delete project'}</button>{deleteArmed === project.id && busy !== `delete:${project.id}` && <button type="button" className="secondaryButton" onClick={() => setDeleteArmed('')}>Cancel</button>}</>}</div>{accountType === 'client' && decisions('Pending join requests', joinRequests)}</article>;
  };


  const creationError = createError && <p id="create-project-error" className="errorBanner creationError" ref={createErrorRef} role="alert" tabIndex={-1}>{createError} Review the fields and try again.</p>;

  return <><div className="projectsHub">
    <aside className="projectsSidebar" aria-label="Project chats">
      <div className="projectsSidebarHeader"><span className="sectionLabel">Workspace</span><strong>Projects</strong></div>
      <button type="button" className="projectsSidebarNew" onClick={() => setShowCreator(true)}><span aria-hidden="true">＋</span> New project</button>
      <nav aria-label="Your project chats">
        <span className="projectsSidebarLabel">Your chats</span>
        {chatProjects.length ? chatProjects.map(project => editingProjectId === project.id ? <form className="projectsSidebarRename" key={project.id} onSubmit={(event) => void renameSidebarProject(event, project)}>
          <span className="projectsSidebarIcon" aria-hidden="true">{renameValue.trim().charAt(0).toUpperCase() || 'P'}</span>
          <input autoFocus aria-label={`Rename ${project.title}`} maxLength={120} value={renameValue} disabled={busy === `rename:${project.id}`} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') cancelRename(); }} />
          <button type="submit" aria-label={`Save ${project.title} name`} disabled={busy === `rename:${project.id}`}>✓</button>
          <button type="button" aria-label="Cancel rename" disabled={busy === `rename:${project.id}`} onClick={cancelRename}>×</button>
        </form> : <button type="button" key={project.id} className={openChatIds.includes(project.id) ? 'isOpen' : ''} onClick={() => scheduleProjectChat(project.id)} onDoubleClick={() => beginRename(project)} title={project.can_delete ? 'Open chat · double-click to rename' : 'Open chat'}>
          <span className="projectsSidebarIcon" aria-hidden="true">{project.title.trim().charAt(0).toUpperCase() || 'P'}</span>
          <span className="projectsSidebarName">{project.title}</span>
          {Number(project.unread_request_count ?? 0) > 0 ? <span className="projectsSidebarBadge" aria-label={`${project.unread_request_count} new client requests`}>{project.unread_request_count}</span> : openChatIds.includes(project.id) && <span className="projectsSidebarDot" aria-label="Chat open" />}
        </button>) : <p>No project chats yet.</p>}
      </nav>
    </aside>
    <div className="projectsHubContent"><div className="dashboardShell projects-page-shell">
    <div className="dashboardHeading"><div><span className="pill">{accountType} workspace</span><h1>Projects</h1><p>{accountType === 'client' ? 'Your projects, team updates, and requests.' : 'Your workspaces and projects you can join.'}</p></div></div>
    {error && <p className="errorBanner" role="alert">{error}</p>}
    {detailsError && <p className="noticeBanner" role="status">{detailsError} Refresh the page to retry.</p>}
    {accountType === 'client' ? <>
      <div className={`projectGrid projectTools ${showCreator ? '' : 'isHidden'}`}><section className="card" id="client-project-create"><div className="projectCreatorHeader"><h2>Add a project</h2><button type="button" className="secondaryButton" onClick={() => setShowCreator(false)}>Close</button></div><Discovery creationOnly /><form onSubmit={createProject} aria-busy={createBusy}><fieldset disabled={createBusy} className="formLock"><label>Title<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required /></label><label>Description<textarea value={description} maxLength={4000} rows={4} onChange={(e) => setDescription(e.target.value)} /></label><label>Project source<select value={sourceType} onChange={(e) => { setSourceType(e.target.value as 'remote' | 'local'); setCreateError(''); }}><option value="remote">Hosted Git remote</option><option value="local">Local repository (no remote required)</option></select></label>{sourceType === 'local' ? <p className="muted">Link a repository on your device after creating this project. No server file access or remote fetch is performed.</p> : <label>Git remote<input value={gitRemote} aria-invalid={/git remote/i.test(createError)} aria-describedby={/git remote/i.test(createError) ? 'create-project-error' : undefined} maxLength={2048} placeholder="https://github.com/owner/repository.git" onChange={(e) => { setGitRemote(e.target.value); setCreateError(''); }} required /></label>}<label>Starting status<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Open</option><option value="draft">Draft</option></select></label><fieldset className="checkboxGroup"><legend>Add engineers (optional)</legend><p className="muted">Selected approved engineers join immediately as project creators with workspace access.</p>{engineers.length ? engineers.map((engineer) => <label className="checkboxLabel" key={engineer.id}><input type="checkbox" checked={selectedEngineerIds.includes(engineer.id)} onChange={() => toggleCreationEngineer(engineer.id)} />{engineer.display_name}</label>) : <p className="emptyLine">No approved engineers are available.</p>}</fieldset>{creationError}<button disabled={createBusy}>{createBusy ? 'Creating...' : 'Create project'}</button></fieldset></form></section>
      <section className="card"><h2>Available engineers · later invitations</h2><p className="muted">Separately invite an approved engineer to an approved project for their response.</p>{Boolean(projects.some((project) => project.approval_status === 'approved') && engineers.length) ? <form onSubmit={invite}><label>Project<select value={inviteProject} onChange={(e) => setInviteProject(e.target.value)}>{projects.filter((project) => project.approval_status === 'approved').map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label><label>Engineer<select value={engineerId} onChange={(e) => setEngineerId(e.target.value)}>{engineers.map((engineer) => <option key={engineer.id} value={engineer.id}>{engineer.display_name}</option>)}</select></label><button disabled={busy === 'invite'}>{busy === 'invite' ? 'Sending...' : 'Invite'}</button></form> : <p className="emptyLine">Create or approve a project and wait for approved engineers to become available.</p>}</section></div>
      <section><div className="sectionHeading"><h2>Your projects and join requests</h2></div><div className="projectGrid">{clientProjects.length ? clientProjects.map((project) => projectCard(project)) : <p className="muted">No projects yet.</p>}</div></section>
      <EngineerUpdates groups={engineerUpdates} />
    </> : <>
      <section><div className="sectionHeading"><h2>Active projects</h2></div><div className="projectGrid">{active.length ? active.map((project) => projectCard(project)) : <p className="muted">No active projects yet.</p>}</div></section>
      {requestProjects.length > 0 && <section id="client-requests" className="clientRequestInbox"><div className="sectionHeading"><div><span className="sectionLabel">Engineer inbox</span><h2>Client requests</h2></div><span className="muted">Tasks and issue flags from project chat</span></div><div className="projectGrid">{requestProjects.map((project) => <article className={`projectCard requestInboxCard ${Number(project.unread_request_count ?? 0) ? 'hasUnreadRequests' : ''}`} key={`request:${project.id}`}><div className="cardTop"><span className={`statusBadge requestKind ${project.latest_request_kind === 'issue' ? 'issue' : ''}`}>{project.latest_request_kind === 'issue' ? 'Issue' : 'Task'}</span>{Number(project.unread_request_count ?? 0) > 0 && <span className="statusBadge requestUnreadBadge">{project.unread_request_count} new</span>}</div><h3>{project.title}</h3><p>{project.latest_request_summary}</p><div className="rowActions"><button type="button" onClick={() => openProjectChat(project.id)}>Review in chat</button><a className="secondaryButton" href={`/projects/${project.id}`}>Open workspace</a></div></article>)}</div></section>}
      {pending.length > 0 && <section><div className="sectionHeading"><h2>Invited and requested</h2></div><div className="projectGrid">{pending.map((project) => projectCard(project, project.membership_type === 'invitation' ? <><button disabled={busy === project.id} onClick={() => act(project, 'accept')}>Accept</button><button className="secondaryButton" disabled={busy === project.id} onClick={() => act(project, 'decline')}>Decline</button></> : <span className="muted">Join request sent</span>))}</div></section>}
      <section><div className="sectionHeading"><h2>Open projects</h2><span className="muted">Available workspaces</span></div><div className="projectGrid">{open.length ? open.map((project) => projectCard(project, <button disabled={busy === project.id} onClick={() => act(project, 'request')}>Request to join</button>)) : <p className="muted">No open projects right now.</p>}</div></section>
      {terminal.length > 0 && <section><div className="sectionHeading"><h2>Declined and rejected</h2></div><div className="projectGrid">{terminal.map((project) => projectCard(project, <span className="muted">No workspace access</span>))}</div></section>}
      {showCreator && <section className="card projectCreatorPanel" aria-labelledby="project-creator-title"><div className="projectCreatorHeader"><div><span className="pill">New project</span><h2 id="project-creator-title">Add a project</h2></div><button type="button" className="secondaryButton" onClick={() => setShowCreator(false)}>Close</button></div><p className="muted">Choose a scanned local repository or complete the project form.</p><Discovery creationOnly onComplete={() => { setShowCreator(false); void load(); }} />{clients.length ? <form onSubmit={createProject} aria-busy={createBusy}><fieldset disabled={createBusy} className="formLock"><label>Client<select value={clientId} onChange={(e) => setClientId(e.target.value)} required>{clients.map((client) => <option key={client.id} value={client.id}>{client.display_name}</option>)}</select></label><label>Title<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required /></label><label>Description<textarea value={description} maxLength={4000} rows={4} onChange={(e) => setDescription(e.target.value)} /></label><label>Project source<select value={sourceType} onChange={(e) => { setSourceType(e.target.value as 'remote' | 'local'); setCreateError(''); }}><option value="remote">Hosted Git remote</option><option value="local">Local repository (no remote required)</option></select></label>{sourceType === 'local' ? <p className="muted">Link a repository on your device after creating this project. No server file access or remote fetch is performed.</p> : <label>Git remote<input value={gitRemote} aria-invalid={/git remote/i.test(createError)} aria-describedby={/git remote/i.test(createError) ? 'create-project-error' : undefined} maxLength={2048} placeholder="https://github.com/owner/repository.git" onChange={(e) => { setGitRemote(e.target.value); setCreateError(''); }} required /></label>}{creationError}<button disabled={createBusy}>{createBusy ? 'Creating...' : 'Create project'}</button></fieldset></form> : <p className="emptyLine">No approved clients are available.</p>}</section>}
      <div className="projectCreateLauncher">{!showCreator && <button type="button" onClick={() => setShowCreator(true)}>+ Add new project</button>}</div>
    </>}
  </div></div></div>
  <ProjectChatDock projects={chatProjects.map(project => ({ id: project.id, title: project.title }))} openIds={openChatIds} accountType={accountType} onClose={closeProjectChat} onRequestsChanged={requestsChanged} />
  </>;
}
