'use client';

import { useMemo, useState } from 'react';

type UserRow = {
  email: string;
  role: string;
  approval_status: string;
  employee_username?: string | null;
  company_domain?: string | null;
};

export default function ApprovalClient({ users }: { users: UserRow[] }) {
  const [rows, setRows] = useState(users);
  const [busyEmail, setBusyEmail] = useState('');
  const [error, setError] = useState('');
  const employees = useMemo(() => rows.filter((user) => user.role === 'employee'), [rows]);
  const pendingCount = employees.filter((user) => user.approval_status === 'pending').length;

  async function approve(email: string) {
    setBusyEmail(email);
    setError('');
    try {
      const response = await fetch('/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || 'Approval failed');
      setRows((current) => current.map((user) => user.email === email ? { ...user, approval_status: 'approved' } : user));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Approval failed');
    } finally {
      setBusyEmail('');
    }
  }

  return (
    <>
      <section className="card">
        <span className="pill">Admin approval</span>
        <h1>Approve employees</h1>
        <p className="muted">Approval grants access to the files-only agent package. No legacy tracker package is generated.</p>
        <p className={pendingCount ? 'warn' : 'good'}>{pendingCount ? `${pendingCount} employee${pendingCount === 1 ? '' : 's'} waiting for approval` : 'No pending approvals'}</p>
      </section>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Signup requests</h2>
        {employees.length === 0 ? <p className="muted">No employee signups yet.</p> : (
          <div className="tableWrap">
            <table>
              <thead><tr><th>Employee</th><th>Company</th><th>Status</th><th>Username</th><th>Action</th></tr></thead>
              <tbody>{employees.map((user) => {
                const approved = user.approval_status === 'approved';
                return <tr key={user.email}>
                  <td>{user.email}</td><td>{user.company_domain || '—'}</td>
                  <td className={approved ? 'good' : 'warn'}>{user.approval_status}</td>
                  <td>{user.employee_username || '—'}</td>
                  <td>{approved ? <span className="good">Approved</span> : <button type="button" onClick={() => approve(user.email)} disabled={Boolean(busyEmail)}>{busyEmail === user.email ? 'Approving…' : 'Approve'}</button>}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        )}
        {error && <p className="bad" role="alert">{error}</p>}
      </section>
    </>
  );
}
