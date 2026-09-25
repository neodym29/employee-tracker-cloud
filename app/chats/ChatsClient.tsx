'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

type Person = { id: string; name: string; account_type?: string; accountType?: string; isAdmin?: boolean };
type Chat = { id: string; kind: 'group' | 'dm'; title: string | null; members: Person[]; is_admin: boolean; last_message: string | null; unread_count: number; updated_at: string };
type Message = { id: string; parent_message_id: string | null; parent_body: string | null; sender_id: string; sender_name: string; body: string; created_at: string; edited_at: string | null; deleted_at: string | null };

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'Chat could not be loaded');
  return data as T;
}

function messageTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function messageDay(value: string) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return 'Today';
  return date.toLocaleDateString([], { month: 'long', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export default function ChatsClient({ userId }: { userId: string }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [mode, setMode] = useState<'dm' | 'group' | null>(null);
  const [name, setName] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState('');
  const [optionsId, setOptionsId] = useState<string | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadChats = useCallback(async () => {
    try {
      const data = await api<{ chats: Chat[] }>('/api/chats');
      setChats(data.chats);
      const requested = new URLSearchParams(window.location.search).get('conversation');
      setSelectedId(current => current && data.chats.some(chat => chat.id === current) ? current : requested && data.chats.some(chat => chat.id === requested) ? requested : null);
    } catch (cause) { setError((cause as Error).message); }
  }, []);

  const loadMessages = useCallback(async (conversationId: string) => {
    try {
      const data = await api<{ messages: Message[] }>(`/api/chats/${conversationId}/messages`);
      setMessages(data.messages);
    } catch (cause) { setError((cause as Error).message); }
  }, []);

  useEffect(() => {
    void loadChats();
    void api<{ people: Person[] }>('/api/chats/people').then((data) => setPeople(data.people)).catch((cause) => setError(cause.message));
    const timer = window.setInterval(() => void loadChats(), 8_000);
    return () => window.clearInterval(timer);
  }, [loadChats]);

  useEffect(() => {
    if (!selectedId) return;
    setMessages([]);
    void loadMessages(selectedId);
    const timer = window.setInterval(() => void loadMessages(selectedId), 8_000);
    return () => window.clearInterval(timer);
  }, [selectedId, loadMessages]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [messages.length, selectedId]);

  const selected = chats.find((chat) => chat.id === selectedId);
  const title = (chat: Chat) => chat.kind === 'group' ? chat.title || 'Group' : chat.members.find((member) => member.id !== userId)?.name || 'Direct message';
  const query = search.trim().toLocaleLowerCase();
  const groups = chats.filter((chat) => chat.kind === 'group' && (!query || title(chat).toLocaleLowerCase().includes(query)));
  const peopleWithChats = people.map((person) => ({ person, chat: chats.find((chat) => chat.kind === 'dm' && chat.members.some((member) => member.id === person.id)) })).sort((a, b) => {
    if (a.chat && b.chat) return new Date(b.chat.updated_at).getTime() - new Date(a.chat.updated_at).getTime();
    return Number(Boolean(b.chat)) - Number(Boolean(a.chat)) || a.person.name.localeCompare(b.person.name);
  }).filter(({ person }) => !query || person.name.toLocaleLowerCase().includes(query));
  function openChat(chatId: string) {
    setReplyTo(null);
    setEditingId(null);
    setOptionsId(null);
    setHeaderMenuOpen(false);
    setSelectedId(chatId);
  }

  async function openPerson(person: Person, existing?: Chat) {
    if (saving) return;
    if (existing) { openChat(existing.id); return; }
    setSaving(true);
    setError('');
    try {
      const created = await api<{ chat: { id: string } }>('/api/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'dm', userId: person.id }) });
      await loadChats();
      openChat(created.chat.id);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }

  async function createConversation() {
    if (!mode || saving) return;
    setSaving(true);
    setError('');
    try {
      const body = mode === 'dm' ? { kind: mode, userId: memberIds[0] } : { kind: mode, title: name, userIds: memberIds };
      const created = await api<{ chat: { id: string } }>('/api/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      setMode(null); setName(''); setMemberIds([]);
      await loadChats();
      setSelectedId(created.chat.id);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }

  async function send() {
    const text = draft.trim();
    if (!selectedId || !text || saving) return;
    setSaving(true);
    setError('');
    try {
      await api(`/api/chats/${selectedId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: text, ...(replyTo ? { parentMessageId: replyTo.id } : {}) }) });
      setDraft(''); setReplyTo(null); await loadMessages(selectedId);
      await loadChats();
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }

  async function saveEdit() {
    if (!selectedId || !editingId || !editingBody.trim() || saving) return;
    setSaving(true); setError('');
    try {
      await api(`/api/chats/${selectedId}/messages/${editingId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: editingBody.trim() }) });
      setEditingId(null); setOptionsId(null);
      await loadMessages(selectedId);
      await loadChats();
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }

  async function removeMessage(message: Message) {
    if (!selectedId || saving || !window.confirm('Delete this message for everyone? Replies will remain.')) return;
    setSaving(true); setError('');
    try {
      await api(`/api/chats/${selectedId}/messages/${message.id}`, { method: 'DELETE' });
      setOptionsId(null); setEditingId(null);
      await loadMessages(selectedId);
      await loadChats();
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }

  async function removeChat() {
    if (!selectedId || !selected || saving) return;
    if (selected.kind === 'group') {
      if (!selected.is_admin) return;
      const typed = window.prompt(`Deleting “${title(selected)}” removes the group and all its messages for everyone. Type the group name to continue.`);
      if (typed !== title(selected) || !window.confirm('Delete this group for everyone? This cannot be undone.')) return;
    } else if (!window.confirm('Remove this chat from your list and clear its history for you? The other person keeps their messages.')) return;
    setSaving(true); setError('');
    try {
      await api(`/api/chats/${selectedId}`, { method: 'DELETE' });
      setSelectedId(null); setMessages([]); setReplyTo(null); setHeaderMenuOpen(false);
      await loadChats();
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }

  async function makeGroupAdmin(member: Person) {
    if (!selectedId || !selected?.is_admin || saving) return;
    setSaving(true); setError('');
    try {
      await api(`/api/chats/${selectedId}/admins`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: member.id }) });
      await loadChats();
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }

  function messageOptions(message: Message) {
    if (message.deleted_at) return null;
    return <div className="nexusMessageActions">
      <button type="button" className="nexusMessageMenuButton" aria-label={`Options for message from ${message.sender_id === userId ? 'you' : message.sender_name}`} aria-expanded={optionsId === message.id} onClick={() => setOptionsId(current => current === message.id ? null : message.id)}>⌄</button>
      {optionsId === message.id && <div className="nexusMessageMenu">
        <button type="button" onClick={() => { setOptionsId(null); setReplyTo(message); }}>Reply</button>
        {message.sender_id === userId && <><button type="button" onClick={() => { setEditingId(message.id); setEditingBody(message.body); setOptionsId(null); }}>Edit</button><button type="button" className="danger" onClick={() => void removeMessage(message)}>Delete</button></>}
      </div>}
    </div>;
  }

  function messageContent(message: Message) {
    if (editingId === message.id) return <div className="nexusEditMessage"><textarea aria-label="Edit message" value={editingBody} maxLength={4000} onChange={event => setEditingBody(event.target.value)} /><div><button type="button" onClick={() => { setEditingId(null); setEditingBody(''); }}>Cancel</button><button type="button" disabled={!editingBody.trim() || saving} onClick={() => void saveEdit()}>Save</button></div></div>;
    return <p className={message.deleted_at ? 'nexusDeletedMessage' : ''}>{message.body}</p>;
  }

  function messageCard(message: Message, previous?: Message) {
    const own = message.sender_id === userId;
    const continuous = previous?.sender_id === message.sender_id && new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() < 5 * 60_000;
    return <article className={`nexusDirectMessage ${own ? 'own' : 'incoming'} ${continuous ? 'continuous' : ''}`} key={message.id}>
      <div className="nexusDirectBubble">
        {selected?.kind === 'group' && !own && !continuous && <strong className="nexusMessageSender">{message.sender_name}</strong>}
        {message.parent_body && <blockquote>{message.parent_body}</blockquote>}
        {messageContent(message)}
        <span className="nexusBubbleTail"><time dateTime={message.created_at}>{messageTime(message.created_at)}</time>{message.edited_at && !message.deleted_at && <span>edited</span>}</span>
        {messageOptions(message)}
      </div>
    </article>;
  }

  return <div className={`nexusChatsPage ${selected ? 'hasChat' : ''}`}>
    <aside className="nexusChatSidebar" aria-label="Chats sidebar">
      <div className="nexusSidebarTop"><span>NEO-NEXUS</span><div><h1>Chats</h1><button type="button" onClick={() => { setMode('group'); setMemberIds([]); }} aria-label="New group" title="New group">+</button></div></div>
      <label className="nexusChatSearch"><span className="srOnly">Search chats and people</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search chats and people" /></label>
      <div className="nexusSidebarScroll">
        <section className="nexusSidebarSection" aria-label="Groups"><div className="nexusSectionHeading"><h2>Groups</h2><button type="button" onClick={() => { setMode('group'); setMemberIds([]); }} aria-label="Create group" title="Create group">+</button></div>
          {groups.map((chat) => <button key={chat.id} type="button" className={`nexusConversation ${selectedId === chat.id ? 'selected' : ''}`} onClick={() => openChat(chat.id)} aria-current={selectedId === chat.id ? 'true' : undefined}><span className="nexusHashIcon" aria-hidden="true">#</span><span className="nexusConversationText"><strong>{title(chat)}</strong><small>{chat.last_message || `${chat.members.length} members`}</small></span>{chat.unread_count > 0 && <span className="nexusUnread" aria-label={`${chat.unread_count} unread messages`}>{chat.unread_count}</span>}</button>)}
          {groups.length === 0 && <p className="nexusEmptySidebar">{query ? 'No matching groups' : 'No groups yet. Create one to talk together.'}</p>}
        </section>
        <section className="nexusSidebarSection" aria-label="People"><div className="nexusSectionHeading"><h2>People</h2><span>{peopleWithChats.length}</span></div>
          {peopleWithChats.map(({ person, chat }) => <button key={person.id} type="button" disabled={saving} className={`nexusConversation ${chat && selectedId === chat.id ? 'selected' : ''}`} onClick={() => void openPerson(person, chat)} aria-label={`Message ${person.name}`} aria-current={chat && selectedId === chat.id ? 'true' : undefined}><span className="nexusChatIcon nexusPersonIcon" aria-hidden="true">{person.name.slice(0, 1).toUpperCase()}</span><span className="nexusConversationText"><strong>{person.name}</strong><small>{chat?.last_message || person.account_type || person.accountType || 'Direct message'}</small></span>{chat && chat.unread_count > 0 && <span className="nexusUnread" aria-label={`${chat.unread_count} unread messages`}>{chat.unread_count}</span>}</button>)}
          {peopleWithChats.length === 0 && <p className="nexusEmptySidebar">{query ? 'No matching people' : 'No teammates available yet.'}</p>}
        </section>
      </div>
    </aside>
    <section className="nexusChatMain" aria-label="Messages">{selected ? <>
      <header className="nexusConversationHeader"><button type="button" className="nexusMobileBack" onClick={() => { setSelectedId(null); setHeaderMenuOpen(false); }} aria-label="Back to chats">←</button>{selected.kind === 'group' ? <span className="nexusHashIcon" aria-hidden="true">#</span> : <span className="nexusChatIcon nexusPersonIcon" aria-hidden="true">{title(selected).slice(0, 1).toUpperCase()}</span>}<div><h2>{title(selected)}</h2><p>{selected.kind === 'group' ? `${selected.members.length} members${selected.is_admin ? ' · You are a group admin' : ''}` : 'Direct message'}</p></div><div className="nexusHeaderActions"><button type="button" className="nexusHeaderMenuButton" aria-label={selected.kind === 'group' ? 'Group options' : 'Chat options'} aria-expanded={headerMenuOpen} onClick={() => setHeaderMenuOpen(value => !value)}>⌄</button>{headerMenuOpen && <div className="nexusHeaderMenu">{selected.kind === 'group' ? <><strong>Group members</strong>{selected.members.map(member => <div className="nexusGroupMember" key={member.id}><span>{member.id === userId ? 'You' : member.name}{member.isAdmin && <small> · admin</small>}</span>{selected.is_admin && !member.isAdmin && <button type="button" disabled={saving} onClick={() => void makeGroupAdmin(member)}>Make admin</button>}</div>)}{selected.is_admin && <button type="button" className="danger" onClick={() => void removeChat()}>Delete group for everyone</button>}</> : <button type="button" className="danger" onClick={() => void removeChat()}>Delete chat for me</button>}</div>}</div></header>
      <div className="nexusMessageList nexusDmMessageList">
        {messages.length > 0 && <div className="nexusMessagesSpacer" aria-hidden="true" />}
        {messages.length ? messages.map((message, index) => <Fragment key={message.id}>
          {(!index || new Date(message.created_at).toDateString() !== new Date(messages[index - 1].created_at).toDateString()) && <div className="nexusDayDivider"><span>{messageDay(message.created_at)}</span></div>}
          {messageCard(message, messages[index - 1])}
        </Fragment>) : <div className="nexusEmptyMessages">{selected.kind === 'group' ? <span className="nexusHashIcon" aria-hidden="true">#</span> : <span className="nexusChatIcon nexusPersonIcon" aria-hidden="true">{title(selected).slice(0, 1).toUpperCase()}</span>}<strong>{title(selected)}</strong><p>This is the start of your conversation. Messages are visible only to members.</p></div>}
        <div ref={bottomRef} />
      </div>
      <form className="nexusComposer nexusDirectComposer" onSubmit={(event) => { event.preventDefault(); void send(); }}>{replyTo && <div className="nexusReplyDraft"><span>Replying to {replyTo.sender_id === userId ? 'yourself' : replyTo.sender_name}: {replyTo.body}</span><button type="button" aria-label="Cancel reply" onClick={() => setReplyTo(null)}>×</button></div>}<label htmlFor="nexus-message" className="srOnly">Message {title(selected)}</label><textarea id="nexus-message" value={draft} maxLength={4000} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={`Message ${title(selected)}`} rows={1} /><div><small>Enter to send · Shift+Enter for a new line</small><button type="submit" disabled={!draft.trim() || saving}>Send</button></div></form>
    </> : <div className="nexusNoSelection"><span className="nexusWelcomeIcon" aria-hidden="true">✦</span><strong>Pick a conversation</strong><p>Choose a person or group from the sidebar to get started.</p></div>}</section>
    {error && <div className="nexusChatError" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {mode && <div className="nexusCreateOverlay" onClick={() => setMode(null)}><section className="nexusCreatePanel" role="dialog" aria-modal="true" aria-label={mode === 'group' ? 'Create group' : 'Start direct message'} onClick={(event) => event.stopPropagation()}>
      <div className="nexusCreateTop"><h2>{mode === 'group' ? 'Create a group' : 'Start a direct message'}</h2><button type="button" onClick={() => setMode(null)} aria-label="Close new chat">×</button></div>
      {mode === 'group' && <><label>Group name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="e.g. Product team" /></label><p className="nexusAdminHint">You’ll be the group admin and can appoint other admins.</p></>}
      <fieldset><legend>{mode === 'group' ? 'Add people' : 'Choose a person'}</legend><div className="nexusPeopleList">{people.map((person) => <label key={person.id}><input type={mode === 'group' ? 'checkbox' : 'radio'} name="chat-people" checked={memberIds.includes(person.id)} onChange={() => setMemberIds(mode === 'dm' ? [person.id] : memberIds.includes(person.id) ? memberIds.filter((value) => value !== person.id) : [...memberIds, person.id])} /><span>{person.name}</span><small>{person.account_type}</small></label>)}{people.length === 0 && <p>No approved teammates are available yet.</p>}</div></fieldset>
      <div className="nexusCreateFooter"><button type="button" className="secondaryButton" onClick={() => setMode(null)}>Cancel</button><button type="button" className="primaryButton" disabled={saving || (mode === 'dm' ? memberIds.length !== 1 : memberIds.length < 2 || name.trim().length < 2)} onClick={() => void createConversation()}>{saving ? 'Creating…' : mode === 'group' ? 'Create group' : 'Start chat'}</button></div>
    </section></div>}
  </div>;
}
