'use client';

import { useMemo, useState } from 'react';

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

type InstallerPlatform = 'linux' | 'macos' | 'windows';

type ApprovalResult = {
  ok?: boolean;
  email?: string;
  installer_url?: string;
  platform?: InstallerPlatform;
  error?: string;
  message?: string;
};

function installerCommand(url: string, platform: InstallerPlatform | undefined) {
  if (platform === 'windows') return `Download the .cmd file, then double-click it. If Windows SmartScreen appears, choose More info → Run anyway.`;
  return `curl -fsSL '${url}' -o install-neodym-tracker.sh\nbash install-neodym-tracker.sh`;
}

function updateCommand(url: string, platform: InstallerPlatform | undefined) {
  if (platform === 'windows') {
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${url}' -OutFile $env:TEMP\\refresh-neodym-tracker.cmd; & $env:TEMP\\refresh-neodym-tracker.cmd"`;
  }
  return `curl -fsSL '${url}' -o refresh-neodym-tracker.sh\nbash refresh-neodym-tracker.sh`;
}

export default function ApprovalClient({ users }: { users: UserRow[] }) {
  const [rows, setRows] = useState(users);
  const [busyEmail, setBusyEmail] = useState('');
  const [installerPlatform, setInstallerPlatform] = useState<InstallerPlatform>('linux');
  const [result, setResult] = useState<ApprovalResult | null>(null);

  const employees = useMemo(
    () => rows.filter((user) => user.role === 'employee'),
    [rows],
  );
  const pendingCount = employees.filter((user) => user.approval_status === 'pending').length;

  async function approve(email: string) {
    setBusyEmail(email);
    setResult({ message: `Approving ${email}…` });
    try {
      const res = await fetch('/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, platform: installerPlatform }),
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
        <p className="muted">You are signed in as an admin. Approve employees directly from the signup list.</p>
        <p className={pendingCount ? 'warn' : 'good'}>
          {pendingCount ? `${pendingCount} employee${pendingCount === 1 ? '' : 's'} waiting for approval` : 'No pending approvals'}
        </p>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Signup requests</h2>
        <div className="cardFilters" style={{ marginBottom: 12 }}>
          <label>
            Installer OS
            <select className="installer-platform" value={installerPlatform} onChange={(event) => setInstallerPlatform(event.target.value as InstallerPlatform)}>
              <option value="linux">Linux</option>
              <option value="macos">macOS</option>
              <option value="windows">Windows</option>
            </select>
          </label>
        </div>
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
          <pre>{installerCommand(result.installer_url, result.platform)}</pre>
          <details className="refresh-package">
            <summary className="button">Refresh existing app</summary>
            <p className="muted">If this employee already installed the tracker, send them this command to pull the latest package and restart/update the app without re-approval.</p>
            <pre>{updateCommand(result.installer_url, result.platform)}</pre>
          </details>
        </section>
      )}
    </>
  );
}
