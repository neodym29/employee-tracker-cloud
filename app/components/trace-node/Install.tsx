'use client';
// Generated from TraceMini 7363d85 apps/web/src.tsx Install + original helpers.
// Cloud request, account-scoped DTO and approved-root setup patches: scripts/extract-tracemini-install.mjs.
import {useState, useRef, useLayoutEffect, useEffect} from 'react';
import './install.css';
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

export default function Install() {
  const [agents, onAgentsChecked] = useState<any[]>([]);
  const active = useActiveView();
  const [installation, setInstallation] = useState<any>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [checkPending, setCheckPending] = useState(false);
  const [checkMessage, setCheckMessage] = useState("");
  const [copied, setCopied] = useState("");
  const [copyPending, setCopyPending] = useState("");
  const personalDevices = agents.filter((agent) => agent.capability === "node-git-v1");
  const checkConnection = async () => {
    setError("");
    setCheckMessage("");
    setCheckPending(true);
    try {
      const result = await request("/agents/installations");
      if (!active.current) return;
      onAgentsChecked(result.agents);
      setCheckMessage(result.agents.length ? "Node enrollment verified. Check live polling and select repositories in this GUI below." : "No Node CLI enrollment found for your account.");
    } catch (caught: any) {
      if (active.current) setError(caught.message || "Could not check the CLI connection.");
    } finally {
      if (active.current) setCheckPending(false);
    }
  };
  useEffect(() => {
    void checkConnection();
    const timer = setInterval(() => void checkConnection(), 10_000);
    return () => clearInterval(timer);
  }, []);
  const mint = async () => {
    setError("");
    setPending(true);
    try {
      const nextInstallation = await request("/agents/installations", {
          method: "POST",
          body: JSON.stringify({}),
        });
      if (active.current) setInstallation(nextInstallation);
    } catch (caught: any) {
      if (active.current) setError(caught.message);
    } finally {
      if (active.current) setPending(false);
    }
  };
  const Copy = ({ command, label }: { command: string; label: string }) => (
    <div className="command">
      <div>
        <small>{label}</small>
        <pre>{command}</pre>
      </div>
      <button
        className="button secondary"
        disabled={Boolean(copyPending)}
        onClick={async () => {
          setError("");
          setCopyPending(label);
          try {
            await copyText(command);
            setCopied(label);
          } catch (caught: any) {
            setError(caught.message || "Could not copy the command.");
          } finally {
            setCopyPending("");
          }
        }}
      >
        {copyPending === label ? <BusyIndicator label="Copying…" /> : copied === label ? "Copied" : "COPY AGENT SETUP PROMPT"}
      </button>
    </div>
  );
  return (
    <div className="trace-node-install page-stack">
      <PageHeading
        eyebrow="Local device"
        title="Install Trace CLI"
        description="Connect this Linux Node CLI to your account, let your local agent discover existing Git projects, then select repositories in this GUI. Source code stays local; existing approved AI tracking is unchanged."
      />
      <section className="card device-detection" aria-live="polite">
        <span>CLI connection</span>
        <h2>{personalDevices.length ? "Node enrollment verified" : "Node enrollment not checked"}</h2>
        <p className="muted">Enrollment alone is not an online heartbeat. Check live Node polling below. Git hooks and tracking require your explicit repository selection and device confirmation.</p>
        <button className="button secondary" onClick={checkConnection} disabled={checkPending}>
          {checkPending ? "Checking…" : "Check CLI connection"}
        </button>
        {checkMessage && <p className="muted" role="status">{checkMessage}</p>}
      </section>
      <section className="card install-card">
        <div className="step-number">01</div>
        <div>
          <h2>Connect this device</h2>
          <p>
            The private command expires after 10 minutes and works once. It installs the original Node CLI and authenticates this device. Setup discovers Git repositories only inside folders you approve and automatically starts the namespaced background service, <code>employee-trace.service</code>. Keep it out of chat, tickets and logs. Linux and Node.js 22 or newer are required.
          </p>
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          {!installation ? (
            <button
              className="button primary"
              onClick={mint}
              disabled={pending}
            >
              {pending
                ? <BusyIndicator label="Preparing connection…" />
                : personalDevices.length
                  ? "Connect another device"
                  : "Prepare agent setup prompt"}
            </button>
          ) : (
            <>
              <div className="alert progress" role="status">
                Copy this single prompt into your trusted local coding agent. It discovers existing Git projects within bounded user-owned locations and supplies each repository path to setup automatically—no folder guessing. Running the prompt authorizes discovery and watch-list additions, not project tracking or upload. Failed setup rolls back local installation changes.
              </div>
              <Copy label="Copy agent setup prompt" command={installation.setupPrompt} />
              <button className="button secondary" onClick={mint} disabled={pending}>Generate a new prompt</button>
            </>
          )}
        </div>
      </section>
      {installation && (
        <section className="card install-card">
          <div className="step-number">02</div>
          <div>
            <h2>Complete setup in the terminal</h2>
            <p>
              The agent reports skipped folders, worktree restrictions and scan limits rather than claiming every project on the computer was found. Existing installation and watch entries are preserved. Return here for explicit project association and tracking approval; no ZIP upload is needed.
            </p>
            <p className="muted">
              Add approved folders later with <code>employee-trace watch "$HOME/path"</code>, check device and service status with <code>employee-trace status</code>, or see commands with <code>employee-trace --help</code>. This install command expires at {new Date(installation.expiresAt).toLocaleTimeString()}.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
