'use client';

import { useState } from 'react';

type AccountType = 'client' | 'engineer';

export default function Signup() {
  const [accountType, setAccountType] = useState<AccountType>('client');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [existingAccount, setExistingAccount] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setExistingAccount(false);
    setMessage('Submitting...');
    const response = await fetch('/api/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountType, displayName, email, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409) {
      setExistingAccount(true);
      setMessage('An account already exists for this email. Sign in instead.');
      return;
    }
    if (!response.ok || !data.ok) { setMessage(data.error || 'Signup failed. Please try again.'); return; }
    setDone(true);
    setMessage('Your account is pending approval. You can sign in after an admin approves it.');
  }

  return (
    <section className="card authCard">
      <span className="pill">Join Trace</span>
      <h1>Create your account</h1>
      <p className="muted">Choose how you will use Trace. Every new account is reviewed before sign in. The optional files-only dashboard shows file-change metadata from approved Hermes, Codex, or Claude agents and never file contents.</p>
      {done ? <div className="successPanel" role="status"><h2>Request received</h2><p>{message}</p><a className="secondaryButton" href="/login">Go to sign in</a></div> : (
        <form onSubmit={submit}>
          <fieldset className="rolePicker"><legend>I am a</legend>
            <label className={accountType === 'client' ? 'roleCard selected' : 'roleCard'}><input type="radio" name="accountType" value="client" checked={accountType === 'client'} onChange={() => setAccountType('client')} /><strong>Client</strong><span>Create projects and invite engineers.</span></label>
            <label className={accountType === 'engineer' ? 'roleCard selected' : 'roleCard'}><input type="radio" name="accountType" value="engineer" checked={accountType === 'engineer'} onChange={() => setAccountType('engineer')} /><strong>Engineer</strong><span>Find open projects and collaborate.</span></label>
          </fieldset>
          <label>Display name<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} autoComplete="name" required /></label>
          <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></label>
          <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} autoComplete="new-password" required /></label>
          <button type="submit">Submit for approval</button>
          {message && <p className="bad" role="alert">{message}</p>}
          {existingAccount && <a className="secondaryButton" href="/login">Sign in</a>}
        </form>
      )}
    </section>
  );
}
