'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function LoginForm() {
  const params = useSearchParams();
  const next = params.get('next') || '/dashboard';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage('Signing in…');
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      setMessage(`Error: ${data.error || res.statusText}`);
      return;
    }
    window.location.href = data.user?.role === 'admin' ? next : '/employee';
  }

  return (
    <section className="card">
      <span className="pill">Login</span>
      <h1>Sign in</h1>
      <p className="muted">Admins can access the dashboard and approvals. Employees can sign in to their employee area after approval.</p>
      <form onSubmit={submit}>
        <label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" required /></label>
        <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Your password" required /></label>
        <button>Sign in</button>
      </form>
      {message && <p className="warn">{message}</p>}
    </section>
  );
}

export default function Login() {
  return (
    <Suspense fallback={<section className="card"><p className="muted">Loading login…</p></section>}>
      <LoginForm />
    </Suspense>
  );
}
