'use client';

import { useMemo, useState } from 'react';
import type { FilesAgentDashboardData } from '@/lib/files-agent-dashboard';

function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function tone(action: string) {
  if (/create|mkdir|link/i.test(action)) return 'green';
  if (/delete|unlink|rmdir/i.test(action)) return 'red';
  if (/rename/i.test(action)) return 'amber';
  return 'violet';
}

export default function DashboardClient({ data, error }: { data: FilesAgentDashboardData | null; error: string }) {
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

  return (
    <div className="dashboardShell">
      <section className="dashboardHeading">
        <div>
          <div className="eyebrow"><span className="liveDot" /> Files only</div>
          <h1>File changes</h1>
          <p>Changes made by approved AI agents. No screens, input, browser activity, or file contents.</p>
        </div>
        <a className="secondaryButton" href="/employee">Connect an agent</a>
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
          {events.map((event, index) => (
            <article className="changeRow" key={`${event.capturedAt}:${event.owner}:${event.device}:${index}`}>
              <span className={`actionIcon ${tone(event.action)}`} aria-hidden="true" />
              <div className="changeMain">
                <code>{event.project}</code>
                <span><b>{event.action}</b> by {event.agent} · {event.owner}</span>
              </div>
              <time>{time(event.capturedAt)}</time>
            </article>
          ))}
          {events.length === 0 && <div className="emptyState"><span className="emptyIcon" aria-hidden="true">✓</span><h3>No changes yet</h3><p>Approved agent file changes will appear here.</p></div>}
        </div>
      </section>

      <section className="connectedPanel">
        <div><span className="sectionLabel">Devices</span><h2>Connected agents</h2></div>
        <div className="deviceList">
          {(data?.devices || []).map((device) => (
            <div className="deviceRow" key={`${device.owner}:${device.device}`}>
              <span className={device.revokedAt ? 'deviceDot offline' : 'deviceDot'} />
              <div><strong>{device.device}</strong><span>{device.owner} · Last seen {time(device.lastSeenAt)}</span></div>
              <span className={device.revokedAt ? 'statusChip offline' : 'statusChip'}>{device.revokedAt ? 'Revoked' : 'Active'}</span>
            </div>
          ))}
          {data?.devices.length === 0 && <p className="emptyLine">No agents connected.</p>}
        </div>
      </section>
    </div>
  );
}
