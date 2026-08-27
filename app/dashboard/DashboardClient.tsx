'use client';

import { useMemo, useState } from 'react';
import type { FilesAgentDashboardData } from '@/lib/files-agent-dashboard';
import type { ProjectDashboardData } from '@/lib/project-dashboard';

type Props =
  | { mode: 'admin'; data: FilesAgentDashboardData | null; error: string }
  | { mode: 'projects'; accountType: 'client' | 'engineer'; data: ProjectDashboardData | null; error: string };

function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function tone(action: string) {
  if (/create|mkdir|link/i.test(action)) return 'green';
  if (/delete|unlink|rmdir/i.test(action)) return 'red';
  if (/rename/i.test(action)) return 'amber';
  return 'violet';
}

function actionLabel(action: string) {
  return action.replaceAll('_', ' ');
}

function AdminDashboard({ data, error }: Extract<Props, { mode: 'admin' }>) {
  const [agent, setAgent] = useState('all');
  const [action, setAction] = useState('all');
  const agents = useMemo(() => [...new Set((data?.events || []).map((event) => event.agent))].sort(), [data]);
  const actions = useMemo(() => [...new Set((data?.events || []).map((event) => event.action))].sort(), [data]);
  const events = useMemo(() => (data?.events || []).filter((event) =>
    (agent === 'all' || event.agent === agent) && (action === 'all' || event.action === action)
  ), [data, agent, action]);
  const durable = data?.dailySummary.status === 'generated' ? data.dailySummary : null;
  const activeDevices = (data?.devices || []).filter((device) => !device.revokedAt).length;
  const totals = durable?.summary.totals;

  return <>
    <section className="dashboardHeading">
      <div><div className="eyebrow"><span className="liveDot" /> Platform overview</div><h1>Dashboard</h1><p>Review privacy-safe approved agent file metadata and manage platform access.</p></div>
      <div className="dashboardCtas"><a className="primaryButton" href="/admin/approve">Review approvals</a><a className="secondaryButton" href="/employee">Connect an agent</a></div>
    </section>
    {error && <div className="errorBanner" role="alert">Could not load file changes. Please try again.</div>}
    <section className="statRow" aria-label="Summary">
      <div><span>Changes</span><strong>{totals?.events ?? events.length}</strong></div>
      <div><span>Projects</span><strong>{totals?.changedPaths ?? new Set(events.map((event) => event.project)).size}</strong></div>
      <div><span>Connected agents</span><strong>{activeDevices}</strong></div>
    </section>
    <section className="dashboardPanel">
      <div className="panelHeader">
        <div><span className="sectionLabel">Activity</span><h2>Recent changes</h2></div>
        <div className="filterBar" aria-label="File change filters">
          <label><span>Agent</span><select value={agent} onChange={(event) => setAgent(event.target.value)}><option value="all">All agents</option>{agents.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label><span>Action</span><select value={action} onChange={(event) => setAction(event.target.value)}><option value="all">All changes</option>{actions.map((value) => <option key={value}>{value}</option>)}</select></label>
        </div>
      </div>
      <div className="changeFeed">
        {events.map((event, index) => <article className="changeRow" key={`${event.capturedAt}:${event.owner}:${event.device}:${index}`}>
          <span className={`actionIcon ${tone(event.action)}`} aria-hidden="true" />
          <div className="changeMain"><code>{event.project}</code><span><b>{event.action}</b> by {event.agent} · {event.owner}</span></div>
          <time dateTime={event.capturedAt}>{time(event.capturedAt)}</time>
        </article>)}
        {events.length === 0 && <div className="emptyState"><span className="emptyIcon" aria-hidden="true">✓</span><h3>No changes yet</h3><p>Approved agent file changes will appear here.</p></div>}
      </div>
    </section>
    <section className="connectedPanel">
      <div><span className="sectionLabel">Devices</span><h2>Connected agents</h2></div>
      <div className="deviceList">
        {(data?.devices || []).map((device) => <div className="deviceRow" key={`${device.owner}:${device.device}`}>
          <span className={device.revokedAt ? 'deviceDot offline' : 'deviceDot'} />
          <div><strong>{device.device}</strong><span>{device.owner} · Last seen {time(device.lastSeenAt)}</span></div>
          <span className={device.revokedAt ? 'statusChip offline' : 'statusChip'}>{device.revokedAt ? 'Revoked' : 'Active'}</span>
        </div>)}
        {data?.devices.length === 0 && <p className="emptyLine">No agents connected.</p>}
      </div>
    </section>
  </>;
}

function ProjectDashboard({ accountType, data, error }: Extract<Props, { mode: 'projects' }>) {
  const client = accountType === 'client';
  return <>
    <section className="dashboardHeading">
      <div><div className="eyebrow"><span className="liveDot" /> {client ? 'Client workspace' : 'Engineer workspace'}</div><h1>Dashboard</h1><p>See your approved projects and confirmed agent file changes. File contents and private activity stay out.</p></div>
      <div className="dashboardCtas"><a className="primaryButton" href="/projects">{client ? 'Manage projects' : 'Find projects'}</a></div>
    </section>
    {error && <div className="errorBanner" role="alert">Could not load your dashboard. Please try again.</div>}
    <section className="statRow" aria-label="Summary">
      <div><span>Approved projects</span><strong>{data?.stats.projects ?? 0}</strong></div>
      <div><span>Active projects</span><strong>{data?.stats.activeProjects ?? 0}</strong></div>
      <div><span>Confirmed file changes</span><strong>{data?.stats.confirmedChanges ?? 0}</strong></div>
    </section>
    <div className="dashboardGrid">
      <section className="dashboardPanel">
        <div className="panelHeader"><div><span className="sectionLabel">Projects</span><h2>Recent projects</h2></div><a className="textLink" href="/projects">View all</a></div>
        <div className="dashboardList">
          {(data?.projects || []).map((project) => <a className="dashboardListRow" href={`/projects/${project.id}`} key={project.id}>
            <div><strong>{project.title}</strong><span>Updated {time(project.updatedAt)}</span></div><span className="statusBadge subtle">{project.status}</span>
          </a>)}
          {data?.projects.length === 0 && <div className="emptyState"><h3>No approved projects yet</h3><p>Use Projects to get started.</p></div>}
        </div>
      </section>
      <section className="dashboardPanel">
        <div className="panelHeader"><div><span className="sectionLabel">Agent activity</span><h2>Recent confirmed agent file changes</h2></div></div>
        <div className="changeFeed">
          {(data?.fileChanges || []).map((change) => <article className="changeRow" key={change.id}>
            <span className={`actionIcon ${tone(change.actionType)}`} aria-hidden="true" />
            <div className="changeMain"><code>{change.projectTitle}</code><span><b>{actionLabel(change.actionType)}</b></span></div>
            <time dateTime={change.confirmedAt}>{time(change.confirmedAt)}</time>
          </article>)}
          {data?.fileChanges.length === 0 && <div className="emptyState"><h3>No confirmed changes yet</h3><p>Confirmed project agent file changes will appear here.</p></div>}
        </div>
      </section>
    </div>
  </>;
}

export default function DashboardClient(props: Props) {
  return <div className="dashboardShell">{props.mode === 'admin' ? <AdminDashboard {...props} /> : <ProjectDashboard {...props} />}</div>;
}
