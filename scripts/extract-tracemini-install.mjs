// Direct extraction from the pinned original web source; no pristine edits.
import fs from 'node:fs';
const src=fs.readFileSync('vendor/tracemini/pristine/apps/web/src.tsx','utf8');
const extract=(a,b)=>{const start=src.indexOf(a),end=src.indexOf(b,start);if(start<0||end<0)throw new Error('Upstream Install seam changed');return src.slice(start,end);};
let install=extract('function Install(', '\nfunction PageHeading(');
const replace=(a,b)=>{if(!install.includes(a))throw new Error('Upstream Install patch seam changed');install=install.replace(a,b);};
replace(install.slice(0,install.indexOf('\n')), 'export default function Install() {\n  const [agents, onAgentsChecked] = useState<any[]>([]);');
replace('agents.filter((agent) => agent.user_id === userId && !agent.revoked_at)', 'agents.filter((agent) => agent.capability === "node-git-v1")');
replace('  const onlineDevices = personalDevices.filter((agent) => agent.status === "online");\n','');
replace('await checkCliConnection(workspaceId, userId, request)', 'await request("/agents/installations")');
const messageStart=install.indexOf('      setCheckMessage('),messageEnd=install.indexOf('\n    } catch',messageStart);
replace(install.slice(messageStart,messageEnd),'      setCheckMessage(result.agents.length ? "Node enrollment verified. Check live polling and select repositories in this GUI below." : "No Node CLI enrollment found for your account.");');
replace('  const mint = async () => {', `  useEffect(() => {
    void checkConnection();
    const timer = setInterval(() => void checkConnection(), 10_000);
    return () => clearInterval(timer);
  }, []);
  const mint = async () => {`);
