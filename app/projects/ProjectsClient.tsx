'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Project = { id: string; title: string; description: string; status: string; approval_status: 'pending' | 'approved' | 'rejected'; membership_id?: string | null; membership_type?: 'invitation' | 'request' | 'creator' | null; membership_status?: string | null };
type Membership = { id: string; project_id: string; display_name: string; membership_type: 'invitation' | 'request' | 'creator'; membership_status: string; is_project_proposal: boolean };
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
  const [projectMemberships, setProjectMemberships] = useState<Record<string, Membership[]>>({});
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('open');
  const [inviteProject, setInviteProject] = useState('');
  const [engineerId, setEngineerId] = useState('');
  const [selectedEngineerIds, setSelectedEngineerIds] = useState<string[]>([]);
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const createPendingRef = useRef(false);
  const createRequestKeyRef = useRef<string | null>(null);
  const createRequestFingerprintRef = useRef<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await request('/api/projects');
      setProjects(data.projects);
      if (accountType === 'client') {
        const [people, membershipResponses] = await Promise.all([
          request('/api/engineers'),
          Promise.all(data.projects.map((project: Project) => request(`/api/projects/${project.id}/requests`))),
        ]);
        setEngineers(people.engineers);
        setProjectMemberships(Object.fromEntries(data.projects.map((project: Project, index: number) => [project.id, membershipResponses[index].memberships])));
      } else {
        const people = await request('/api/clients');
        setClients(people.clients);
      }
    } catch { setError('Projects are temporarily unavailable.'); }
  }, [accountType]);
  useEffect(() => { void load(); }, [load]);
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
  const clientProposals = useMemo(() => projects.filter((project) => project.approval_status === 'pending'), [projects]);
  const clientApproved = useMemo(() => projects.filter((project) => project.approval_status === 'approved'), [projects]);
  const clientRejected = useMemo(() => projects.filter((project) => project.approval_status === 'rejected'), [projects]);

  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    if (createPendingRef.current) return;
    createPendingRef.current = true;
    setCreateBusy(true);
    setError('');
    const sortedEngineerIds = [...selectedEngineerIds].sort();
    const fingerprint = JSON.stringify(accountType === 'engineer'
      ? { accountType, clientId, title: title.trim(), description: description.trim() }
      : { accountType, title: title.trim(), description: description.trim(), status, engineerIds: sortedEngineerIds });
    if (createRequestFingerprintRef.current !== fingerprint) {
      createRequestFingerprintRef.current = fingerprint;
      createRequestKeyRef.current = crypto.randomUUID();
    }
    const requestKey = createRequestKeyRef.current!;
    try {
      const details = accountType === 'engineer'
        ? { clientId, title, description, requestKey }
        : { title, description, status, engineerIds: sortedEngineerIds, requestKey };
      const data = await request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(details) });
      if (accountType === 'client') {
        router.push(`/projects/${data.project.id}`);
      } else {
        // A proposal remains pending and must not open a workspace before client consent.
        await load();
        setTitle('');
        setDescription('');
        createRequestKeyRef.current = null;
        createRequestFingerprintRef.current = null;
        createPendingRef.current = false;
        setCreateBusy(false);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Project could not be created.');
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
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Project proposal could not be reviewed.'); }
    setBusy('');
  }

  const projectCard = (project: Project, action?: React.ReactNode) => {
    const pendingRequests = (projectMemberships[project.id] ?? []).filter((membership) => membership.membership_type === 'request' && membership.membership_status === 'pending');
    const proposalRequests = project.approval_status === 'pending' ? pendingRequests.filter((membership) => membership.is_project_proposal) : [];
    const joinRequests = project.approval_status === 'approved' ? pendingRequests.filter((membership) => !membership.is_project_proposal) : [];
    const decisions = (label: string, memberships: Membership[]) => memberships.length > 0 && <div className="memberRequests"><strong>{label}</strong>{memberships.map((membership) => <div className="memberRow" key={membership.id}><span>{membership.display_name}</span><div className="rowActions"><button disabled={busy === membership.id} onClick={() => decideMembership(project.id, membership.id, 'approve')}>Approve</button><button className="secondaryButton" disabled={busy === membership.id} onClick={() => decideMembership(project.id, membership.id, 'reject')}>Reject</button></div></div>)}</div>;
    return <article className="projectCard" key={project.id}><div className="cardTop"><span className="statusBadge">{project.status}</span><span className="statusBadge subtle">{project.approval_status}</span>{project.membership_status && <span className="statusBadge subtle">{project.membership_status}</span>}</div><h3>{project.title}</h3><p>{project.description || 'No description yet.'}</p><div className="rowActions">{project.approval_status === 'approved' && (accountType === 'client' || project.membership_status === 'active') && <a className="secondaryButton" href={`/projects/${project.id}`}>Open workspace</a>}{action}</div>{accountType === 'client' && decisions('Pending project proposal', proposalRequests)}{accountType === 'client' && decisions('Pending join requests', joinRequests)}</article>;
  };

  return <div className="dashboardShell">
    <div className="dashboardHeading"><div><span className="pill">{accountType} workspace</span><h1>Projects</h1><p>{accountType === 'client' ? 'Create a project and invite approved engineers to collaborate.' : 'Send a project proposal to an approved client, find open work, and manage invitations.'}</p><p className="muted">Platform Admins approve accounts; project clients and engineers approve collaboration.</p></div></div>
    {error && <p className="errorBanner" role="alert">{error}</p>}
    {accountType === 'client' ? <>
      <div className="projectGrid projectTools"><section className="card"><h2>Create project</h2><form onSubmit={createProject} aria-busy={createBusy}><fieldset disabled={createBusy} className="formLock"><label>Title<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required /></label><label>Description<textarea value={description} maxLength={4000} rows={4} onChange={(e) => setDescription(e.target.value)} /></label><label>Starting status<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Open</option><option value="draft">Draft</option></select></label><fieldset className="checkboxGroup"><legend>Invite engineers (optional)</legend><p className="muted">Selected approved engineers receive pending invitations and gain access only after accepting.</p>{engineers.length ? engineers.map((engineer) => <label className="checkboxLabel" key={engineer.id}><input type="checkbox" checked={selectedEngineerIds.includes(engineer.id)} onChange={() => toggleCreationEngineer(engineer.id)} />{engineer.display_name}</label>) : <p className="emptyLine">No approved engineers are available.</p>}</fieldset><button disabled={createBusy}>{createBusy ? 'Creating...' : 'Create project'}</button></fieldset></form></section>
      <section className="card"><h2>Available engineers · later invitations</h2><p className="muted">Separately invite an approved engineer to an approved project for their response.</p>{Boolean(projects.some((project) => project.approval_status === 'approved') && engineers.length) ? <form onSubmit={invite}><label>Project<select value={inviteProject} onChange={(e) => setInviteProject(e.target.value)}>{projects.filter((project) => project.approval_status === 'approved').map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label><label>Engineer<select value={engineerId} onChange={(e) => setEngineerId(e.target.value)}>{engineers.map((engineer) => <option key={engineer.id} value={engineer.id}>{engineer.display_name}</option>)}</select></label><button disabled={busy === 'invite'}>{busy === 'invite' ? 'Sending...' : 'Invite'}</button></form> : <p className="emptyLine">Create or approve a project and wait for approved engineers to become available.</p>}</section></div>
      <section><div className="sectionHeading"><h2>Pending project proposals</h2></div><div className="projectGrid">{clientProposals.length ? clientProposals.map((project) => projectCard(project)) : <p className="muted">No project proposals await your decision.</p>}</div></section>
      <section><div className="sectionHeading"><h2>Your approved projects and join requests</h2></div><div className="projectGrid">{clientApproved.length ? clientApproved.map((project) => projectCard(project)) : <p className="muted">No approved projects yet.</p>}</div></section>
      <section><div className="sectionHeading"><h2>Rejected project proposals</h2></div><div className="projectGrid">{clientRejected.length ? clientRejected.map((project) => projectCard(project)) : <p className="muted">No rejected proposals.</p>}</div></section>
    </> : <>
      <section className="card projectTools"><h2>Project proposal</h2><p className="muted">Select an approved client. They must approve your proposal before you can open the workspace.</p>{clients.length ? <form onSubmit={createProject} aria-busy={createBusy}><fieldset disabled={createBusy} className="formLock"><label>Client<select value={clientId} onChange={(e) => setClientId(e.target.value)} required>{clients.map((client) => <option key={client.id} value={client.id}>{client.display_name}</option>)}</select></label><label>Title<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required /></label><label>Description<textarea value={description} maxLength={4000} rows={4} onChange={(e) => setDescription(e.target.value)} /></label><button disabled={createBusy}>{createBusy ? 'Sending...' : 'Send project proposal'}</button></fieldset></form> : <p className="emptyLine">No approved clients are available.</p>}</section>
      <section><div className="sectionHeading"><h2>Invited and requested</h2></div><div className="projectGrid">{pending.length ? pending.map((project) => projectCard(project, project.membership_type === 'invitation' ? <><button disabled={busy === project.id} onClick={() => act(project, 'accept')}>Accept</button><button className="secondaryButton" disabled={busy === project.id} onClick={() => act(project, 'decline')}>Decline</button></> : <span className="muted">{project.approval_status === 'pending' ? 'Awaiting client approval' : 'Join request sent'}</span>)) : <p className="muted">No pending invitations or requests.</p>}</div></section>
      <section><div className="sectionHeading"><h2>Active projects</h2></div><div className="projectGrid">{active.length ? active.map((project) => projectCard(project)) : <p className="muted">No active projects yet.</p>}</div></section>
      <section><div className="sectionHeading"><h2>Declined and rejected</h2></div><div className="projectGrid">{terminal.length ? terminal.map((project) => projectCard(project, <span className="muted">No workspace access</span>)) : <p className="muted">No declined or rejected outcomes.</p>}</div></section>
      <section><div className="sectionHeading"><h2>Open projects</h2></div><div className="projectGrid">{open.length ? open.map((project) => projectCard(project, <button disabled={busy === project.id} onClick={() => act(project, 'request')}>Request to join</button>)) : <p className="muted">No open projects right now.</p>}</div></section>
    </>}
  </div>;
}
