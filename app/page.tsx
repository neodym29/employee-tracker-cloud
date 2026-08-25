const changes = [
  { action: 'Updated', path: 'src/auth/session.ts', agent: 'Codex', time: 'just now', tone: 'violet' },
  { action: 'Created', path: 'app/api/reports/route.ts', agent: 'Hermes', time: '2m', tone: 'green' },
  { action: 'Renamed', path: 'lib/queue.ts → lib/jobs.ts', agent: 'Codex', time: '6m', tone: 'amber' },
  { action: 'Deleted', path: 'components/LegacyPanel.tsx', agent: 'Hermes', time: '11m', tone: 'red' },
];

export default function Home() {
  return (
    <div className="landing">
      <section className="heroSimple">
        <div className="heroCopy">
          <div className="eyebrow"><span className="liveDot" /> Files only</div>
          <h1>Every AI edit.<br /><span>Nothing else.</span></h1>
          <p className="heroText">See the files changed by Hermes and Codex without tracking screens, clicks, browsers, text, or the rest of the computer.</p>
          <div className="heroActions">
            <a className="primaryButton" href="/dashboard">Open dashboard <span aria-hidden="true">→</span></a>
            <span className="privacyNote"><span aria-hidden="true">✓</span> File metadata only</span>
          </div>
        </div>

        <div className="changePreview" aria-label="Example file changes">
          <div className="previewTopbar">
            <div>
              <span className="previewKicker">Today</span>
              <h2>Recent changes</h2>
            </div>
            <span className="liveStatus"><span /> Live</span>
          </div>
          <div className="previewList">
            {changes.map((change) => (
              <div className="previewRow" key={change.path}>
                <span className={`actionIcon ${change.tone}`} aria-hidden="true" />
                <div className="previewPath">
                  <strong>{change.path}</strong>
                  <span>{change.action} by {change.agent}</span>
                </div>
                <time>{change.time}</time>
              </div>
            ))}
          </div>
          <div className="previewFooter">
            <span>4 changes</span>
            <span>2 approved agents</span>
          </div>
        </div>
      </section>

      <section className="trustStrip" aria-label="Privacy boundaries">
        <div><strong>Process-attributed</strong><span>Only approved AI agent trees</span></div>
        <div><strong>Workspace-scoped</strong><span>OS and runtime files stay out</span></div>
        <div><strong>Metadata-only</strong><span>No file contents are collected</span></div>
      </section>
    </div>
  );
}