replace('body: JSON.stringify({ workspaceId })','body: JSON.stringify({})');
replace('<div className="page-stack">','<div className="trace-node-install page-stack">');
replace('title="Install TraceMini CLI"','title="Install Trace CLI"');
replace('description="Connect this Linux device once to your account. Repositories and reports remain workspace-scoped, and source code stays local."','description="Connect this Linux Node CLI to your account, approve discovery folders in the terminal, then select repositories in this GUI. Source code stays local; existing approved AI tracking is unchanged."');
const cardStart=install.indexOf('        <h2>{onlineDevices.length'),cardEnd=install.indexOf('        <button className="button secondary"',cardStart);
replace(install.slice(cardStart,cardEnd),`        <h2>{personalDevices.length ? "Node enrollment verified" : "Node enrollment not checked"}</h2>
        <p className="muted">Enrollment alone is not an online heartbeat. Check live Node polling below. Git hooks and tracking require your explicit repository selection and device confirmation.</p>
`);
replace('<h2 className="heading-with-tip">Connect or sync this device <InfoTip label="CLI connection">The CLI runs locally, observes only folders you approve, and is required for repository activity and AI-generated reports.</InfoTip></h2>','<h2>Connect this device</h2>');
replace('The command expires after 10 minutes and works once. If TraceMini is already installed, it updates and securely reconnects that installation to this account. Otherwise, it performs the first installation—no sudo or npm registry required.','The private command expires after 10 minutes and works once. It installs the original Node CLI and authenticates this device. Setup discovers Git repositories only inside folders you approve and automatically starts the namespaced background service, <code>employee-trace.service</code>. Keep it out of chat, tickets and logs. Linux and Node.js 22 or newer are required. Background mode also requires a working systemd user session. Without systemd, save the private installer to a local file and run <code>sh installer.sh --no-service --isolated-home /absolute/new/collector-home --no-watched-dirs</code>; the directory must not exist. Then run <code>/absolute/new/collector-home/.local/bin/employee-trace start</code> in the foreground. This mode creates no service, has no autostart, and stops polling when that process exits.');
replace('Run this command once. It installs or updates TraceMini, connects this device, asks which folders it may watch, starts the background agent, verifies the connection, and rolls back automatically if setup fails.','Run this command once. It stages and verifies the original Node CLI, asks you to approve watched folders, enrolls the device, discovers repositories and starts the background agent. Folder approval permits discovery, not automatic repository tracking. Failed setup rolls back local installation changes.');
replace('Copy a folder location from your file manager address bar and paste the full path into the guided prompt—for example, <code>/home/murtaza/Murtaza</code>. Then choose whether to add another folder or proceed. The page checks for the device heartbeat automatically.','Copy a folder location from your file manager address bar and paste the full absolute path into the guided terminal prompt—for example, <code>/home/you/projects</code>. Approve only folders you want scanned, then choose whether to add another folder or proceed. Return here to check live Node polling, scan approved folders and select repositories in this GUI. Open an existing matched project rather than creating a duplicate; no ZIP upload is needed.');
replace('Setup also explains how to add folders later with <code>tracemini watch "$HOME/path"</code> and how to see all CLI commands with <code>tracemini --help</code>. This install command expires at','Add approved folders later with <code>employee-trace watch "$HOME/path"</code>, check device and service status with <code>employee-trace status</code>, or see commands with <code>employee-trace --help</code>. This install command expires at');
replace(': "Connect or sync this device"', ': "Prepare install command"');
replace('<Copy label="Connect or sync command" command={installation.syncCommand || installation.installCommand} />','<Copy label="Copy agent setup prompt" command={installation.setupPrompt} />\n              <button className="button secondary" onClick={mint} disabled={pending}>Generate a new command</button>');
// Keep upstream JSX/helpers while replacing the manual-folder instructions.
install=install.replace('Prepare install command','Prepare agent setup prompt').replace('Generate a new command','Generate a new prompt');
install=install.replace('approve discovery folders in the terminal','let your local agent discover existing Git projects');
install=install.replace('Run this command once. It stages and verifies the original Node CLI, asks you to approve watched folders, enrolls the device, discovers repositories and starts the background agent. Folder approval permits discovery, not automatic repository tracking. Failed setup rolls back local installation changes.','Copy this single prompt into your trusted local coding agent. It discovers existing Git projects within bounded user-owned locations and supplies each repository path to setup automatically—no folder guessing. Running the prompt authorizes discovery and watch-list additions, not project tracking or upload.');
install=install.replace('Copy a folder location from your file manager address bar and paste the full absolute path into the guided terminal prompt—for example, <code>/home/you/projects</code>. Approve only folders you want scanned, then choose whether to add another folder or proceed. Return here to check live Node polling, scan approved folders and select repositories in this GUI. Open an existing matched project rather than creating a duplicate; no ZIP upload is needed.','The agent reports skipped folders, worktree restrictions and scan limits rather than claiming every project on the computer was found. Existing installation and watch entries are preserved. Return here for explicit project association and tracking approval; no ZIP upload is needed.');
install=install.replace(': "Copy"}', ': compact ? label : "COPY AGENT SETUP PROMPT"}');
// Keep copy feedback beside either action and announce success to assistive technology.
install=install.replace('const [copied, setCopied] = useState("");', 'const [copied, setCopied] = useState("");\n  const [copyError, setCopyError] = useState("");\n  const [copyTarget, setCopyTarget] = useState("");');
install=install.replace('setCopyPending(label);', 'setCopyPending(label);\n          setCopyTarget(label);\n          setCopied("");\n          setCopyError("");');
install=install.replace('setError(caught.message || "Could not copy the command.");', 'setCopyError(caught.message || "Could not copy the prompt. Expand Review prompt and copy it manually.");');
install=install.replace('      </button>\n    </div>\n  );', '      </button>\n      <span role="status" aria-live="polite">{copied === label ? "Prompt copied." : ""}</span>\n      {copyError && copyTarget === label && <span role="alert">{copyError}</span>}\n    </div>\n  );');
// A second credential-free handoff must survive regeneration of the upstream UI.
install=install.replace('  const mint = async () => {', `  const [projectName, setProjectName] = useState("");
  const [projectPrompt, setProjectPrompt] = useState("");
  const validProjectName = isValidProjectName(projectName);
  const projectPromptGeneration = useRef(0);
  const generateProjectPrompt = async () => {
    if (!validProjectName) return;
    const generation = ++projectPromptGeneration.current;
    try {
      const state = await request('/agents/discovery');
      const matches = state.projects.filter((p: any) => p.title === projectName.trim());
      if (generation !== projectPromptGeneration.current) return;
      setProjectPrompt(buildAddProjectPrompt(projectName, matches.length === 1 ? {projectId:String(matches[0].id),origin:window.location.origin} : undefined));
    } catch { if (generation === projectPromptGeneration.current) setError('Sign in and retry to resolve the existing project safely.'); }
  };
  const mint = async () => {`);
