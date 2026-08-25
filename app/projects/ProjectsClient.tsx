'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type Project = { id: string; title: string; description: string; status: string; membership_id?: string | null; membership_type?: 'invitation' | 'request' | null; membership_status?: string | null };
type Engineer = { id: string; display_name: string };
type Props = { accountType: 'client' | 'engineer' };

async function request(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

export default function ProjectsClient({ accountType }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [engineers, setEngineers] = useState<Engineer[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('open');
  const [inviteProject, setInviteProject] = useState('');
  const [engineerId, setEngineerId] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await request('/api/projects');
      setProjects(data.projects);
      if (accountType === 'client') {
        const people = await request('/api/engineers');
        setEngineers(people.engineers);
      }
    } catch { setError('Projects are temporarily unavailable.'); }
  }, [accountType]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!inviteProject && projects[0]) setInviteProject(projects[0].id); }, [projects, inviteProject]);
  useEffect(() => { if (!engineerId && engineers[0]) setEngineerId(engineers[0].id); }, [engineers, engineerId]);

  const active = useMemo(() => projects.filter((project) => project.membership_status === 'active'), [projects]);
  const pending = useMemo(() => projects.filter((project) => project.membership_status === 'pending'), [projects]);
  const open = useMemo(() => projects.filter((project) => project.status === 'open' && !project.membership_status), [projects]);

  async function createProject(event: React.FormEvent) {
    event.preventDefault(); setBusy('create'); setError('');
    try { await request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, description, status }) }); setTitle(''); setDescription(''); await load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Project could not be created.'); }
    setBusy('');
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
    <div className="dashboardHeading"><div><span className="pill">{accountType} workspace</span><h1>Projects</h1><p>{accountType === 'client' ? 'Create a project and invite an approved engineer.' : 'Find open work and manage invitations.'}</p></div><a className="secondaryButton" href="/dashboard">Files dashboard</a></div>
    {error && <p className="errorBanner" role="alert">{error}</p>}
    {accountType === 'client' ? <>
      <div className="projectGrid projectTools"><section className="card"><h2>Create project</h2><form onSubmit={createProject}><label>Title<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required /></label><label>Description<textarea value={description} maxLength={4000} rows={4} onChange={(e) => setDescription(e.target.value)} /></label><label>Starting status<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Open</option><option value="draft">Draft</option></select></label><button disabled={busy === 'create'}>{busy === 'create' ? 'Creating...' : 'Create project'}</button></form></section>
      <section className="card"><h2>Available engineers</h2><p className="muted">Invite an approved engineer to one of your projects.</p>{Boolean(projects.length && engineers.length) ? <form onSubmit={invite}><label>Project<select value={inviteProject} onChange={(e) => setInviteProject(e.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label><label>Engineer<select value={engineerId} onChange={(e) => setEngineerId(e.target.value)}>{engineers.map((engineer) => <option key={engineer.id} value={engineer.id}>{engineer.display_name}</option>)}</select></label><button disabled={busy === 'invite'}>{busy === 'invite' ? 'Sending...' : 'Invite'}</button></form> : <p className="emptyLine">Create a project and wait for approved engineers to become available.</p>}</section></div>
      <section><div className="sectionHeading"><h2>Your projects</h2></div><div className="projectGrid">{projects.length ? projects.map((project) => projectCard(project)) : <p className="muted">No projects yet.</p>}</div></section>
    </> : <>
      <section><div className="sectionHeading"><h2>Invited and requested</h2></div><div className="projectGrid">{pending.length ? pending.map((project) => projectCard(project, project.membership_type === 'invitation' ? <><button disabled={busy === project.id} onClick={() => act(project, 'accept')}>Accept</button><button className="secondaryButton" disabled={busy === project.id} onClick={() => act(project, 'decline')}>Decline</button></> : <span className="muted">Request sent</span>)) : <p className="muted">No pending invitations or requests.</p>}</div></section>
      <section><div className="sectionHeading"><h2>Active projects</h2></div><div className="projectGrid">{active.length ? active.map((project) => projectCard(project)) : <p className="muted">No active projects yet.</p>}</div></section>
      <section><div className="sectionHeading"><h2>Open projects</h2></div><div className="projectGrid">{open.length ? open.map((project) => projectCard(project, <button disabled={busy === project.id} onClick={() => act(project, 'request')}>Request to join</button>)) : <p className="muted">No open projects right now.</p>}</div></section>
    </>}
  </div>;
}
