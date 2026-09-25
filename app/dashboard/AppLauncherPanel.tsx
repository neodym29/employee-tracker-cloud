'use client';

import { useCallback, useEffect, useState } from 'react';
import { applicationCatalog, type ApplicationId } from '@/lib/app-catalog';

type AppHealth = { id: ApplicationId; online: boolean; latencyMs: number | null };
type HealthResponse = { checkedAt: string; apps: AppHealth[] };

export default function AppLauncherPanel() {
  const [health, setHealth] = useState<Record<string, AppHealth>>({});

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/apps-health', { cache: 'no-store' });
      if (!response.ok) throw new Error('Application health is unavailable');
      const payload = await response.json() as HealthResponse;
      setHealth(Object.fromEntries(payload.apps.map((app) => [app.id, app])));
    } catch {
      setHealth(Object.fromEntries(applicationCatalog.map((app) => [app.id, { id: app.id, online: false, latencyMs: null }])));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return <section className="appLauncherPanel" aria-labelledby="app-launcher-title">
    <header className="appLauncherHeader">
      <div><span className="sectionLabel">Applications</span><h2 id="app-launcher-title">Open an app</h2></div>
      <p>Live Neodym products and project deployments.</p>
    </header>
    <div className="appLauncherGrid">
      {applicationCatalog.map((app) => {
        const state = health[app.id];
        return <a className="appLauncherCard" href={app.url} target="_blank" rel="noreferrer" key={app.id}>
          <span className="appLauncherMark" aria-hidden="true">{app.mark}</span>
          <span className="appLauncherCopy"><strong>{app.name}</strong><small>{app.description}</small></span>
          <span className={`appLauncherState ${state?.online ? 'online' : state ? 'offline' : ''}`}>
            <i aria-hidden="true" />{state?.online ? 'Online' : state ? 'Unavailable' : 'Checking'}
          </span>
          <span className="appLauncherArrow" aria-hidden="true">↗</span>
        </a>;
      })}
    </div>
  </section>;
}
