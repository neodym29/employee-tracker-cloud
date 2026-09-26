import { currentSession } from '@/lib/auth';
import NexusMark from '@/app/components/NexusMark';

export default async function Home() {
  const session = await currentSession();
  const primaryAction = session?.account_type === 'admin'
    ? { href: '/admin/approve', label: 'Open admin' }
    : session
      ? { href: '/projects', label: 'Open your projects' }
      : { href: '/signup', label: 'Get started' };

  return <div className="nexusLanding">
    <section className="nexusLandingHero">
      <div className="nexusLandingCopy">
        <NexusMark className="nexusLandingBrandMark" />
        <span className="nexusLandingEyebrow">ONE HOME FOR PROJECT WORK</span>
        <h1>Know what’s happening.<br /><em>Keep work moving.</em></h1>
        <p>Neo-Nexus connects clients and engineers. Ask about a project, turn requests into tasks, and see updates from the work happening in Codex.</p>
        <div className="nexusLandingActions">
          <a className="nexusLandingPrimary" href={primaryAction.href}>{primaryAction.label}<span aria-hidden="true">↗</span></a>
          {!session && <a className="nexusLandingSecondary" href="/login">Sign in</a>}
        </div>
      </div>
      <div className="nexusLandingVisual" aria-label="Illustration of a Neo-Nexus project conversation">
        <div className="nexusLandingGlow" aria-hidden="true" />
        <div className="nexusLandingWindow">
          <div className="nexusLandingWindowTop"><span><i aria-hidden="true" /> Project workspace</span><span aria-hidden="true">✦</span></div>
          <div className="nexusLandingWindowBody">
            <div className="nexusLandingVisualTitle"><NexusMark className="nexusLandingProjectIcon" /><div><strong>One shared picture</strong><small>Questions, tasks, and updates together</small></div></div>
            <div className="nexusLandingConversation">
              <div className="nexusLandingQuestion"><span>Client</span><p>What changed this week?</p></div>
              <div className="nexusLandingAnswer"><span>Project agent</span><p>See the latest work and what needs attention.</p></div>
            </div>
            <div className="nexusLandingUpdate"><span className="nexusLandingUpdateDot" aria-hidden="true" /><span>New work appears in the project timeline</span></div>
          </div>
        </div>
      </div>
    </section>
    <section className="nexusLandingSteps" aria-label="How Neo-Nexus works">
      <div><span>01</span><strong>Ask</strong><p>Clients ask questions and flag issues in project chat.</p></div>
      <div><span>02</span><strong>Build</strong><p>Engineers work in Codex and stay connected to the project.</p></div>
      <div><span>03</span><strong>See progress</strong><p>Everyone sees recent work and next steps in one place.</p></div>
    </section>
  </div>;
}
