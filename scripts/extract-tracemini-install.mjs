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
replace('The command expires after 10 minutes and works once. If TraceMini is already installed, it updates and securely reconnects that installation to this account. Otherwise, it performs the first installation—no sudo or npm registry required.','The private command expires after 10 minutes and works once. It installs the original Node CLI and authenticates this device. Setup discovers Git repositories only inside folders you approve and automatically starts the namespaced background service, <code>employee-trace.service</code>. Keep it out of chat, tickets and logs. Linux and Node.js 22 or newer are required.');
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
install=install.replace(': "Copy"}', ': "COPY AGENT SETUP PROMPT"}');
install=install.replace('Running the prompt authorizes discovery and watch-list additions, not project tracking or upload.', 'Running the prompt authorizes discovery and watch-list additions, not project tracking or upload. Failed setup rolls back local installation changes.');
const helpers=extract('function BusyIndicator(', '\nfunction ProgressTrack(')+extract('async function copyText(', '\nfunction CopyableOcrCommand(')+extract('function useActiveView(', '\nfunction Install(')+extract('function PageHeading(', '\nfunction ActivityTimelineGraph(').replace('<h1>{title}</h1>','<h2>{title}</h2>');
const output=`'use client';
// Generated from TraceMini 7363d85 apps/web/src.tsx Install + original helpers.
// Cloud request, account-scoped DTO and approved-root setup patches: scripts/extract-tracemini-install.mjs.
import {useState, useRef, useLayoutEffect, useEffect} from 'react';
import './install.css';
async function request(url: string, init: RequestInit = {}) {
  const response = await fetch('/api'+url, {...init, credentials:'same-origin', cache:'no-store', headers:{'content-type':'application/json'}});
  if (!response.ok) throw new Error(response.status === 429 ? 'Too many commands. Try again later.' : 'Request failed. Check your approved login or try again.');
  return response.json();
}
${helpers}\n${install}`;
fs.mkdirSync('app/components/trace-node',{recursive:true});
fs.writeFileSync('app/components/trace-node/Install.tsx',output);
console.log('Extracted original Install JSX and helpers with account-scoped guided setup adapter.');
