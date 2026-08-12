import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Neodym AI Files Tracker',
  description: 'Files-only metadata tracking for approved AI coding agents',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <div className="nav">
            <div className="brand"><div className="logo" /> Neodym AI Files Tracker</div>
            <div style={{display:'flex', gap:12, flexWrap:'wrap'}}>
              <a href="/">Home</a>
              <a href="/register">Company registration</a>
              <a href="/signup">Employee signup</a>
              <a href="/admin/approve">Approve</a>
              <a href="/dashboard">Admin dashboard</a>
              <a href="/employee">Employee setup</a>
              <a href="/login">Login</a>
              <a href="/api/health">Health</a>
            </div>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
