import { health } from '@/lib/db';

export default function Home() {
  const h = health();
  return (
    <div className="hero">
      <section className="card">
        <span className="pill">Cloud prototype · neodym.ai</span>
        <h1>Employee tracker, wired for real device enrollment.</h1>
        <p className="muted">This Vercel-safe version separates the admin UI from local SQLite. Employees sign up, admins approve them, and the generated installer downloads the tracker code plus dependencies and enrolls the PC against the cloud ingest API backed by Postgres/Supabase.</p>
        <div className="grid">
          <div className="card"><div className="metricLabel">Admin</div><div className="metric">hello@neodym.ai</div></div>
          <div className="card"><div className="metricLabel">Employee test</div><div className="metric">ibrahim@neodym.ai</div></div>
          <div className="card"><div className="metricLabel">Database</div><div className={h.configured ? 'good' : 'warn'}>{h.configured ? 'Configured' : 'Needs DATABASE_URL'}</div></div>
          <div className="card"><div className="metricLabel">Ingest auth</div><div className={h.hasIngestKey ? 'good' : 'warn'}>{h.hasIngestKey ? 'Configured' : 'Needs INGEST_API_KEY'}</div></div>
        </div>
      </section>
      <aside className="card">
        <h2>Deployment readiness</h2>
        <p className="muted">The app can deploy to Vercel now. Cross-PC reporting becomes real when these env vars are attached:</p>
        <pre>{`DATABASE_URL=postgres://...
INGEST_API_KEY=<shared install token>
ADMIN_SETUP_KEY=<schema bootstrap token>`}</pre>
        <p><a className="button" href="/dashboard">Open admin dashboard</a></p>
      </aside>
    </div>
  );
}
