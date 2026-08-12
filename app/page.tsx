import { health } from '@/lib/db';

export default function Home() {
  const h = health();
  return (
    <div className="hero">
      <section className="card">
        <span className="pill">Files-only AI change tracking</span>
        <h1>See file metadata changed by approved AI coding agents.</h1>
        <p className="muted">Register a company, approve employee accounts, then enroll the files-only agent. It reports path, action, time, and device only when an approved Hermes, Codex, or Claude process tree changes a file. It never collects file contents, screens, input, audio, browser activity, or general computer activity.</p>
        <div className="grid">
          <div className="card"><div className="metricLabel">Step 1</div><div className="metric">Company</div><p className="muted">Validate the admin email domain with DNS and create the company.</p></div>
          <div className="card"><div className="metricLabel">Step 2</div><div className="metric">Admin</div><p className="muted">The first admin is approved automatically during company registration.</p></div>
          <div className="card"><div className="metricLabel">Step 3</div><div className="metric">Employees</div><p className="muted">Employees sign up with the registered company domain and wait for approval.</p></div>
          <div className="card"><div className="metricLabel">Database</div><div className={h.configured ? 'good' : 'warn'}>{h.configured ? 'Configured' : 'Needs DATABASE_URL'}</div></div>
        </div>
        <p><a className="button" href="/register">Register company + first admin</a></p>
      </section>
      <aside className="card">
        <h2>Operations</h2>
        <p className="muted">Use the dashboard for account approvals, files-agent enrollment, devices, and approved AI file-change metadata.</p>
        <p><a className="button" href="/dashboard">Open admin dashboard</a></p>
        <p><a className="button" href="/signup">Employee signup</a></p>
      </aside>
    </div>
  );
}
