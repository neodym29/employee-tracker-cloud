'use client';

import { useMemo, useState } from 'react';

const typeLabels: Record<string, string> = {
  activity_snapshot: 'Active window',
  app_open: 'Open app',
  app_subwindow: 'App activity',
  browser_tab: 'Web surfing',
  input_click: 'Click',
  window_focus: 'Focus change',
  audio_output: 'Audio',
};

const timeWindows = [
  { label: 'Last 15 minutes', value: '15m', ms: 15 * 60 * 1000 },
  { label: 'Last hour', value: '1h', ms: 60 * 60 * 1000 },
  { label: 'Last 24 hours', value: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: 'Last 7 days', value: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: 'All time', value: 'all', ms: Infinity },
];

type DashboardData = {
  companies: any[];
  users: any[];
  devices: any[];
  events: any[];
};

function eventSummary(event: any): string {
  const payload = event.payload || {};
  if (event.event_type === 'input_click') return payload.target_hint || [event.app_name, event.window_title].filter(Boolean).join(' · ');
  if (event.event_type === 'browser_tab') return [payload.title || event.window_title, payload.url || event.url].filter(Boolean).join(' · ');
  if (event.event_type === 'audio_output') return [payload.application_name || event.app_name, payload.media_name, payload.state_hint, payload.mute && `mute=${payload.mute}`].filter(Boolean).join(' · ');
  if (event.event_type === 'window_focus') return `${payload.from_app_name || '—'} → ${payload.to_app_name || event.app_name || '—'} · ${payload.to_window_title || event.window_title || ''}`;
  if (event.event_type === 'app_open') return [payload.app_name || event.app_name, payload.window_count != null && `${payload.window_count} windows`, payload.subwindow_count != null && `${payload.subwindow_count} tabs/views`].filter(Boolean).join(' · ');
  return [event.app_name, event.window_title, event.url].filter(Boolean).join(' · ');
}

function eventsOf(data: DashboardData, types: string[]) {
  return data.events.filter((event: any) => types.includes(event.event_type));
}

function rowUser(row: any): string {
  return row.employee_email || row.email || row.os_user || row.employee_username || '';
}

function rowTime(row: any): string {
  return row.captured_at || row.received_at || row.last_seen_at || row.first_seen_at || row.created_at || row.approved_at || '';
}

function filteredRows(rows: any[], user: string, time: string) {
  const selectedWindow = timeWindows.find((window) => window.value === time) || timeWindows[timeWindows.length - 1];
  const cutoff = selectedWindow.ms === Infinity ? null : Date.now() - selectedWindow.ms;
  return rows.filter((row) => {
    const identity = rowUser(row);
    const matchesUser = user === 'all' || identity === user;
    const timestamp = rowTime(row);
    const matchesTime = !cutoff || !timestamp || new Date(timestamp).getTime() >= cutoff;
    return matchesUser && matchesTime;
  });
}

function EventsTable({ events, empty }: { events: any[]; empty: string }) {
  if (events.length === 0) return <p className="muted">{empty}</p>;
  return (
    <table className="table">
      <thead><tr><th>Time</th><th>Employee</th><th>Host</th><th>Type</th><th>Details</th></tr></thead>
      <tbody>{events.map((e:any,i:number)=><tr key={i}><td>{String(e.captured_at || e.received_at || '—')}</td><td>{e.employee_email}</td><td>{e.hostname}</td><td>{typeLabels[e.event_type] || e.event_type}</td><td>{eventSummary(e) || '—'}</td></tr>)}</tbody>
    </table>
  );
}

function FilteredCard({
  title,
  rows,
  users,
  empty,
  children,
  action,
}: {
  title: string;
  rows: any[];
  users: string[];
  empty: string;
  children: (rows: any[]) => React.ReactNode;
  action?: React.ReactNode;
}) {
  const [user, setUser] = useState('all');
  const [time, setTime] = useState('24h');
  const visibleRows = useMemo(() => filteredRows(rows, user, time), [rows, user, time]);

  return (
    <section className="card" style={{marginTop:16}}>
      <div className="cardHeader">
        <div>
          <h2>{title}</h2>
          <p className="muted smallNote">Showing {visibleRows.length} of {rows.length}</p>
        </div>
        <div className="cardFilters" data-card-filter="true">
          <label>
            User
            <select className="filter-card-user" value={user} onChange={(event) => setUser(event.target.value)}>
              <option value="all">All users</option>
              {users.map((option) => <option value={option} key={option}>{option}</option>)}
            </select>
          </label>
          <label>
            Time
            <select className="filter-card-time" value={time} onChange={(event) => setTime(event.target.value)}>
              {timeWindows.map((window) => <option value={window.value} key={window.value}>{window.label}</option>)}
            </select>
          </label>
        </div>
      </div>
      {visibleRows.length === 0 ? <p className="muted">{empty}</p> : children(visibleRows)}
      {action}
    </section>
  );
}

