import './globals.css';
import type { Metadata } from 'next';
import { currentSession } from '@/lib/auth';

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
                  {session.account_type === 'admin' && <a className="navLink" href="/admin/approve">Approvals</a>}
                  {session.account_type !== 'admin' && <a className="navLink" href="/projects">Projects</a>}
                  <a className="navLink" href="/dashboard">Files</a>
                  <form className="inlineForm" action="/api/logout" method="post"><button className="navButton" type="submit">Sign out</button></form>
                </>
              ) : (
                <><a className="navLink authNavLink" href="/signup">Sign up</a><a className="navLink authNavLink" href="/login">Sign in</a></>
              )}
            </div>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
