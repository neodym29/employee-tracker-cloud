'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Project = { id: string; title: string; description: string; status: string; membership_id?: string | null; membership_type?: 'invitation' | 'request' | 'creator' | null; membership_status?: string | null };
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
        const people = await request('/api/engineers');
        setEngineers(people.engineers);
      } else {
        const people = await request('/api/clients');
        setClients(people.clients);
      }
    } catch { setError('Projects are temporarily unavailable.'); }
  }, [accountType]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!inviteProject && projects[0]) setInviteProject(projects[0].id); }, [projects, inviteProject]);
  useEffect(() => { if (!engineerId && engineers[0]) setEngineerId(engineers[0].id); }, [engineers, engineerId]);
  useEffect(() => { if (!clientId && clients[0]) setClientId(clients[0].id); }, [clients, clientId]);

  const active = useMemo(() => projects.filter((project) => project.membership_status === 'active'), [projects]);
  const pending = useMemo(() => projects.filter((project) => project.membership_status === 'pending'), [projects]);
  const open = useMemo(() => projects.filter((project) => project.status === 'open' && !project.membership_status), [projects]);

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
      // Keep controls locked until navigation completes; a retry after response loss reuses requestKey.
      router.push(`/projects/${data.project.id}`);
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

  const projectCard = (project: Project, action?: React.ReactNode) => <article className="projectCard" key={project.id}><div className="cardTop"><span className="statusBadge">{project.status}</span>{project.membership_status && <span className="statusBadge subtle">{project.membership_status}</span>}</div><h3>{project.title}</h3><p>{project.description || 'No description yet.'}</p><div className="rowActions">{(accountType === 'client' || project.membership_status === 'active') && <a className="secondaryButton" href={`/projects/${project.id}`}>Open workspace</a>}{action}</div></article>;

  return <div className="dashboardShell">
    <div className="dashboardHeading"><div><span className="pill">{accountType} workspace</span><h1>Projects</h1><p>{accountType === 'client' ? 'Create a project solo or form it immediately with approved engineers.' : 'Create a project with an approved client, find open work, and manage invitations.'}</p><p className="muted">Projects start immediately. Platform Admins approve accounts, not projects.</p></div></div>
    {error && <p className="errorBanner" role="alert">{error}</p>}
    {accountType === 'client' ? <>
      <div className="projectGrid projectTools"><section className="card"><h2>Create project</h2><form onSubmit={createProject} aria-busy={createBusy}><fieldset disabled={createBusy} className="formLock"><label>Title<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required /></label><label>Description<textarea value={description} maxLength={4000} rows={4} onChange={(e) => setDescription(e.target.value)} /></label><label>Starting status<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Open</option><option value="draft">Draft</option></select></label><fieldset className="checkboxGroup"><legend>Form project team (optional)</legend><p className="muted">Selected approved engineers become active co-formers immediately.</p>{engineers.length ? engineers.map((engineer) => <label className="checkboxLabel" key={engineer.id}><input type="checkbox" checked={selectedEngineerIds.includes(engineer.id)} onChange={() => toggleCreationEngineer(engineer.id)} />{engineer.display_name}</label>) : <p className="emptyLine">No approved engineers are available.</p>}</fieldset><button disabled={createBusy}>{createBusy ? 'Creating...' : 'Create project'}</button></fieldset></form></section>
      <section className="card"><h2>Available engineers · later invitations</h2><p className="muted">Separately invite an approved engineer to an existing project for their response.</p>{Boolean(projects.length && engineers.length) ? <form onSubmit={invite}><label>Project<select value={inviteProject} onChange={(e) => setInviteProject(e.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label><label>Engineer<select value={engineerId} onChange={(e) => setEngineerId(e.target.value)}>{engineers.map((engineer) => <option key={engineer.id} value={engineer.id}>{engineer.display_name}</option>)}</select></label><button disabled={busy === 'invite'}>{busy === 'invite' ? 'Sending...' : 'Invite'}</button></form> : <p className="emptyLine">Create a project and wait for approved engineers to become available.</p>}</section></div>
      <section><div className="sectionHeading"><h2>Your projects</h2></div><div className="projectGrid">{projects.length ? projects.map((project) => projectCard(project)) : <p className="muted">No projects yet.</p>}</div></section>
    </> : <>
      <section className="card projectTools"><h2>Create project</h2><p className="muted">Select an approved client. Your active workspace opens immediately after creation.</p>{clients.length ? <form onSubmit={createProject} aria-busy={createBusy}><fieldset disabled={createBusy} className="formLock"><label>Client<select value={clientId} onChange={(e) => setClientId(e.target.value)} required>{clients.map((client) => <option key={client.id} value={client.id}>{client.display_name}</option>)}</select></label><label>Title<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required /></label><label>Description<textarea value={description} maxLength={4000} rows={4} onChange={(e) => setDescription(e.target.value)} /></label><button disabled={createBusy}>{createBusy ? 'Creating...' : 'Create project'}</button></fieldset></form> : <p className="emptyLine">No approved clients are available.</p>}</section>
      <section><div className="sectionHeading"><h2>Invited and requested</h2></div><div className="projectGrid">{pending.length ? pending.map((project) => projectCard(project, project.membership_type === 'invitation' ? <><button disabled={busy === project.id} onClick={() => act(project, 'accept')}>Accept</button><button className="secondaryButton" disabled={busy === project.id} onClick={() => act(project, 'decline')}>Decline</button></> : <span className="muted">Request sent</span>)) : <p className="muted">No pending invitations or requests.</p>}</div></section>
      <section><div className="sectionHeading"><h2>Active projects</h2></div><div className="projectGrid">{active.length ? active.map((project) => projectCard(project)) : <p className="muted">No active projects yet.</p>}</div></section>
      <section><div className="sectionHeading"><h2>Open projects</h2></div><div className="projectGrid">{open.length ? open.map((project) => projectCard(project, <button disabled={busy === project.id} onClick={() => act(project, 'request')}>Request to join</button>)) : <p className="muted">No open projects right now.</p>}</div></section>
    </>}
  </div>;
}