install=install.replace('const Copy = ({ command, label }: { command: string; label: string })', 'const Copy = ({ command, label, compact = false }: { command: string; label: string; compact?: boolean })');
install=install.replace('<small>{label}</small>', '{!compact && <small>{label}</small>}');
install=install.replace('<pre>{command}</pre>', '<>{compact ? <details><summary>Review prompt</summary><pre>{command}</pre></details> : <pre>{command}</pre>}</>');
install=install.replace('      {installation && (', `      <section className="card install-card" aria-labelledby="add-project-heading">
        <div className="step-number" aria-hidden="true">+</div>
        <div>
          <h2 id="add-project-heading">Add a project</h2>
          <p>Already connected? Name your project and generate a prompt. Authorize setup once for the confirmed repository and device: required safe collector update, discovery, existing-project link and tracking. Generating or copying is not approval. Normal browser sign-in is still required.</p>
          <label htmlFor="add-project-name">Project name</label>
          <input id="add-project-name" type="text" value={projectName} required maxLength={200}
            aria-describedby="add-project-name-help" aria-invalid={projectName.length > 0 && !validProjectName}
            onChange={(event) => { projectPromptGeneration.current++; setProjectName(event.target.value); setProjectPrompt(""); setCopied(""); setCopyError(""); }} />
          <p id="add-project-name-help" className="muted">Only this project's directory will be added—not the agent's current folder. If the exact directory is unclear, your agent will ask for its absolute path.</p>
          <button className="button secondary" onClick={generateProjectPrompt} disabled={!validProjectName}>Generate prompt</button>
          {projectPrompt && validProjectName && <Copy label="Copy add-project prompt" command={projectPrompt} compact />}
        </div>
      </section>
      {installation && (`);
