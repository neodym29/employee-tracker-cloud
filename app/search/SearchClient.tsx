'use client';

import { useEffect, useState } from 'react';

type Result = {
  projects: { id: string; title: string; excerpt: string }[];
  messages: { id: string; conversation_id: string; kind: 'dm' | 'group'; title: string | null; sender_name: string; peer_name: string | null; excerpt: string; created_at: string }[];
  projectChats: { id: string; project_id: string; project_title: string; role: string; excerpt: string; created_at: string }[];
};

export default function SearchClient() {
  const [query, setQuery] = useState('');
  const [data, setData] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) { setData(null); setBusy(false); setError(''); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setBusy(true); setError('');
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { cache: 'no-store', signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || 'Search is unavailable');
        setData(result);
      } catch (cause) { if (!controller.signal.aborted) { setData(null); setError((cause as Error).message); } }
      finally { if (!controller.signal.aborted) setBusy(false); }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  const total = data ? data.projects.length + data.messages.length + data.projectChats.length : 0;
  return <div className="workSearchPage">
    <h1>Search work</h1>
    <label className="workSearchInput"><span className="srOnly">Search projects and conversations</span><input autoFocus value={query} maxLength={100} onChange={event => setQuery(event.target.value)} placeholder="Search projects and conversations" /></label>
    {query.trim().length < 2 ? <p className="workSearchHint">Enter at least two characters.</p> : busy ? <p role="status" className="workSearchHint">Searching…</p> : error ? <p role="alert" className="workSearchError">{error}</p> : data && <>
      <p className="workSearchCount" role="status">{total ? `${total} results` : 'No results'}</p>
      {data.projects.length > 0 && <section><h2>Projects</h2><div className="workSearchResults">{data.projects.map(project => <a key={project.id} href={`/projects/${project.id}`}><span>PROJECT</span><strong>{project.title}</strong>{project.excerpt && <p>{project.excerpt}</p>}</a>)}</div></section>}
      {data.messages.length > 0 && <section><h2>Team chats</h2><div className="workSearchResults">{data.messages.map(message => <a key={message.id} href={`/chats?conversation=${message.conversation_id}`}><span>{message.kind === 'group' ? `# ${message.title}` : message.peer_name || 'Direct message'} · {message.sender_name}</span><p>{message.excerpt}</p></a>)}</div></section>}
      {data.projectChats.length > 0 && <section><h2>Project chats</h2><div className="workSearchResults">{data.projectChats.map(message => <a key={message.id} href={`/projects/${message.project_id}`}><span>{message.project_title} · {message.role === 'assistant' ? 'Project agent' : 'Member'}</span><p>{message.excerpt}</p></a>)}</div></section>}
    </>}
  </div>;
}
