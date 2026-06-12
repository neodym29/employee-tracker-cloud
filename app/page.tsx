import { health } from '@/lib/db';

export default function Home() {
  const h = health();
  return (
    <div className="hero">
      <section className="card">
        <span className="pill">Cloud prototype · fresh company onboarding</span>
        <h1>Start with company registration, then enroll employees.</h1>
        <p className="muted">The tracker code is working, so the cloud flow now starts clean: register a company using a real work-email domain, create the first approved admin, then let employees request access and receive installers after approval.</p>
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
        <p className="muted">Use the dashboard for accounts, approvals, installers, and uploaded activity.</p>
        <p><a className="button" href="/dashboard">Open admin dashboard</a></p>
        <p><a className="button" href="/signup">Employee signup</a></p>
      </aside>
    </div>
  );
}
