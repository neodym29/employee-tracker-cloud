import { currentSession } from '@/lib/auth';

const changes = [
  { action: 'Updated', path: 'src/auth/session.ts', time: 'just now', tone: 'violet' },
  { action: 'Created', path: 'app/api/reports/route.ts', time: '2m', tone: 'green' },
  { action: 'Renamed', path: 'lib/queue.ts → lib/jobs.ts', time: '6m', tone: 'amber' },
  { action: 'Deleted', path: 'components/LegacyPanel.tsx', time: '11m', tone: 'red' },
];

export default async function Home() {
  const session = await currentSession();
  let primaryAction = { href: '/signup', label: 'Get started' };
  if (session?.account_type === 'admin') primaryAction = { href: '/admin/approve', label: 'Review accounts' };
  else if (session) primaryAction = { href: '/projects', label: 'Open projects' };
  return (
    <div className="landing">
      <section className="heroSimple">
        <div className="heroCopy">
          <div className="eyebrow"><span className="liveDot" /> Files only</div>
          <h1>Every change.<br /><span>Nothing else.</span></h1>
          <p className="heroText">See repository changes and project progress without tracking screens, clicks, browsers, text, or the rest of the computer.</p>
          <div className="heroActions">
            <a className="primaryButton" href={primaryAction.href}>{primaryAction.label} <span aria-hidden="true">→</span></a>
            <span className="privacyNote"><span aria-hidden="true">✓</span> File metadata only</span>
          </div>
        </div>

        <div className="changePreview" aria-label="Example file changes">
          <div className="previewTopbar">
            <div>
              <span className="previewKicker">Illustrative</span>
              <h2>Example changes</h2>
            </div>
            <span className="liveStatus">Demo</span>
          </div>
          <div className="previewList">
            {changes.map((change) => (
              <div className="previewRow" key={change.path}>
                <span className={`actionIcon ${change.tone}`} aria-hidden="true" />
                <div className="previewPath">
                  <strong>{change.path}</strong>
                  <span>{change.action}</span>
                </div>
                <time>{change.time}</time>
              </div>
            ))}
          </div>
          <div className="previewFooter">
            <span>4 changes</span>
            <span>Progress events</span>
          </div>
        </div>
      </section>

      <section className="trustStrip" aria-label="Privacy boundaries">
        <div><strong>Change observed</strong><span>Selected repositories only</span></div>
        <div><strong>Workspace-scoped</strong><span>OS and runtime files stay out</span></div>
        <div><strong>Metadata-only</strong><span>No file contents are collected</span></div>
      </section>
    </div>
  );
}
