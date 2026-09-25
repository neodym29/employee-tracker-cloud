'use client';

import { useState } from 'react';

type Approval = { id: string; display_name: string; email: string; account_type: 'client' | 'engineer'; created_at: string };

export default function ApprovalClient({ initialApprovals, unavailable }: { initialApprovals: Approval[]; unavailable: boolean }) {
  const [rows, setRows] = useState(initialApprovals);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accountType, setAccountType] = useState<'client' | 'engineer'>('engineer');
  const [created, setCreated] = useState('');

  async function createAccount(event: React.FormEvent) {
    event.preventDefault(); setBusy('create'); setError(''); setCreated('');
    const response = await fetch('/api/admin/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName, email, password, accountType }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) setError(data.error || 'The account could not be created.');
    else {
      setCreated(`${data.account.display_name} can sign in now as a ${data.account.account_type}.`);
      setDisplayName(''); setEmail(''); setPassword(''); setAccountType('engineer');
    }
    setBusy('');
  }

  async function review(user: Approval, action: 'approve' | 'reject') {
    setBusy(user.id); setError('');
    const response = await fetch(`/api/admin/approvals/${user.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) setError(data.error || 'The account could not be reviewed.');
    else setRows((current) => current.filter((row) => row.id !== user.id));
    setBusy('');
  }

  return <div className="dashboardShell">
    <div className="dashboardHeading"><div><span className="pill">Platform admin</span><h1>Accounts</h1><p>Create approved accounts directly or review signup requests.</p></div></div>
    {unavailable && <div className="errorBanner" role="alert"><p>Approvals are temporarily unavailable.</p><button type="button" className="secondaryButton" onClick={() => window.location.reload()}>Retry</button></div>}
    {error && <p className="errorBanner" role="alert">{error}</p>}
    {created && <p className="noticeBanner" role="status">{created}</p>}
    <section className="dashboardPanel adminAccountCreator" aria-labelledby="create-account-title">
      <div className="panelHeader"><div><span className="sectionLabel">Admin control</span><h2 id="create-account-title">Create an approved account</h2></div><span className="muted">No separate approval step</span></div>
      <form onSubmit={createAccount} aria-busy={busy === 'create'}>
        <label>Display name<input required maxLength={120} autoComplete="off" value={displayName} disabled={busy === 'create'} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label>Work email<input required type="email" maxLength={320} autoComplete="off" value={email} disabled={busy === 'create'} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Temporary password<input required type="password" minLength={8} maxLength={1024} autoComplete="new-password" value={password} disabled={busy === 'create'} onChange={(event) => setPassword(event.target.value)} /></label>
        <label>Account type<select value={accountType} disabled={busy === 'create'} onChange={(event) => setAccountType(event.target.value as 'client' | 'engineer')}><option value="engineer">Engineer</option><option value="client">Client</option></select></label>
        <button disabled={busy === 'create'}>{busy === 'create' ? 'Creating account…' : 'Create approved account'}</button>
      </form>
    </section>
    <section className="dashboardPanel">
      <div className="panelHeader"><h2>Pending accounts</h2><span className="muted">{rows.length} waiting</span></div>
      {rows.length === 0 ? <div className="emptyState"><h3>No pending approvals</h3><p>New signup requests will appear here.</p></div> : <div className="approvalList">{rows.map((user) => <article className="approvalRow" key={user.id}><div><strong>{user.display_name}</strong><span>{user.email}</span></div><span className="statusBadge">{user.account_type}</span><div className="rowActions"><button disabled={Boolean(busy)} onClick={() => review(user, 'approve')}>{busy === user.id ? 'Working...' : 'Approve'}</button><button className="secondaryButton" disabled={Boolean(busy)} onClick={() => review(user, 'reject')}>Reject</button></div></article>)}</div>}
    </section>
  </div>;
}
