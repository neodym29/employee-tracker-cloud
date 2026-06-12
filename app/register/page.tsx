'use client';

import { useState } from 'react';

export default function RegisterCompany() {
  const [companyName, setCompanyName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [message, setMessage] = useState('');
  const [ok, setOk] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setOk(false);
    setMessage('Checking domain and creating company…');
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_name: companyName, admin_email: adminEmail }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      setMessage(`Error: ${data.error || res.statusText}`);
      return;
    }
    setOk(true);
    setMessage(`${data.company?.domain || 'Company'} registered. ${data.admin?.email || adminEmail} is now the first approved admin.`);
  }

  return (
    <section className="card">
      <span className="pill">Company registration</span>
      <h1>Register the company first</h1>
      <p className="muted">Start fresh by registering a real company email domain. We verify the admin email domain has DNS records, create the company, and make this first user an approved admin. Employee signups come after this step.</p>
      <form onSubmit={submit}>
        <label>Company name<input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Neodym" required /></label>
        <label>First admin work email<input type="email" value={adminEmail} onChange={e => setAdminEmail(e.target.value)} placeholder="founder@company.com" required /></label>
        <button>Register company + first admin</button>
      </form>
      {message && <p className={ok ? 'good' : 'warn'}>{message}</p>}
      {ok && <p><a className="button" href="/signup">Continue to employee signup</a></p>}
    </section>
  );
}
