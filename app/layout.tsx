import './globals.css';
import type { Metadata } from 'next';
import { currentSession } from '@/lib/auth';
import ActiveNavLink from '@/app/components/ActiveNavLink';
import DashboardMenu from '@/app/components/DashboardMenu';
import ChatInbox from '@/app/components/ChatInbox';
import ProfileNav from '@/app/components/ProfileNav';
import { unreadClientRequestCount } from '@/lib/client-requests';
import { DEFAULT_APPEARANCE } from '@/lib/appearance';
import { getOwnAppearance } from '@/lib/profiles';

export const metadata: Metadata = {
  title: 'Neo-Nexus | Project collaboration',
  description: 'One place for clients and engineers to ask, build, and see project progress.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  const appearance = session ? await getOwnAppearance(session.id).catch(() => DEFAULT_APPEARANCE) : DEFAULT_APPEARANCE;
  let unreadRequests = 0;
  if (session?.account_type === 'engineer') {
    try { unreadRequests = await unreadClientRequestCount(session); }
    catch { unreadRequests = 0; }
  }
  return (
    <html lang="en" data-theme={appearance.theme} data-font={appearance.font}>
      <body>
        <header className="siteHeader">
          <nav className="nav" aria-label="Primary navigation">
            <a className="brand" href="/" aria-label="Neo-Nexus home"><span className="logo" aria-hidden="true">N</span><span>Neo-Nexus</span></a>
            <div className="navActions">
              {session ? (
                <>
                  <DashboardMenu />
                  {session.account_type !== 'admin' && <ActiveNavLink href="/projects">Projects</ActiveNavLink>}
                  <ChatInbox mode="nav" initialClientRequests={unreadRequests} />
                  <ProfileNav userId={session.id} fallbackName={session.email.split('@')[0]} />
                  {session.account_type !== 'admin' && <ActiveNavLink className="traceSetupNavLink" href="/trace-setup">Set up Neo-Nexus CLI</ActiveNavLink>}
                  {session.account_type === 'admin' && <ActiveNavLink href="/admin/approve">Approvals</ActiveNavLink>}
                  <form className="inlineForm" action="/api/logout?next=/login" method="post"><button className="navButton navSignOut" type="submit">Sign out</button></form>
                </>
              ) : (
                <><ActiveNavLink className="authNavLink" href="/signup" exact>Sign up</ActiveNavLink><ActiveNavLink className="authNavLink" href="/login" exact>Sign in</ActiveNavLink></>
              )}
            </div>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
