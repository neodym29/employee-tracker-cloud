import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Trace — AI file changes',
  description: 'See file changes made by approved AI coding agents, and nothing else.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="siteHeader">
          <nav className="nav" aria-label="Primary navigation">
            <a className="brand" href="/" aria-label="Trace home">
              <span className="logo" aria-hidden="true">T</span>
              <span>Trace</span>
            </a>
            <div className="navActions">
              <a className="navLink" href="/login">Sign in</a>
              <a className="navButton" href="/dashboard">Open dashboard</a>
            </div>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
