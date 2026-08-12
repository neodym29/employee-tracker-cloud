'use client';

import { useMemo, useState } from 'react';
import type { FilesAgentDashboardData } from '@/lib/files-agent-dashboard';

function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export default function DashboardClient({ data, error }: { data: FilesAgentDashboardData | null; error: string }) {
  const [owner, setOwner] = useState('all');
  const [agent, setAgent] = useState('all');
  const [action, setAction] = useState('all');
  const owners = useMemo(() => [...new Set((data?.events || []).map((event) => event.owner))].sort(), [data]);
  const agents = useMemo(() => [...new Set((data?.events || []).map((event) => event.agent))].sort(), [data]);
  const actions = useMemo(() => [...new Set((data?.events || []).map((event) => event.action))].sort(), [data]);
  const events = useMemo(() => (data?.events || []).filter((event) =>
    (owner === 'all' || event.owner === owner)
    && (agent === 'all' || event.agent === agent)
    && (action === 'all' || event.action === action)
  ), [data, owner, agent, action]);
  const durable = data?.dailySummary.status === 'generated' ? data.dailySummary : null;
  const generatedAt = durable?.generatedAt;

  return (
    <div>
      <section className="card">
        <span className="pill">Files only</span>
        <h1>AI file changes</h1>
        <p className="muted">Only minimized file metadata attributed to approved Hermes, Codex, or Claude wrapped runs is shown here. Historical legacy data remains stored but is never queried or displayed.</p>
        {error && <p className="bad" role="alert">Could not load files-agent data. Please try again later.</p>}
      </section>

      {data && <>
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Daily files-only summary</h2>
          {!durable ? (
            <p className="muted">Daily summary not generated yet.</p>
          ) : <>
            <p className="muted">
              {durable.summary.bounds.date} · {durable.summary.bounds.timezone} · Generated {generatedAt ? time(generatedAt) : '—'}
            </p>
            <div className="grid">
              <div><strong>{durable.summary.totals.events}</strong><br /><span className="muted">File actions</span></div>
              <div><strong>{durable.summary.totals.changedPaths}</strong><br /><span className="muted">Changed paths</span></div>
              <div><strong>{durable.summary.totals.users}</strong><br /><span className="muted">Users</span></div>
              <div><strong>{durable.summary.totals.devices}</strong><br /><span className="muted">Devices</span></div>
            </div>
            <p>{durable.summary.narrative}</p>
            <p className="muted smallNote">{durable.summary.privacy}</p>
            {durable.summary.users.map((user) => <article key={user.userId} style={{ marginTop: 12 }}>
              <h3>{user.user}</h3>
              <p className="muted">{user.events} actions · {user.changedPaths} paths · Agents: {Object.entries(user.agents).map(([name, count]) => `${name} (${count})`).join(', ') || 'none'}</p>
            </article>)}
          </>}
        </section>

        <section className="card" style={{ marginTop: 16 }}>
          <h2>Files-agent devices</h2>
          <div className="tableWrap"><table>
            <thead><tr><th>Owner</th><th>Device</th><th>Last seen</th><th>Status</th></tr></thead>
            <tbody>{data.devices.map((device) => <tr key={`${device.owner}:${device.device}`}>
              <td>{device.owner}</td><td>{device.device}</td><td>{time(device.lastSeenAt)}</td>
              <td className={device.revokedAt ? 'bad' : 'good'}>{device.revokedAt ? 'Revoked' : 'Active'}</td>
            </tr>)}</tbody>
          </table></div>
          {data.devices.length === 0 && <p className="muted">No files-agent devices enrolled.</p>}
        </section>

        <section className="card" style={{ marginTop: 16 }}>
          <h2>File changes</h2>
          <div className="cardFilters" aria-label="File change filters">
            <label>Owner<select value={owner} onChange={(event) => setOwner(event.target.value)}><option value="all">All owners</option>{owners.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>Agent<select value={agent} onChange={(event) => setAgent(event.target.value)}><option value="all">All approved agents</option>{agents.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>Action<select value={action} onChange={(event) => setAction(event.target.value)}><option value="all">All actions</option>{actions.map((value) => <option key={value}>{value}</option>)}</select></label>
          </div>
          <div className="tableWrap"><table>
            <thead><tr><th>Time</th><th>Owner</th><th>Device</th><th>Agent</th><th>Action</th><th>Project</th></tr></thead>
            <tbody>{events.map((event, index) => <tr key={`${event.capturedAt}:${event.owner}:${event.device}:${index}`}>
              <td>{time(event.capturedAt)}</td><td>{event.owner}</td><td>{event.device}</td><td>{event.agent}</td>
              <td>{event.action}</td><td><code>{event.project}</code></td>
            </tr>)}</tbody>
          </table></div>
          {events.length === 0 && <p className="muted">No file changes match these filters.</p>}
        </section>
      </>}
    </div>
  );
}
