'use client';

import { useState } from 'react';

export default function AdminApprove() {
  const [email, setEmail] = useState('ibrahim@neodym.ai');
  const [key, setKey] = useState('');
  const [result, setResult] = useState<any>(null);
  async function approve(e: React.FormEvent) {
    e.preventDefault();
    setResult({ message: 'Approving…' });
    const res = await fetch('/api/approve', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-setup-key': key }, body: JSON.stringify({ email }) });
    const data = await res.json().catch(() => ({}));
    setResult(data.ok ? data : { error: data.error || res.statusText });
  }
  return (
    <section className="card">
      <span className="pill">Admin approval</span>
      <h1>Approve employee device</h1>
      <p className="muted">Enter the private ADMIN_SETUP_KEY from the server env. Approval generates a one-device installer URL for the employee.</p>
      <form onSubmit={approve}>
        <label>Employee email<input type="email" value={email} onChange={e => setEmail(e.target.value)} required /></label>
        <label>Admin setup key<input type="password" value={key} onChange={e => setKey(e.target.value)} required /></label>
        <button>Approve and generate installer</button>
      </form>
      {result?.message && <p className="warn">{result.message}</p>}
      {result?.error && <p className="bad">{result.error}</p>}
      {result?.installer_url && <div className="card" style={{marginTop:16}}><h2>Installer URL</h2><p><a href={result.installer_url}>{result.installer_url}</a></p><pre>{`curl -fsSL '${result.installer_url}' -o install-neodym-tracker.sh
bash install-neodym-tracker.sh`}</pre></div>}
    </section>
  );
}
