'use client';

import { usePathname } from 'next/navigation';

export default function DashboardMenu() {
  const pathname = usePathname();
  const active = pathname === '/dashboard' || pathname?.startsWith('/dashboard/');

  return <details className={`dashboardMenu ${active ? 'active' : ''}`}>
    <summary className="navLink dashboardNavLink" aria-label="Open dashboard menu">
      <span>Dashboard</span>
      <svg viewBox="0 0 12 8" aria-hidden="true"><path d="m1 1.5 5 5 5-5" /></svg>
    </summary>
    <div className="dashboardMenuPanel">
      <a aria-label="Compute and APIs dashboard" className={pathname === '/dashboard' ? 'active' : ''} href="/dashboard">
        <span className="dashboardMenuIcon" aria-hidden="true">⌁</span>
        <span><strong>Compute &amp; APIs</strong><small>Apps, services, and infrastructure</small></span>
      </a>
      <a aria-label="Project updates dashboard" className={pathname?.startsWith('/dashboard/projects') || pathname?.startsWith('/dashboard/employees') ? 'active' : ''} href="/dashboard/projects">
        <span className="dashboardMenuIcon" aria-hidden="true">P</span>
        <span><strong>Project updates</strong><small>Daily changes by project</small></span>
      </a>
    </div>
  </details>;
}
