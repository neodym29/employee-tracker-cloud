import { requireEmployeeOrAdminSession } from '@/lib/auth';
import { approvedEmployeeInstallerToken } from '@/lib/db';

function commandFor(url: string, platform: 'linux' | 'macos' | 'windows') {
  if (platform === 'windows') return `Invoke-WebRequest '${url}' -OutFile install-neodym-tracker.ps1\npowershell -ExecutionPolicy Bypass -File .\\install-neodym-tracker.ps1`;
  return `curl -fsSL '${url}' -o install-neodym-tracker.sh\nbash install-neodym-tracker.sh`;
}

export default async function Employee() {
  const session = await requireEmployeeOrAdminSession();
  const tokenRow = session.role === 'employee'
    ? await approvedEmployeeInstallerToken(session.email, session.company_id)
    : undefined;
  const base = process.env.NEXT_PUBLIC_APP_URL || '';
  const platforms = [
    { key: 'windows', label: 'Windows', ext: 'ps1' },
    { key: 'macos', label: 'macOS', ext: 'sh' },
    { key: 'linux', label: 'Linux', ext: 'sh' },
  ] as const;

  return (
    <>
      <section className="card">
        <span className="pill">Employee setup</span>
        <h1>Welcome, {session.email}</h1>
        <p className="muted">Company: {session.company_domain}</p>
        {session.role === 'admin' ? <p><a className="button" href="/dashboard">Open admin dashboard</a></p> : <p className="good">Employee portal access only — admin pages require an admin account.</p>}
      </section>

      {session.role === 'employee' && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Download your tracker app</h2>
          {tokenRow?.enrollment_token ? (
            <>
              <p className="muted">Choose the operating system for this computer. Download and run that installer only.</p>
              <div className="grid">
                {platforms.map((platform) => {
                  const path = `/api/installer?token=${tokenRow.enrollment_token}&platform=${platform.key}`;
                  const url = base ? `${base}${path}` : path;
                  return (
                    <div className="card" key={platform.key}>
                      <h2>{platform.label}</h2>
                      <p><a className="button" href={path}>Download {platform.label} installer</a></p>
                      <p><a href={path}>{url}</a></p>
                      <pre>{commandFor(url, platform.key)}</pre>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <p className="warn">Your account is signed in, but it is not approved yet. Once an admin approves you, your OS-specific installers will appear here.</p>
          )}
        </section>
      )}
    </>
  );
}
