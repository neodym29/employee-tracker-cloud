import { health, readDashboard } from '@/lib/db';
import { requireAdminSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const demo = {
  companies: [] as any[],
  users: [] as any[],
  devices: [] as any[],
  events: [] as any[],
};

const typeLabels: Record<string, string> = {
  activity_snapshot: 'Active window',
  app_open: 'Open app',
  app_subwindow: 'App activity',
  browser_tab: 'Web surfing',
  input_click: 'Click',
  window_focus: 'Focus change',
  audio_output: 'Audio',
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

function eventsOf(data: any, types: string[]) {
  return data.events.filter((event: any) => types.includes(event.event_type));
}

function EventsTable({ events, empty }: { events: any[]; empty: string }) {
  if (events.length === 0) return <p className="muted">{empty}</p>;
  return (
    <table className="table">
      <thead><tr><th>Time</th><th>Employee</th><th>Host</th><th>Type</th><th>Details</th></tr></thead>
      <tbody>{events.map((e:any,i:number)=><tr key={i}><td>{String(e.captured_at)}</td><td>{e.employee_email}</td><td>{e.hostname}</td><td>{typeLabels[e.event_type] || e.event_type}</td><td>{eventSummary(e) || '—'}</td></tr>)}</tbody>
    </table>
  );
}

export default async function Dashboard() {
  await requireAdminSession();
  const h = health();
  let data = demo;
  let error = '';
  if (h.configured) {
    try { data = await readDashboard(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  const clickEvents = eventsOf(data, ['input_click']);
  const webEvents = eventsOf(data, ['browser_tab']);
  const appEvents = eventsOf(data, ['app_open', 'app_subwindow', 'window_focus', 'activity_snapshot']);
  const audioEvents = eventsOf(data, ['audio_output']);
  return (
    <div>
      <section className="card">
        <span className="pill">Admin dashboard</span>
        <h1>Neodym activity</h1>
        {!h.configured && <p className="warn">DATABASE_URL is not configured yet, so this is showing the seeded cloud prototype only.</p>}
        {error && <p className="bad">Database error: {error}</p>}
      </section>
      <section className="card" style={{marginTop:16}}>
        <h2>Companies</h2>
        {data.companies.length === 0 ? <p className="muted">No companies registered yet. Start with company registration.</p> : <table className="table"><thead><tr><th>Name</th><th>Domain</th><th>Created</th></tr></thead><tbody>{data.companies.map((c:any)=><tr key={c.domain}><td>{c.name}</td><td>{c.domain}</td><td>{String(c.created_at)}</td></tr>)}</tbody></table>}
        <p><a className="button" href="/register">Register company + first admin</a></p>
      </section>
      <section className="card" style={{marginTop:16}}>
        <h2>Accounts</h2>
        <p><a className="button" href="/admin/approve">Approve employee / generate installer</a></p>
        <table className="table"><thead><tr><th>Email</th><th>Company</th><th>Role</th><th>Status</th><th>OS user</th><th>Token</th></tr></thead><tbody>{data.users.map((u:any)=><tr key={u.email}><td>{u.email}</td><td>{u.company_domain || '—'}</td><td>{u.role}</td><td>{u.approval_status}</td><td>{u.employee_username || '—'}</td><td>{u.enrollment_token_hint || '—'}</td></tr>)}</tbody></table>
      </section>
      <section className="card" style={{marginTop:16}}>
        <h2>Devices</h2>
        {data.devices.length === 0 ? <p className="muted">No enrolled devices yet. Employee PCs appear here after the installer posts to /api/ingest.</p> : <table className="table"><thead><tr><th>Employee</th><th>Host</th><th>OS user</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>{data.devices.map((d:any,i:number)=><tr key={i}><td>{d.employee_email}</td><td>{d.hostname}</td><td>{d.os_user}</td><td>{String(d.first_seen_at)}</td><td>{String(d.last_seen_at)}</td></tr>)}</tbody></table>}
      </section>
      <section className="card" style={{marginTop:16}}>
        <h2>Clicks</h2>
        <EventsTable events={clickEvents} empty="No click events uploaded yet." />
      </section>
      <section className="card" style={{marginTop:16}}>
        <h2>Web surfing / browser tabs</h2>
        <EventsTable events={webEvents} empty="No browser tab events uploaded yet. The employee must rerun the latest installer and restart browsers." />
      </section>
      <section className="card" style={{marginTop:16}}>
        <h2>Open apps / app activity</h2>
        <EventsTable events={appEvents} empty="No app activity uploaded yet." />
      </section>
      <section className="card" style={{marginTop:16}}>
        <h2>Audio output</h2>
        <EventsTable events={audioEvents} empty="No audio output events uploaded yet." />
      </section>
      <section className="card" style={{marginTop:16}}>
        <h2>Latest raw events</h2>
        <EventsTable events={data.events} empty="No uploaded events yet." />
      </section>
      <section className="card" style={{marginTop:16}}>
        <h2>Keyboard</h2>
        <p className="muted">Raw keystroke/character capture is intentionally not enabled because it can collect passwords, private messages, and secrets. We can add safe typing telemetry such as keypress counts per app/window if needed.</p>
      </section>
    </div>
  );
}
