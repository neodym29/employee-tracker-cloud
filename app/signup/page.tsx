'use client';

import { useState } from 'react';

export default function Signup() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage('Submitting…');
    const res = await fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const data = await res.json().catch(() => ({}));
    setMessage(data.ok ? `${data.email} is pending admin approval for ${data.company_domain}.` : `Error: ${data.error || res.statusText}`);
  }
  return (
    <section className="card">
      <span className="pill">Employee signup</span>
      <h1>Request access</h1>
      <p className="muted">Employees sign up after their company and first admin are registered. Use your company work email; the domain must match an existing registered company. After admin approval, you receive an installer that connects this PC to the cloud dashboard.</p>
      <form onSubmit={submit}>
        <label>Work email<input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="employee@company.com" required /></label>
        <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" minLength={8} required /></label>
        <button>Submit for approval</button>
      </form>
      {message && <p className="warn">{message}</p>}
    </section>
  );
}
