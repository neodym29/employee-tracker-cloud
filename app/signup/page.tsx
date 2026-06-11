'use client';

import { useState } from 'react';

export default function Signup() {
  const [email, setEmail] = useState('ibrahim@neodym.ai');
  const [message, setMessage] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage('Submitting…');
    const res = await fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    const data = await res.json().catch(() => ({}));
    setMessage(data.ok ? `${data.email} is pending admin approval.` : `Error: ${data.error || res.statusText}`);
  }
  return (
    <section className="card">
      <span className="pill">Employee signup</span>
      <h1>Request access</h1>
      <p className="muted">Employees sign up with their neodym.ai email. After admin approval, they receive an installer that downloads the tracker code, installs dependencies, and connects this PC to the cloud server.</p>
      <form onSubmit={submit}>
        <label>Work email<input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="ibrahim@neodym.ai" required /></label>
        <button>Submit for approval</button>
      </form>
      {message && <p className="warn">{message}</p>}
    </section>
  );
}
