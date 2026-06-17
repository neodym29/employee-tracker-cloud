type InstallerPlatform = 'linux';

type InstallManualProps = {
  url: string;
  extensionUrl?: string;
  firefoxExtensionUrl?: string;
  firefoxSignedUrl?: string;
  firefoxTemporaryUrl?: string;
  platform: InstallerPlatform | undefined;
  context?: 'employee' | 'admin';
};

export function installCommand(url: string, _platform: InstallerPlatform | undefined) {
  return `curl -fsSL '${url}' -o install-neodym-tracker.sh\nbash install-neodym-tracker.sh`;
}

export function refreshCommand(url: string, _platform: InstallerPlatform | undefined) {
  return `curl -fsSL '${url}' -o refresh-neodym-tracker.sh\nbash refresh-neodym-tracker.sh`;
}

function platformLabel(_platform: InstallerPlatform | undefined) {
  return 'Linux';
}

export default function InstallManual({ url, extensionUrl, firefoxSignedUrl, firefoxTemporaryUrl, platform, context = 'employee' }: InstallManualProps) {
  const label = platformLabel(platform);
  const shellName = 'Terminal';

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
          <strong>Run the installer.</strong> Open {shellName} in Downloads, then run the commands below. Keep the window open until it prints that enrollment is complete.
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

      <h3>How to add the browser extension</h3>
      <ol>
        <li><strong>Try automatic install first.</strong> The Linux app installer writes managed browser policies for Chrome, Brave, Edge, Chromium, Opera, and Vivaldi when sudo/admin access succeeds.</li>
        <li><strong>Restart the browser.</strong> Managed policy extensions usually appear only after closing and reopening the browser.</li>
        <li><strong>If the extension is still missing, download it manually.</strong> {extensionUrl ? <a className="button secondary" href={extensionUrl}>Download Chromium browser extension ZIP</a> : 'Use the browser extension ZIP link beside the Linux installer.'}</li>
        <li><strong>For Firefox / LibreWolf, do not open the portal XPI directly if Firefox says it is not verified.</strong> {firefoxTemporaryUrl ? <a className="button secondary" href={firefoxTemporaryUrl}>Download Firefox temporary ZIP</a> : 'Use the Firefox temporary ZIP link beside the Linux installer.'} Extract the ZIP, then in <code>about:debugging#/runtime/this-firefox</code> click <strong>Load Temporary Add-on</strong> and select the extracted <code>manifest.json</code>.</li>
        <li><strong>For permanent Firefox install, use the signed AMO XPI.</strong> {firefoxSignedUrl ? <a className="button secondary" href={firefoxSignedUrl}>Download signed Firefox XPI</a> : 'Use the signed Firefox XPI link beside the Linux installer.'} Install this file normally in Firefox for the permanent add-on.</li>
        <li><strong>Unzip Chromium extensions only.</strong> Extract the Chromium ZIP. The folder you load must contain <code>manifest.json</code>, <code>background.js</code>, and <code>content.js</code>.</li>
        <li><strong>Open the Chromium browser extensions page.</strong> Use <code>chrome://extensions</code>, <code>brave://extensions</code>, <code>edge://extensions</code>, <code>opera://extensions</code>, or <code>vivaldi://extensions</code>.</li>
        <li><strong>Turn on Developer mode.</strong> Then click <strong>Load unpacked</strong> and select the unzipped <code>neodym-browser-extension</code> folder.</li>
        <li><strong>Verify it is reporting.</strong> Keep the native Linux tracker running. The extension talks to the local bridge at <code>127.0.0.1:8766</code>, so the app must be installed first.</li>
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
          <tr><td>Firefox / LibreWolf</td><td>Use the signed Firefox XPI for permanent Firefox installs. For immediate temporary testing, use the temporary ZIP and load its extracted manifest through <code>about:debugging#/runtime/this-firefox</code>.</td><td>Download signed Firefox XPI and install it normally. If testing temporarily, download Firefox temporary ZIP, extract it, open about:debugging, click Load Temporary Add-on, select the extracted manifest.json, then verify Firefox rows on the dashboard.</td></tr>
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
        <li>If Firefox says the add-on is not verified: make sure you downloaded <strong>Download signed Firefox XPI</strong>, not the generated/temporary package. For temporary testing only, download the Firefox temporary ZIP, extract it, then use <code>about:debugging#/runtime/this-firefox</code> → <strong>Load Temporary Add-on</strong> and select the extracted <code>manifest.json</code>.</li>
        <li>If Firefox, private browsing, or a portable browser is used: expect a browser-compliance warning because high-fidelity extension telemetry may be unavailable.</li>
        <li>{context === 'admin' ? 'Send the employee this manual together with the installer link, and ask them to confirm every browser they use.' : 'Ask your admin if any browser you use does not show the Neodym extension after restart.'}</li>
      </ul>
    </div>
  );
}