install=install.replace('Running the prompt authorizes discovery and watch-list additions, not project tracking or upload.', 'Running the prompt authorizes discovery and watch-list additions, not project tracking or upload. Failed setup rolls back local installation changes.');
// The cloud setup surface intentionally has one job: hand the employee a
// one-use setup prompt. Keep project discovery/tracking in the authenticated
// repository screen instead of making device connection a second workflow.
install=`export default function Install({showCodexPlugin = false}: {showCodexPlugin?: boolean}) {
  const active = useActiveView();
  const [installation, setInstallation] = useState<any>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copiedTerminal, setCopiedTerminal] = useState(false);
  const [copiedCodex, setCopiedCodex] = useState(false);
  const [health, setHealth] = useState<any[] | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [healthError, setHealthError] = useState('');
  const [pluginStatus, setPluginStatus] = useState<any | null>(null);
  const [pluginStatusBusy, setPluginStatusBusy] = useState(false);
  const [pluginStatusError, setPluginStatusError] = useState('');
  const mint = async () => {
    setError(''); setPending(true);
    try { const next = await request('/agents/installations', {method:'POST', body:JSON.stringify({})}); if (active.current) setInstallation(next); }
    catch (caught: any) { if (active.current) setError(caught.message || 'Could not prepare the setup prompt.'); }
    finally { if (active.current) setPending(false); }
  };
  useEffect(() => { void mint(); }, []);
  const refreshHealth = async () => {
    setHealthError('');
    try { const next = await request('/agents/discovery'); if (active.current) setHealth(next.health || []); }
    catch (caught: any) { if (active.current) setHealthError(caught.message || 'Could not check Trace health.'); }
  };
  useEffect(() => { void refreshHealth(); }, []);
  const refreshPluginStatus = async () => {
    if (!showCodexPlugin) return;
    setPluginStatusBusy(true); setPluginStatusError('');
    try { const next = await request('/agents/codex-plugin-status'); if (active.current) setPluginStatus(next); }
    catch (caught: any) { if (active.current) setPluginStatusError(caught.message || 'Could not check the Codex plugin connection.'); }
    finally { if (active.current) setPluginStatusBusy(false); }
  };
  useEffect(() => {
    if (!showCodexPlugin) return;
    void refreshPluginStatus();
    const timer = window.setInterval(() => void refreshPluginStatus(), 15000);
    return () => window.clearInterval(timer);
  }, [showCodexPlugin]);
  const repairTrace = async (item: any) => {
    setHealthBusy(true); setHealthError('');
    try {
      await request('/agents/discovery', {method:'POST', body:JSON.stringify({action:'select',candidateId:item.candidateId,traced:true,revision:item.revision,projectId:item.projectId,resumeUploads:true})});
      await refreshHealth();
    } catch (caught: any) { setHealthError(caught.message || 'Trace repair could not be requested.'); }
    finally { setHealthBusy(false); }
  };
  const terminalCommands = installation ? [
    '# 1. Run the one-use installer',
    installation.installCommand,
    '',
    '# 2. Verify the device',
    '"$HOME/.local/bin/employee-trace" status',
    '',
    '# 3. View discovered repositories',
    '"$HOME/.local/bin/employee-trace" repositories',
  ].join('\\n') : '';
  const codexCommands = [
    '# 1. Add the private Neodym marketplace',
    'codex plugin marketplace add neodym29/neo-nexus-codex-plugin',
    '',
    '# 2. Refresh the marketplace to the latest plugin release',
    'codex plugin marketplace upgrade neodym',
    '',
    '# 3. Install the Neo-Nexus plugin',
    'codex plugin add neo-nexus@neodym',
    '',
    '# 4. Restart Codex, then open a new chat in your project repository',
  ].join('\\n');
  const copyValue = async (value: string, kind: 'prompt' | 'terminal') => {
    try { await copyText(value); if (kind === 'prompt') setCopied(true); else setCopiedTerminal(true); }
    catch (caught: any) { setError(caught.message || 'Could not copy the setup instructions.'); }
  };
  return <div className="trace-node-install page-stack">
    <section className="card install-card">
      {error && <div className="alert error" role="alert">{error}</div>}
      {!installation || pending ? <BusyIndicator label="Preparing setup instructions…" /> : <div className="setup-alternatives">
        <button className="button primary" onClick={() => { setCopied(false); void copyValue(installation.setupPrompt, 'prompt'); }}>{copied ? 'Prompt copied' : 'Copy setup prompt'}</button>
      </div>}
      {terminalCommands && <div className="terminal-block" aria-label="Terminal setup commands"><div className="terminal-block-header"><strong>CLI commands</strong><button type="button" className="terminal-copy-icon" title={copiedTerminal ? 'Terminal commands copied' : 'Copy terminal commands'} aria-label={copiedTerminal ? 'Terminal commands copied' : 'Copy terminal commands'} onClick={() => { setCopiedTerminal(false); void copyValue(terminalCommands, 'terminal'); }}>{copiedTerminal ? <svg className="copy-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg> : <svg className="copy-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4" /></svg>}</button></div><pre><code>{terminalCommands}</code></pre></div>}
      <p className="trace-health-note">While the service is running, Neo-Nexus checks safe readable folders in your home and local mounted drives every 10 minutes for new Git repositories. System, credential, cache, dependency, other-user, and network locations are skipped. New repositories stay unconnected until you choose a project.</p>
      {showCodexPlugin && <section className="codex-plugin-install" aria-labelledby="codex-plugin-title">
        <div><span>Engineer tools</span><h2 id="codex-plugin-title">Add Neo-Nexus to Codex</h2><p>Install once after connecting this device. The plugin uses this engineer&apos;s approved Neo-Nexus device identity, so task activity is attributed to the correct person and computer.</p></div>
        <div className={'codex-plugin-status codex-plugin-status-' + (pluginStatus?.status || 'checking')} role="status" aria-live="polite">
          <span className="codex-plugin-status-dot" aria-hidden="true" />
          <div><strong>{pluginStatus?.label || (pluginStatusError ? 'Connection check failed' : 'Checking plugin connection…')}</strong><p>{pluginStatusError || pluginStatus?.detail || 'Waiting for the Neo-Nexus plugin heartbeat.'}</p>{pluginStatus?.projectConnections && <p><strong>Connected projects</strong> — {pluginStatus.projectConnections.length ? pluginStatus.projectConnections.map((project: any) => project.title).join(', ') : 'None yet. Open a repository in Codex and connect it to a Neo-Nexus project.'}</p>}{pluginStatus?.dailySummary && <p><strong>{pluginStatus.dailySummary.label}</strong> — {pluginStatus.dailySummary.detail}</p>}</div>
          <button type="button" className="terminal-copy-icon" aria-label="Refresh plugin connection" title="Refresh plugin connection" onClick={() => void refreshPluginStatus()} disabled={pluginStatusBusy}><svg className="copy-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-4L3 10m0-4v4h4M4 13a8 8 0 0 0 14.9 4L21 14m0 4v-4h-4" /></svg></button>
        </div>
        <div className="terminal-block" aria-label="Codex plugin installation commands"><div className="terminal-block-header"><strong>Codex plugin commands</strong><button type="button" className="terminal-copy-icon" title={copiedCodex ? 'Codex plugin commands copied' : 'Copy Codex plugin commands'} aria-label={copiedCodex ? 'Codex plugin commands copied' : 'Copy Codex plugin commands'} onClick={() => { setCopiedCodex(false); void copyText(codexCommands).then(() => setCopiedCodex(true)).catch((caught: any) => setError(caught.message || 'Could not copy the Codex plugin commands.')); }}>{copiedCodex ? <svg className="copy-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg> : <svg className="copy-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4" /></svg>}</button></div><pre><code>{codexCommands}</code></pre></div>
        <p className="trace-health-note">Version 0.6.1 checks for updates when Codex starts and about once a day while it is open. Restart Codex to load an update. Earlier installations need steps 2–3 above once to enable automatic updates.</p>
        <p className="trace-health-note">GitHub access to the private Neodym plugin repository is required. In a repository, the plugin can connect you to an approved project after Neo-Nexus verifies your account, device, membership, and repository.</p>
      </section>}
      <section className="trace-health-panel" aria-labelledby="trace-health-title"><div className="trace-health-header"><div><span>Diagnostics</span><h2 id="trace-health-title">Trace health</h2></div><button type="button" className="terminal-copy-icon" aria-label="Refresh Trace health" title="Refresh Trace health" onClick={() => void refreshHealth()} disabled={healthBusy}><svg className="copy-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0-14.9-4L3 10m0-4v4h4M4 13a8 8 0 0 0 14.9 4L21 14m0 4v-4h-4" /></svg></button></div>{healthError && <p className="alert error" role="alert">{healthError}</p>}{health === null ? <BusyIndicator label="Checking devices and repositories…" /> : health.length === 0 ? <p className="muted">No linked repositories to check yet.</p> : <div className="trace-health-list">{health.map(item => <article className={'trace-health-item trace-health-' + item.state} key={item.candidateId}><div><strong>{item.repository}</strong><span>{item.projectTitle} · {item.device}</span><p>{item.label}. {item.detail}</p></div>{item.repairable && <button type="button" disabled={healthBusy} onClick={() => void repairTrace(item)}>{item.code === 'not_started' ? 'Start trace' : 'Repair trace'}</button>}</article>)}</div>}<p className="trace-health-note">Failures are logged with the repository, device, and repair state so the next check can target the same trace.</p></section>
    </section>
  </div>;
}
`;
// Keep generated user-facing diagnostics on the current product name while
// retaining the employee-trace binary and API namespace for compatibility.
install = install
  .replaceAll('Trace health', 'Neo-Nexus health')
  .replaceAll('Trace repair', 'Neo-Nexus repair')
  .replaceAll("'Start trace'", "'Start tracking'")
  .replaceAll("'Repair trace'", "'Repair tracking'")
  .replace('the next check can target the same trace', 'the next health check can target the same connection');
