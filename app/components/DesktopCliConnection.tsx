'use client';
import { useState } from 'react';
import Discovery from './trace-node/Discovery';
import { buildAddProjectPrompt } from '../../lib/tracemini-add-project-prompt';
// Account discovery is not a dummy project and is separate from the Python collector.
export default function DesktopCliConnection({ projectId, projectName }: { projectId?: string; projectName?: string }) {
  const [copied, setCopied] = useState('');
  const copy = async (value: string, kind: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(kind); }
    catch { setCopied(''); }
  };
  const addProjectPrompt = projectId && projectName ? buildAddProjectPrompt(projectName, { projectId, origin: typeof window === 'undefined' ? 'https://employee-tracker-cloud.vercel.app' : window.location.origin }) : '';
  const cliCommands = projectId ? `# Replace the path with the confirmed absolute repository root\ncd "/absolute/path/to/${projectName || 'your-project'}"\n\n# Discover this exact repository\n"$HOME/.local/bin/employee-trace" project-discover "$PWD"\n\n# After the project page confirms the repository selection\n"$HOME/.local/bin/employee-trace" project-activate "$PWD" "${projectId}"` : '';
  const commandSteps = projectId ? [
    ['Open the repository folder', `cd "/absolute/path/to/${projectName || 'your-project'}"`],
    ['Discover this exact repository', '"$HOME/.local/bin/employee-trace" project-discover "$PWD"'],
    ['Activate tracing for this project', `"$HOME/.local/bin/employee-trace" project-activate "$PWD" "${projectId}"`],
  ] : [];
  return <>
    {projectId && <section className="card install-card project-setup-options" aria-labelledby="project-setup-options-title">
      <h2 id="project-setup-options-title">Add this project to Neo-Nexus</h2>
      <p className="muted">Copy the prompt into your coding agent, or run the visible commands one at a time.</p>
      <div className="setup-alternatives">
        <button type="button" className="button primary" onClick={() => void copy(addProjectPrompt, 'project-prompt')}>{copied === 'project-prompt' ? 'Prompt copied' : 'Copy add-project prompt'}</button>
        <button type="button" className="button secondary" onClick={() => void copy(cliCommands, 'project-cli')}>{copied === 'project-cli' ? 'Commands copied' : 'Copy all CLI commands'}</button>
      </div>
      <ol className="terminal-step-list" aria-label="Project CLI commands">{commandSteps.map(([label, command], index) => <li key={label}><div><strong>{index + 1}. {label}</strong><code>{command}</code></div><button type="button" className="button secondary" onClick={() => void copy(command, `project-step-${index}`)}>{copied === `project-step-${index}` ? 'Copied' : 'Copy step'}</button></li>)}</ol>
    </section>}
    {projectId ? <Discovery projectId={projectId} /> : null}
  </>;
}