export default function DashboardClient({ data, configured, error }: { data: DashboardData; configured: boolean; error: string }) {
  const allUsers = useMemo(() => {
    const identities = [...data.users, ...data.devices, ...data.events].map(rowUser).filter(Boolean);
    return Array.from(new Set(identities)).sort();
  }, [data]);
  const clickEvents = eventsOf(data, ['input_click']);
  const webEvents = eventsOf(data, ['browser_tab']);
  const appEvents = eventsOf(data, ['app_open', 'app_subwindow', 'window_focus', 'activity_snapshot']);
  const audioEvents = eventsOf(data, ['audio_output']);

  return (
    <div>
      <section className="card">
        <span className="pill">Admin dashboard</span>
        <h1>Neodym activity</h1>
        {!configured && <p className="warn">DATABASE_URL is not configured yet, so this is showing the seeded cloud prototype only.</p>}
        {error && <p className="bad">Database error: {error}</p>}
      </section>

      <FilteredCard title="Companies" rows={data.companies} users={allUsers} empty="No companies registered in this filter." action={<p><a className="button" href="/register">Register company + first admin</a></p>}>
        {(rows) => <table className="table"><thead><tr><th>Name</th><th>Domain</th><th>Created</th></tr></thead><tbody>{rows.map((c:any)=><tr key={c.domain}><td>{c.name}</td><td>{c.domain}</td><td>{String(c.created_at)}</td></tr>)}</tbody></table>}
      </FilteredCard>

      <FilteredCard title="Accounts" rows={data.users} users={allUsers} empty="No accounts in this filter." action={<p><a className="button" href="/admin/approve">Approve employee / generate installer</a></p>}>
        {(rows) => <table className="table"><thead><tr><th>Email</th><th>Company</th><th>Role</th><th>Status</th><th>OS user</th><th>Token</th></tr></thead><tbody>{rows.map((u:any)=><tr key={u.email}><td>{u.email}</td><td>{u.company_domain || '—'}</td><td>{u.role}</td><td>{u.approval_status}</td><td>{u.employee_username || '—'}</td><td>{u.enrollment_token_hint || '—'}</td></tr>)}</tbody></table>}
      </FilteredCard>

      <FilteredCard title="Devices" rows={data.devices} users={allUsers} empty="No enrolled devices in this filter. Employee PCs appear here after the installer posts to /api/ingest.">
        {(rows) => <table className="table"><thead><tr><th>Employee</th><th>Host</th><th>OS user</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>{rows.map((d:any,i:number)=><tr key={i}><td>{d.employee_email}</td><td>{d.hostname}</td><td>{d.os_user}</td><td>{String(d.first_seen_at)}</td><td>{String(d.last_seen_at)}</td></tr>)}</tbody></table>}
      </FilteredCard>

      <FilteredCard title="Clicks" rows={clickEvents} users={allUsers} empty="No click events in this filter.">
        {(rows) => <EventsTable events={rows} empty="No click events uploaded yet." />}
      </FilteredCard>

      <FilteredCard title="Web surfing / browser tabs" rows={webEvents} users={allUsers} empty="No browser tab events in this filter. The employee must rerun the latest installer and restart browsers.">
        {(rows) => <EventsTable events={rows} empty="No browser tab events uploaded yet." />}
      </FilteredCard>

      <FilteredCard title="Open apps / app activity" rows={appEvents} users={allUsers} empty="No app activity in this filter.">
        {(rows) => <EventsTable events={rows} empty="No app activity uploaded yet." />}
      </FilteredCard>

      <FilteredCard title="Audio output" rows={audioEvents} users={allUsers} empty="No audio output events in this filter.">
        {(rows) => <EventsTable events={rows} empty="No audio output events uploaded yet." />}
      </FilteredCard>

      <FilteredCard title="Latest raw events" rows={data.events} users={allUsers} empty="No uploaded events in this filter.">
        {(rows) => <EventsTable events={rows} empty="No uploaded events yet." />}
      </FilteredCard>

      <section className="card" style={{marginTop:16}}>
        <h2>Keyboard</h2>
        <p className="muted">Raw keystroke/character capture is intentionally not enabled because it can collect passwords, private messages, and secrets. We can add safe typing telemetry such as keypress counts per app/window if needed.</p>
      </section>
    </div>
  );
}