const helpers=extract('function BusyIndicator(', '\nfunction ProgressTrack(')+extract('async function copyText(', '\nfunction CopyableOcrCommand(')+extract('function useActiveView(', '\nfunction Install(')+extract('function PageHeading(', '\nfunction ActivityTimelineGraph(').replace('<h1>{title}</h1>','<h2>{title}</h2>');
const output=`'use client';
// Generated from TraceMini 7363d85 apps/web/src.tsx Install + original helpers.
// Cloud request, account-scoped DTO and automatic safe-root setup patches: scripts/extract-tracemini-install.mjs.
import {useState, useRef, useLayoutEffect, useEffect} from 'react';
import './install.css';
import {buildAddProjectPrompt, isValidProjectName} from '../../../lib/tracemini-add-project-prompt';
async function request(url: string, init: RequestInit = {}) {
  const response = await fetch('/api'+url, {...init, credentials:'same-origin', cache:'no-store', headers:{'content-type':'application/json'}});
  if (!response.ok) throw new Error(response.status === 429 ? 'Too many commands. Try again later.' : 'Request failed. Check your approved login or try again.');
  return response.json();
}
${helpers}\n${install}`;
fs.mkdirSync('app/components/trace-node',{recursive:true});
fs.writeFileSync('app/components/trace-node/Install.tsx',output);
console.log('Extracted original Install JSX and helpers with account-scoped guided setup adapter.');
