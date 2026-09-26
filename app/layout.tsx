import './globals.css';
import type { Metadata } from 'next';
import { Outfit } from 'next/font/google';
import { currentSession } from '@/lib/auth';
import ActiveNavLink from '@/app/components/ActiveNavLink';
import DashboardMenu from '@/app/components/DashboardMenu';
import ChatInbox from '@/app/components/ChatInbox';
import { unreadClientRequestCount } from '@/lib/client-requests';
import { DEFAULT_APPEARANCE } from '@/lib/appearance';
import { getOwnAppearance } from '@/lib/profiles';
import AccountMenu from '@/app/components/AccountMenu';
import NexusMark from '@/app/components/NexusMark';

const outfit = Outfit({ subsets: ['latin'], weight: 'variable', variable: '--font-outfit', display: 'swap' });

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
    <html lang="en" className={outfit.variable} data-theme={appearance.theme} data-font={appearance.font} data-font-size={appearance.size}>
      <body>
        <header className="siteHeader">
          <nav className="nav" aria-label="Primary navigation">
            <a className="brand" href="/" aria-label="Neo-Nexus home"><span className="brandGyro"><NexusMark className="logo" /></span><span>Neo-Nexus</span></a>
            {session ? <>
              <div className="navPrimary">
                  <DashboardMenu />
                  {session.account_type !== 'admin' && <ActiveNavLink href="/projects">Projects</ActiveNavLink>}
                  <ChatInbox mode="nav" initialClientRequests={unreadRequests} />
                  <ActiveNavLink href="/search">Search</ActiveNavLink>
                  {session.account_type !== 'admin' && <ActiveNavLink className="traceSetupNavLink" href="/trace-setup">Setup</ActiveNavLink>}
                  {session.account_type === 'admin' && <ActiveNavLink href="/admin/approve">Approvals</ActiveNavLink>}
              </div>
              <div className="navAccount">
                <AccountMenu />
              </div>
            </> : <div className="navAccount navGuestActions"><ActiveNavLink className="authNavLink" href="/signup" exact>Sign up</ActiveNavLink><ActiveNavLink className="authNavLink" href="/login" exact>Sign in</ActiveNavLink></div>}
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
