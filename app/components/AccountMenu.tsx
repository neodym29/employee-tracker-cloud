'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { APPEARANCE_THEMES, isAppearanceFont, isAppearanceSize, type AppearanceTheme } from '@/lib/appearance';

export default function AccountMenu() {
  const pathname = usePathname();
  const menuRef = useRef<HTMLDetailsElement>(null);
  const [theme, setTheme] = useState<AppearanceTheme>('classic');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const syncTheme = () => {
      const current = document.documentElement.dataset.theme;
      if (APPEARANCE_THEMES.some(option => option.id === current)) setTheme(current as AppearanceTheme);
    };
    syncTheme();
    const closeOutside = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) menuRef.current.open = false;
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menuRef.current?.open) {
        menuRef.current.open = false;
        menuRef.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    window.addEventListener('appearance:updated', syncTheme);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape); window.removeEventListener('appearance:updated', syncTheme); };
  }, []);

  async function setAccountTheme(next: AppearanceTheme) {
    if (busy || next === theme) return;
    const root = document.documentElement;
    const font = isAppearanceFont(root.dataset.font) ? root.dataset.font : 'system';
    const size = isAppearanceSize(root.dataset.fontSize) ? root.dataset.fontSize : 'normal';
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/profile/appearance', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ theme: next, font, size }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Could not change theme');
      root.dataset.theme = next;
      setTheme(next);
      window.dispatchEvent(new Event('appearance:updated'));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <details ref={menuRef} className={`accountMenu ${pathname?.startsWith('/profile') ? 'active' : ''}`}>
    <summary className="navLink accountMenuTrigger" aria-label="Open profile menu">Profile <svg viewBox="0 0 12 8" aria-hidden="true"><path d="m1 1.5 5 5 5-5" /></svg></summary>
    <div className="accountMenuPanel">
      <a href="/profile" onClick={() => { if (menuRef.current) menuRef.current.open = false; }}>View profile</a>
      <a href="/profile#appearance" onClick={() => { if (menuRef.current) menuRef.current.open = false; }}>Appearance settings</a>
      <a href="/profile#security" onClick={() => { if (menuRef.current) menuRef.current.open = false; }}>Change password</a>
      <div className="accountMenuThemes"><span>Theme · {APPEARANCE_THEMES.find(option => option.id === theme)?.label}</span><div>{APPEARANCE_THEMES.map(option => <button key={option.id} type="button" className={theme === option.id ? 'selected' : ''} aria-label={`${option.label} theme`} aria-pressed={theme === option.id} title={option.label} disabled={busy} onClick={() => void setAccountTheme(option.id)} style={{ '--theme-swatch': option.swatch } as React.CSSProperties} />)}</div></div>
      {error && <p role="alert" className="accountMenuError">{error}</p>}
      <form action="/api/logout?next=/login" method="post"><button type="submit">Sign out</button></form>
    </div>
  </details>;
}
