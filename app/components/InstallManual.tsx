type InstallerPlatform = 'linux' | 'macos' | 'windows';

type InstallManualProps = {
  url: string;
  platform: InstallerPlatform | undefined;
  context?: 'employee' | 'admin';
};

export function installCommand(url: string, platform: InstallerPlatform | undefined) {
  if (platform === 'windows') return `1. Click the installer link and save the .cmd file.\n2. Double-click the downloaded .cmd file.\n3. If Windows SmartScreen appears, choose More info → Run anyway.\n4. Leave the terminal window open until it says the PC is enrolled.`;
  return `curl -fsSL '${url}' -o install-neodym-tracker.sh\nbash install-neodym-tracker.sh`;
}

export function refreshCommand(url: string, platform: InstallerPlatform | undefined) {
  if (platform === 'windows') {
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${url}' -OutFile $env:TEMP\\refresh-neodym-tracker.cmd; & $env:TEMP\\refresh-neodym-tracker.cmd"`;
  }
  return `curl -fsSL '${url}' -o refresh-neodym-tracker.sh\nbash refresh-neodym-tracker.sh`;
}

function platformLabel(platform: InstallerPlatform | undefined) {
  if (platform === 'windows') return 'Windows';
  if (platform === 'macos') return 'macOS';
  return 'Linux';
}

export default function InstallManual({ url, platform, context = 'employee' }: InstallManualProps) {
  const label = platformLabel(platform);
  const shellName = platform === 'windows' ? 'Command Prompt / PowerShell' : 'Terminal';

  return (
    <div className="install-manual">
      <h3>Full installation manual for {label}</h3>
      <ol>
        <li>
          <strong>Use the employee computer.</strong> Open this page on the PC that must be monitored. Do not run this installer on the admin laptop unless that is the employee PC.
        </li>
        <li>
          <strong>Download the tracker package.</strong> Click the installer link above and save it locally. The link is tied to this approved employee account.
        </li>
        <li>
          <strong>Run the installer.</strong> {platform === 'windows' ? 'Double-click the .cmd file.' : `Open ${shellName} in Downloads, then run the commands below.`} Keep the window open until it prints that enrollment is complete.
          <pre>{installCommand(url, platform)}</pre>
        </li>
        <li>
          <strong>Allow admin/sudo prompts when asked.</strong> Admin access lets the installer install the background service and force-install browser-extension policies. If admin/sudo is skipped, the core tracker can still run, but browser extension auto-install may be incomplete.
        </li>
        <li>
          <strong>Restart all open browsers.</strong> Close and reopen every browser after the installer finishes. Managed extensions normally load only after browser restart.
        </li>
        <li>
          <strong>Verify browser extensions.</strong> Open each browser used on this PC and check its extensions page. The extension should appear as <em>Neodym Activity Tracker Bridge</em> or as an extension installed by policy/administrator.
        </li>
        <li>
          <strong>Verify dashboard activity.</strong> Within 1–2 minutes the admin dashboard should show the PC online, screenshots/activity rows, and browser-extension rows for supported browsers. If a browser is open but no extension reports, the dashboard will show a browser-compliance warning.
        </li>
      </ol>

      <h3>Browser extension coverage</h3>
      <table className="table browser-extension-manual">
        <thead>
          <tr><th>Browser</th><th>Expected handling</th><th>Manual verification</th></tr>
        </thead>
        <tbody>
          <tr><td>Google Chrome</td><td>Auto-installed by managed policy when admin/sudo succeeds.</td><td>Open chrome://extensions and confirm the Neodym extension is installed by policy.</td></tr>
          <tr><td>Brave</td><td>Auto-installed by managed policy when admin/sudo succeeds.</td><td>Open brave://extensions and confirm the Neodym extension is installed by policy.</td></tr>
          <tr><td>Microsoft Edge</td><td>Auto-installed by managed policy when admin/sudo succeeds.</td><td>Open edge://extensions and confirm the Neodym extension is installed by policy.</td></tr>
          <tr><td>Chromium</td><td>Auto-installed by managed policy when admin/sudo succeeds.</td><td>Open chromium://extensions or chrome://extensions and confirm the Neodym extension is installed by policy.</td></tr>
          <tr><td>Opera</td><td>Auto-installed by managed policy when admin/sudo succeeds.</td><td>Open opera://extensions and confirm the Neodym extension is installed by policy.</td></tr>
          <tr><td>Vivaldi</td><td>Chromium-compatible; the installer attempts managed-policy setup where supported.</td><td>Open vivaldi://extensions and confirm the Neodym extension is installed. If missing, report it; OS screenshots/process tracking still continues.</td></tr>
          <tr><td>Firefox / LibreWolf</td><td>Not covered by the Chromium extension package yet. The tracker still records OS-level browser usage and screenshots, and flags missing extension coverage.</td><td>Use Chrome/Brave/Edge/Chromium/Opera/Vivaldi for full browser telemetry, or treat Firefox rows as browser-compliance warnings until Firefox support is added.</td></tr>
          <tr><td>Incognito / private windows</td><td>Extensions may be blocked unless browser policy allows incognito access.</td><td>If private/incognito use bypasses the extension, the dashboard should show extension-missing-or-incognito compliance warnings plus OS-level evidence.</td></tr>
          <tr><td>Portable or unknown browsers</td><td>Managed policy may not reach them.</td><td>The tracker should still show the process/window/screenshot; the dashboard should warn that browser extension coverage is missing.</td></tr>
        </tbody>
      </table>

      <h3>What the installer sets up</h3>
      <ul>
        <li>Native background tracker service for this user account.</li>
        <li>Cloud enrollment token and upload configuration for this approved employee.</li>
        <li>Screenshot, active-window, process/app, file, audio, click, terminal, and keyboard-chunk telemetry where supported by the OS.</li>
        <li>Local browser bridge on 127.0.0.1 so the extension can report tabs, URLs, clicks, typing summaries, audio state, and visible-tab screenshots.</li>
        <li>Managed extension policies for supported Chromium-family browsers when admin/sudo access is available.</li>
      </ul>

      <h3>Already installed? Refresh/update instead</h3>
      <p className="muted">Use this when the employee already installed the app and only needs the newest tracker package, browser-extension package, and service restart. No new account approval is needed.</p>
      <pre>{refreshCommand(url, platform)}</pre>

      <h3>Troubleshooting checklist</h3>
      <ul>
        <li>If no dashboard rows appear: rerun the installer on the employee PC and keep the terminal open until it finishes.</li>
        <li>If screenshots/activity appear but browser tabs/clicks do not: restart the browser, then check the extension page for the Neodym extension.</li>
        <li>If the extension is missing in Chrome/Brave/Edge/Chromium/Opera/Vivaldi: rerun the installer with admin/sudo access.</li>
        <li>If Firefox, private browsing, or a portable browser is used: expect a browser-compliance warning because high-fidelity extension telemetry may be unavailable.</li>
        <li>{context === 'admin' ? 'Send the employee this manual together with the installer link, and ask them to confirm every browser they use.' : 'Ask your admin if any browser you use does not show the Neodym extension after restart.'}</li>
      </ul>
    </div>
  );
}
