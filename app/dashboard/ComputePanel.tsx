'use client';

import { useCallback, useEffect, useState } from 'react';

type Health = { online: boolean; checkedAt: string };

export default function ComputePanel() {
  const [health, setHealth] = useState<Health | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/compute-health', { cache: 'no-store' });
      const payload = await response.json() as Health;
      setHealth({ online: response.ok && payload.online === true, checkedAt: payload.checkedAt });
    } catch {
      setHealth({ online: false, checkedAt: new Date().toISOString() });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return <section className="computePanel" aria-labelledby="compute-title">
    <header className="computeHeader">
      <div><span className="sectionLabel">DGX compute</span><h2 id="compute-title">Shared AI compute</h2><p>Request private timed DGX sessions or use the OpenAI-compatible inference API.</p></div>
      <span className={`healthPill ${health?.online ? 'health-up' : health ? 'health-down' : 'health-unknown'}`}><span aria-hidden="true" />{health?.online ? 'Online' : health ? 'Unavailable' : 'Checking'}</span>
    </header>
    <div className="computeFeatureGrid">
      <article><span className="computeIcon" aria-hidden="true">⌁</span><div><h3>Private DGX sessions</h3><p>Organization-managed, timed access with availability, queueing, automatic cleanup, and a browser terminal.</p></div></article>
      <article><span className="computeIcon" aria-hidden="true">◇</span><div><h3>Shared model inference</h3><p>Model-scoped access to shared warm deployments with isolated keys, quotas, usage, and jobs.</p></div></article>
      <article><span className="computeIcon" aria-hidden="true">↯</span><div><h3>OpenAI-compatible API</h3><p>Chat completions, streaming responses, asynchronous jobs, usage reporting, and model discovery.</p></div></article>
    </div>
    <footer className="computeFooter">
      <div><span>API base URL</span><code>https://compute.neodym.ai/v1</code></div>
      <nav className="computeActions" aria-label="Compute actions">
        <a className="primaryButton" href="https://compute.neodym.ai/" target="_blank" rel="noreferrer">Open Compute <span aria-hidden="true">↗</span></a>
        <a className="secondaryButton" href="https://compute.neodym.ai/api-guide.html" target="_blank" rel="noreferrer">API guide</a>
        <a className="secondaryButton" href="https://compute.neodym.ai/api-keys.html" target="_blank" rel="noreferrer">Manage API key</a>
      </nav>
    </footer>
    <p className="computeSecurityNote">Authentication, live terminals, session requests, and API-key secrets stay on the secured Compute service.</p>
  </section>;
}
