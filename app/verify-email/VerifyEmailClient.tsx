'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';

export default function VerifyEmailClient() {
  const token = useSearchParams().get('token');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  async function verify() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/profile/verify-email', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Verification failed');
      setDone(true);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="verifyEmailPage"><h1>Verify your email</h1>
    {done ? <><p>Your email is verified. The blue badge is now on your profile.</p><a className="primaryButton" href="/profile">View profile</a></> : <><p>Confirm that this is the address you use for Neo Nexus.</p><button type="button" disabled={!token || busy} onClick={() => void verify()}>{busy ? 'Verifying…' : 'Verify email'}</button>{!token && <p role="alert">This verification link is missing its token.</p>}{error && <p role="alert">{error}</p>}</>}
  </div>;
}
