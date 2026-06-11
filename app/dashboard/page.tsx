import { health, readDashboard } from '@/lib/db';

const demo = {
  users: [
    { email: 'hello@neodym.ai', role: 'admin', approval_status: 'approved', employee_username: null, created_at: 'seed' },
    { email: 'ibrahim@neodym.ai', role: 'employee', approval_status: 'pending', employee_username: 'ibrahim', created_at: 'seed' },
  ],
  devices: [] as any[],
  events: [] as any[],
};

export default async function Dashboard() {
  const h = health();
  let data = demo;
  let error = '';
  if (h.configured) {
    try { data = await readDashboard(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  return (
    <div>
      <section className="card">
        <span className="pill">Admin dashboard</span>
        <h1>Neodym activity</h1>
        {!h.configured && <p className="warn">DATABASE_URL is not configured yet, so this is showing the seeded cloud prototype only.</p>}
        {error && <p className="bad">Database error: {error}</p>}
      </section>
      <section className="card" style={{marginTop:16}}>
        <h2>Accounts</h2>
        <table className="table"><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>OS user</th></tr></thead><tbody>{data.users.map((u:any)=><tr key={u.email}><td>{u.email}</td><td>{u.role}</td><td>{u.approval_status}</td><td>{u.employee_username || '—'}</td></tr>)}</tbody></table>
      </section>
      <section className="card" style={{marginTop:16}}>
        <h2>Devices</h2>
        {data.devices.length === 0 ? <p className="muted">No enrolled devices yet. Ibrahim’s PC will appear here after the installer posts to /api/ingest.</p> : <table className="table"><thead><tr><th>Employee</th><th>Host</th><th>OS user</th><th>Last seen</th></tr></thead><tbody>{data.devices.map((d:any,i:number)=><tr key={i}><td>{d.employee_email}</td><td>{d.hostname}</td><td>{d.os_user}</td><td>{String(d.last_seen_at)}</td></tr>)}</tbody></table>}
      </section>
      <section className="card" style={{marginTop:16}}>
        <h2>Latest events</h2>
        {data.events.length === 0 ? <p className="muted">No uploaded events yet.</p> : <table className="table"><thead><tr><th>Time</th><th>Employee</th><th>Host</th><th>Type</th><th>App/window</th></tr></thead><tbody>{data.events.map((e:any,i:number)=><tr key={i}><td>{String(e.captured_at)}</td><td>{e.employee_email}</td><td>{e.hostname}</td><td>{e.event_type}</td><td>{[e.app_name,e.window_title,e.url].filter(Boolean).join(' · ')}</td></tr>)}</tbody></table>}
      </section>
    </div>
  );
}
