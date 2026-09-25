'use client';
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
function BusyIndicator({ label }: { label: string }) {
  return (
    <span className="busy-indicator" role="status">
      <i className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
async function copyText(value: string) {
  if (navigator.clipboard?.writeText)
    return navigator.clipboard.writeText(value);
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Copy failed. Select and copy the command manually.");
}
function useActiveView() {
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  return active;
}
function PageHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="page-heading">
      <span>{eyebrow}</span>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}

export default function Install({showCodexPlugin = false}: {showCodexPlugin?: boolean}) {
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
    catch (caught: any) { if (active.current) setHealthError(caught.message || 'Could not check Neo-Nexus health.'); }
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
    } catch (caught: any) { setHealthError(caught.message || 'Neo-Nexus repair could not be requested.'); }
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
  ].join('\n') : '';
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
  ].join('\n');
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
      <section className="trace-health-panel" aria-labelledby="trace-health-title"><div className="trace-health-header"><div><span>Diagnostics</span><h2 id="trace-health-title">Neo-Nexus health</h2></div><button type="button" className="terminal-copy-icon" aria-label="Refresh Neo-Nexus health" title="Refresh Neo-Nexus health" onClick={() => void refreshHealth()} disabled={healthBusy}><svg className="copy-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0-14.9-4L3 10m0-4v4h4M4 13a8 8 0 0 0 14.9 4L21 14m0 4v-4h-4" /></svg></button></div>{healthError && <p className="alert error" role="alert">{healthError}</p>}{health === null ? <BusyIndicator label="Checking devices and repositories…" /> : health.length === 0 ? <p className="muted">No linked repositories to check yet.</p> : <div className="trace-health-list">{health.map(item => <article className={'trace-health-item trace-health-' + item.state} key={item.candidateId}><div><strong>{item.repository}</strong><span>{item.projectTitle} · {item.device}</span><p>{item.label}. {item.detail}</p></div>{item.repairable && <button type="button" disabled={healthBusy} onClick={() => void repairTrace(item)}>{item.code === 'not_started' ? 'Start tracking' : 'Repair tracking'}</button>}</article>)}</div>}<p className="trace-health-note">Failures are logged with the repository, device, and repair state so the next health check can target the same connection.</p></section>
    </section>
  </div>;
}
