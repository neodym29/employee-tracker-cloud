import {useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode} from 'react';

export type HelpSection = {
  number: string;
  title: string;
  description: string;
  detail: string;
  destination: 'install' | 'settings' | 'reports' | '';
  action: string;
};

export const HELP_SECTIONS: HelpSection[] = [
  {number: '01', title: 'Create or join a workspace', description: 'A workspace keeps one team’s repositories, activity, members, and reports together.', detail: 'You can create more than one workspace and switch between them from the sidebar. Managers can invite existing TraceMini users; access begins only after the invitation is accepted.', destination: '', action: 'Open dashboard'},
  {number: '02', title: 'Install the local CLI', description: 'TraceMini needs its Linux CLI on each developer machine that will contribute Git activity or generate reports.', detail: 'Open Install CLI and run the one-time command. Guided setup connects the device, asks which folders it may watch, starts the agent, and verifies the result. The CLI sends activity metadata only—your source code remains on your device.', destination: 'install', action: 'Open Install CLI'},
  {number: '03', title: 'Find and select repositories', description: 'Setup scans only the folders you explicitly approved.', detail: 'Open Settings and select “Scan repositories on my devices,” then choose which discovered repositories to trace. Add another approved folder later with “tracemini watch $HOME/path.”', destination: 'settings', action: 'Open repository settings'},
  {number: '04', title: 'Select repositories to trace', description: 'Scanning finds candidates; tracing is a separate choice.', detail: 'Turn on the switch beside each repository you own. The local agent validates it and installs managed Git hooks. Every member selects repositories from their own devices.', destination: 'settings', action: 'Choose repositories'},
  {number: '05', title: 'Review activity', description: 'The dashboard summarizes local Git signals for the selected date range and timezone.', detail: 'Use the member lines, metrics, recent activity, and repository links to understand the work. Empty hours stay at zero; archived repositories retain their history.', destination: '', action: 'Open dashboard'},
  {number: '06', title: 'Generate a report', description: 'Reports turn the selected activity window into Markdown using Codex or Hermes on a connected device.', detail: 'Choose the dates, generator, writing style, and scope. Keep the matching local AI tool authenticated. Managers can also schedule whole-workspace reports.', destination: 'reports', action: 'Open reports'},
];

export function InfoTip({label, children}: {label: string; children: ReactNode}) {
  const id = useId();
  return <span className="info-tip">
    <button type="button" className="info-tip-trigger" aria-label={`More information: ${label}`} aria-describedby={id} onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>i</button>
    <span className="info-tip-content" id={id} role="tooltip">{children}</span>
  </span>;
}

export function HelpDrawer({hasWorkspace, onClose, onNavigate}: {hasWorkspace: boolean; onClose: () => void; onNavigate: (destination: HelpSection['destination']) => void}) {
  const drawerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const frame = requestAnimationFrame(() => drawerRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const controls = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])') || []);
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (document.activeElement === drawerRef.current) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="help-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside id="help-drawer" ref={drawerRef} tabIndex={-1} className="help-drawer" role="dialog" aria-modal="true" aria-labelledby="help-drawer-title" onKeyDown={handleKeyDown}>
      <header className="help-drawer-header">
        <div><span className="eyebrow">Getting started</span><h2 id="help-drawer-title">How TraceMini works</h2></div>
        <button className="help-close" onClick={onClose} aria-label="Close help">×</button>
      </header>
      <p className="help-intro">Start with a workspace, connect your local CLI, approve repository folders, and then choose what to trace.</p>
      <ol className="help-steps">
        {HELP_SECTIONS.map(section => <li key={section.number}>
          <span className="help-step-number">{section.number}</span>
          <div><h3>{section.title}</h3><p>{section.description}</p><small>{section.detail}</small>
            <button className="help-action" disabled={!hasWorkspace && section.destination !== ''} onClick={() => { onNavigate(section.destination); onClose(); }}>{section.action} →</button>
          </div>
        </li>)}
      </ol>
      {!hasWorkspace && <p className="help-note">Create or accept a workspace first to unlock CLI, repository, and report setup.</p>}
    </aside>
  </div>;
}
