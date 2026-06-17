import InstallManual, { refreshCommand } from '@/app/components/InstallManual';
import { requireEmployeeOrAdminSession } from '@/lib/auth';
import { approvedEmployeeInstallerToken } from '@/lib/db';

function updateCommandFor(url: string, platform: 'linux') {
  return refreshCommand(url, platform);
}

export default async function Employee() {
  const session = await requireEmployeeOrAdminSession();
  const tokenRow = session.role === 'employee'
    ? await approvedEmployeeInstallerToken(session.email, session.company_id)
    : undefined;
  const base = process.env.NEXT_PUBLIC_APP_URL || '';
  const linuxPath = tokenRow?.enrollment_token
    ? `/api/installer?token=${tokenRow.enrollment_token}&platform=linux`
    : '';
  const linuxUrl = linuxPath && base ? `${base}${linuxPath}` : linuxPath;
  const extensionPath = tokenRow?.enrollment_token
    ? `/api/installer?token=${tokenRow.enrollment_token}&platform=linux&format=extension`
    : '';
  const extensionUrl = extensionPath && base ? `${base}${extensionPath}` : extensionPath;
  const firefoxExtensionPath = tokenRow?.enrollment_token
    ? `/api/installer?token=${tokenRow.enrollment_token}&platform=linux&format=firefox-extension`
    : '';
  const firefoxExtensionUrl = firefoxExtensionPath && base ? `${base}${firefoxExtensionPath}` : firefoxExtensionPath;

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
              <p className="muted">Linux is the only supported installer shown for now. Install the native app first, then use the browser extension ZIP only if managed browser policy auto-install does not show the extension after browser restart.</p>
              <div className="grid">
                <div className="card">
                  <h2>Linux</h2>
                  <p><a className="button" href={linuxPath}>Download your Linux tracker app</a></p>
                  <p><a href={linuxPath}>{linuxUrl}</a></p>
                  <p className="muted">The Linux installer installs the native tracker service and attempts to auto-install the extension into Chrome, Brave, Edge, Chromium, Opera, and Vivaldi using managed policies when sudo is available.</p>
                  <p><a className="button secondary" href={extensionPath}>Download browser extension ZIP (Chromium)</a></p>
                  <p><a href={extensionPath}>{extensionUrl}</a></p>
                  <p><a className="button secondary" href={firefoxExtensionPath}>Download Firefox add-on XPI</a></p>
                  <p><a href={firefoxExtensionPath}>{firefoxExtensionUrl}</a></p>
                  <p className="muted">Already installed? Use Refresh existing app / refresh-neodym-tracker from the manual below to update the native app and browser extension package without re-approval.</p>
                  <details className="install-manual-details" open>
                    <summary className="button">Open full Linux install manual</summary>
                    <InstallManual url={linuxUrl} extensionUrl={extensionUrl} firefoxExtensionUrl={firefoxExtensionUrl} platform="linux" context="employee" />
                  </details>
                </div>
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
