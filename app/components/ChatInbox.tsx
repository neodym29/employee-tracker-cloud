'use client';

import { useEffect, useState } from 'react';
import ActiveNavLink from './ActiveNavLink';

type Inbox = { total: number; conversations: { id: string; name: string; count: number; latestAt: string }[] };

export default function ChatInbox({ mode }: { mode: 'nav' | 'dashboard' }) {
  const [inbox, setInbox] = useState<Inbox>({ total: 0, conversations: [] });
  useEffect(() => {
    let active = true;
    async function refresh() {
      if (document.visibilityState !== 'visible') return;
      try {
        const response = await fetch('/api/chats/notifications', { cache: 'no-store' });
        const data = await response.json();
        if (active && response.ok && data.ok) setInbox({ total: Number(data.total || 0), conversations: data.conversations || [] });
      } catch { /* Keep the last known count during a temporary outage. */ }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  if (mode === 'nav') return <ActiveNavLink className="chatsNavLink" href="/chats">Chats{inbox.total > 0 && <span className="chatNavBadge" aria-label={`${inbox.total} unread messages`}>{inbox.total > 99 ? '99+' : inbox.total}</span>}</ActiveNavLink>;
  if (!inbox.total) return null;
  return <section className="dashboardPanel chatInboxPreview" aria-label="Unread messages">
    <div className="panelHeader"><div><span className="sectionLabel">Messages</span><h2>{inbox.total} unread {inbox.total === 1 ? 'message' : 'messages'}</h2></div><a className="textLink" href="/chats">Open Chats</a></div>
    <div className="chatInboxRows">{inbox.conversations.slice(0, 5).map(chat => <a href={`/chats?conversation=${encodeURIComponent(chat.id)}`} key={chat.id}><strong>{chat.name}</strong><span>{chat.count} new</span></a>)}</div>
  </section>;
}
