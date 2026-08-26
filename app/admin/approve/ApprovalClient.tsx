'use client';

import { useState } from 'react';

type Approval = { id: string; display_name: string; email: string; account_type: 'client' | 'engineer'; created_at: string };

export default function ApprovalClient({ initialApprovals, unavailable }: { initialApprovals: Approval[]; unavailable: boolean }) {
  const [rows, setRows] = useState(initialApprovals);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function review(user: Approval, action: 'approve' | 'reject') {
    setBusy(user.id); setError('');
    const response = await fetch(`/api/admin/approvals/${user.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) setError(data.error || 'The account could not be reviewed.');
    else setRows((current) => current.filter((row) => row.id !== user.id));
    setBusy('');
  }

  return <div className="dashboardShell">
    <div className="dashboardHeading"><div><span className="pill">Platform admin</span><h1>Account approvals</h1><p>Review pending client and engineer accounts.</p></div></div>
    {unavailable && <div className="errorBanner" role="alert"><p>Approvals are temporarily unavailable.</p><button type="button" className="secondaryButton" onClick={() => window.location.reload()}>Retry</button></div>}
    {error && <p className="errorBanner" role="alert">{error}</p>}
    <section className="dashboardPanel">
      <div className="panelHeader"><h2>Pending accounts</h2><span className="muted">{rows.length} waiting</span></div>
      {rows.length === 0 ? <div className="emptyState"><h3>No pending approvals</h3><p>New signup requests will appear here.</p></div> : <div className="approvalList">{rows.map((user) => <article className="approvalRow" key={user.id}><div><strong>{user.display_name}</strong><span>{user.email}</span></div><span className="statusBadge">{user.account_type}</span><div className="rowActions"><button disabled={Boolean(busy)} onClick={() => review(user, 'approve')}>{busy === user.id ? 'Working...' : 'Approve'}</button><button className="secondaryButton" disabled={Boolean(busy)} onClick={() => review(user, 'reject')}>Reject</button></div></article>)}</div>}
    </section>
  </div>;
}
