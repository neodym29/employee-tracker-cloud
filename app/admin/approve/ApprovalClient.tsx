'use client';

import { useEffect, useMemo, useState } from 'react';

type UserRow = {
  email: string;
  role: string;
  approval_status: string;
  employee_username?: string | null;
  created_at?: string;
  approved_at?: string | null;
  company_domain?: string | null;
  enrollment_token_hint?: string | null;
};

type ApprovalResult = {
  ok?: boolean;
  email?: string;
  installer_url?: string;
  error?: string;
  message?: string;
};

export default function ApprovalClient({ users }: { users: UserRow[] }) {
  const [key, setKey] = useState('');
  const [rows, setRows] = useState(users);
  const [busyEmail, setBusyEmail] = useState('');
  const [result, setResult] = useState<ApprovalResult | null>(null);

  useEffect(() => {
    setKey(window.localStorage.getItem('neodym_admin_setup_key') || '');
  }, []);

  useEffect(() => {
    if (key) window.localStorage.setItem('neodym_admin_setup_key', key);
  }, [key]);

  const employees = useMemo(
    () => rows.filter((user) => user.role === 'employee'),
    [rows],
  );
  const pendingCount = employees.filter((user) => user.approval_status === 'pending').length;

  async function approve(email: string) {
    if (!key.trim()) {
      setResult({ error: 'Paste the admin setup key once at the top, then click Approve.' });
      return;
    }
    setBusyEmail(email);
    setResult({ message: `Approving ${email}…` });
    try {
      const res = await fetch('/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-setup-key': key.trim() },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setResult({ error: data.error || res.statusText || 'Approval failed' });
        return;
      }
      setRows((current) => current.map((user) => (
        user.email === email
          ? { ...user, approval_status: 'approved', enrollment_token_hint: user.enrollment_token_hint || 'generated…' }
          : user
      )));
      setResult(data);
    } finally {
      setBusyEmail('');
    }
  }

  return (
    <>
      <section className="card">
        <span className="pill">Admin approval</span>
        <h1>Approve employees</h1>
        <p className="muted">Paste the admin key once. Then approve people directly from the signup list.</p>
        <label>
          Admin setup key
          <input
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="Paste admin key once"
            autoComplete="off"
          />
        </label>
        <p className={pendingCount ? 'warn' : 'good'}>
          {pendingCount ? `${pendingCount} employee${pendingCount === 1 ? '' : 's'} waiting for approval` : 'No pending approvals'}
        </p>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Signup requests</h2>
        {employees.length === 0 ? (
          <p className="muted">No employee signups yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Company</th>
                <th>Status</th>
                <th>Username</th>
                <th>Token</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((user) => {
                const approved = user.approval_status === 'approved';
                return (
                  <tr key={user.email}>
                    <td>{user.email}</td>
                    <td>{user.company_domain || '—'}</td>
                    <td className={approved ? 'good' : 'warn'}>{user.approval_status}</td>
                    <td>{user.employee_username || '—'}</td>
                    <td>{user.enrollment_token_hint || '—'}</td>
                    <td>
                      {approved ? (
                        <button type="button" onClick={() => approve(user.email)} disabled={busyEmail === user.email}>
                          {busyEmail === user.email ? 'Generating…' : 'Get installer'}
                        </button>
                      ) : (
                        <button type="button" onClick={() => approve(user.email)} disabled={busyEmail === user.email}>
                          {busyEmail === user.email ? 'Approving…' : 'Approve'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {result?.message && <p className="warn">{result.message}</p>}
      {result?.error && <p className="bad">{result.error}</p>}
      {result?.installer_url && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Installer for {result.email}</h2>
          <p><a href={result.installer_url}>{result.installer_url}</a></p>
          <pre>{`curl -fsSL '${result.installer_url}' -o install-neodym-tracker.sh
bash install-neodym-tracker.sh`}</pre>
        </section>
      )}
    </>
  );
}
