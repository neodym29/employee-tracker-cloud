import './globals.css';
import type { Metadata } from 'next';
import { currentSession } from '@/lib/auth';
import ActiveNavLink from '@/app/components/ActiveNavLink';
import DashboardMenu from '@/app/components/DashboardMenu';
import ChatInbox from '@/app/components/ChatInbox';
import { unreadClientRequestCount } from '@/lib/client-requests';

export const metadata: Metadata = {
  title: 'Neo-Nexus | Project collaboration',
  description: 'Match clients and engineers, keep project records, and confirm AI-assisted actions.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  let unreadRequests = 0;
  if (session?.account_type === 'engineer') {
    try { unreadRequests = await unreadClientRequestCount(session); }
    catch { unreadRequests = 0; }
  }
  return (
    <html lang="en">
      <body>
        <header className="siteHeader">
          <nav className="nav" aria-label="Primary navigation">
            <a className="brand" href="/" aria-label="Neo-Nexus home"><span className="logo" aria-hidden="true">N</span><span>Neo-Nexus</span></a>
            <div className="navActions">
              {session ? (
                <>
                  <DashboardMenu />
                  {session.account_type !== 'admin' && <ActiveNavLink href="/projects">Projects</ActiveNavLink>}
                  <ChatInbox mode="nav" />
                  {session.account_type === 'engineer' && unreadRequests > 0 && <a className="navRequestAlert" href="/projects#client-requests" aria-label={`${unreadRequests} unread client ${unreadRequests === 1 ? 'request' : 'requests'}`}><span aria-hidden="true">!</span>{unreadRequests}</a>}
                  {session.account_type !== 'admin' && <ActiveNavLink className="traceSetupNavLink" href="/trace-setup">Set up Neo-Nexus CLI</ActiveNavLink>}
                  {session.account_type === 'admin' && <ActiveNavLink href="/admin/approve">Approvals</ActiveNavLink>}
                  <form className="inlineForm" action="/api/logout?next=/login" method="post"><button className="navButton" type="submit">Switch account</button></form>
                  <form className="inlineForm" action="/api/logout" method="post"><button className="navButton" type="submit">Sign out</button></form>
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
