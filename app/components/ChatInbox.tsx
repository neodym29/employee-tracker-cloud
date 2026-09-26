'use client';

import { useEffect, useRef, useState } from 'react';
import ActiveNavLink from './ActiveNavLink';
import { armAlertAudio, notifyNewClientRequest, notifyNewMessage } from '@/lib/message-alerts';

type Inbox = { total: number; conversations: { id: string; name: string; count: number; latestAt: string }[] };
type ClientRequests = { total: number; requests: { id: string; projectId: string; summary: string; createdAt: string }[] };

export default function ChatInbox({ mode, initialClientRequests = 0 }: { mode: 'nav' | 'dashboard'; initialClientRequests?: number }) {
  const [inbox, setInbox] = useState<Inbox>({ total: 0, conversations: [] });
  const [clientRequests, setClientRequests] = useState<ClientRequests>({ total: initialClientRequests, requests: [] });
  const previous = useRef<Map<string, { count: number; latestAt: string }> | null>(null);
  const latestRequestAt = useRef<number | null>(null);
  useEffect(() => {
    if (mode !== 'nav') return;
    document.addEventListener('pointerdown', armAlertAudio);
    document.addEventListener('keydown', armAlertAudio);
    return () => { document.removeEventListener('pointerdown', armAlertAudio); document.removeEventListener('keydown', armAlertAudio); };
  }, [mode]);
  useEffect(() => {
    let active = true;
    async function refresh() {
      if (mode === 'dashboard' && document.visibilityState !== 'visible') return;
      try {
        const response = await fetch('/api/notifications', { cache: 'no-store' });
        const data = await response.json();
        if (active && response.ok && data.ok) {
          const conversations = (data.chats?.conversations || []) as Inbox['conversations'];
          const requests = (data.clientRequests?.requests || []) as ClientRequests['requests'];
          if (mode === 'nav' && previous.current) {
            const newMessages = conversations.filter(chat => {
              const last = previous.current?.get(chat.id);
              return chat.count > 0 && (!last || (chat.count > last.count && new Date(chat.latestAt).getTime() > new Date(last.latestAt).getTime()));
            });
            if (newMessages[0]) notifyNewMessage(newMessages[0]);
          }
          if (mode === 'nav' && latestRequestAt.current !== null) {
            const newRequest = requests.find(request => new Date(request.createdAt).getTime() > (latestRequestAt.current || 0));
            if (newRequest) notifyNewClientRequest(newRequest);
          }
          previous.current = new Map(conversations.map(chat => [chat.id, { count: chat.count, latestAt: chat.latestAt }]));
          latestRequestAt.current = Math.max(latestRequestAt.current || 0, ...requests.map(request => new Date(request.createdAt).getTime()));
          setInbox({ total: Number(data.chats?.total || 0), conversations });
          setClientRequests({ total: Number(data.clientRequests?.total || 0), requests });
        }
      } catch { /* Keep the last known count during a temporary outage. */ }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [mode]);
  if (mode === 'nav') return <><ActiveNavLink className="chatsNavLink" href="/chats">Chats{inbox.total > 0 && <span className="chatNavBadge" aria-label={`${inbox.total} unread messages`}>{inbox.total > 99 ? '99+' : inbox.total}</span>}</ActiveNavLink>{clientRequests.total > 0 && <a className="navRequestAlert" href="/projects#client-requests" aria-label={`${clientRequests.total} unread client ${clientRequests.total === 1 ? 'request' : 'requests'}`}><span aria-hidden="true">!</span>{clientRequests.total}</a>}</>;
  if (!inbox.total) return null;
  return <section className="dashboardPanel chatInboxPreview" aria-label="Unread messages">
    <div className="panelHeader"><div><span className="sectionLabel">Messages</span><h2>{inbox.total} unread {inbox.total === 1 ? 'message' : 'messages'}</h2></div><a className="textLink" href="/chats">Open Chats</a></div>
    <div className="chatInboxRows">{inbox.conversations.slice(0, 5).map(chat => <a href={`/chats?conversation=${encodeURIComponent(chat.id)}`} key={chat.id}><strong>{chat.name}</strong><span>{chat.count} new</span></a>)}</div>
  </section>;
}
