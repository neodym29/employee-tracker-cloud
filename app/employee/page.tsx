import { requireEmployeeOrAdminSession } from '@/lib/auth';

export default async function Employee() {
  const session = await requireEmployeeOrAdminSession();
  return (
    <section className="card">
      <span className="pill">Employee setup</span>
      <h1>Welcome, {session.email}</h1>
      <p className="muted">Your employee account is signed in. After an admin approves you, the admin dashboard can generate your device installer from the approval screen.</p>
      <p className="muted">Company: {session.company_domain}</p>
      {session.role === 'admin' ? <p><a className="button" href="/dashboard">Open admin dashboard</a></p> : <p className="good">Employee portal access only — admin pages require an admin account.</p>}
    </section>
  );
}
