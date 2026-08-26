import './globals.css';
import type { Metadata } from 'next';
import { currentSession } from '@/lib/auth';
import ActiveNavLink from '@/app/components/ActiveNavLink';

export const metadata: Metadata = {
  title: 'Trace | Project collaboration',
  description: 'Match clients and engineers, keep project records, and confirm AI-assisted actions.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  return (
    <html lang="en">
      <body>
        <header className="siteHeader">
          <nav className="nav" aria-label="Primary navigation">
            <a className="brand" href="/" aria-label="Trace home"><span className="logo" aria-hidden="true">T</span><span>Trace</span></a>
            <div className="navActions">
              {session ? (
                <>
                  {session.account_type === 'admin' && <ActiveNavLink href="/admin/approve">Approvals</ActiveNavLink>}
                  {session.account_type !== 'admin' && <ActiveNavLink href="/projects">Projects</ActiveNavLink>}
                  {session.role === 'admin' && <ActiveNavLink href="/dashboard">Files</ActiveNavLink>}
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
