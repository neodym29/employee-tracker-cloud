'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

const typeLabels: Record<string, string> = {
  activity_snapshot: 'Active window',
  screenshot_capture: 'Screenshot',
  installer_smoke_test: 'Installer smoke test',
  terminal_command: 'Terminal command',
  app_open: 'Open app',
  app_subwindow: 'App activity',
  browser_tab: 'Web surfing',
  input_click: 'Click',
  activity_session: 'Activity session',
  typed_chunk: 'Typed chunk',
  shortcut: 'Shortcut',
  window_focus: 'Focus change',
  window_snapshot: 'Window snapshot',
  current_app: 'Current app',
  current_subwindow: 'Current subwindow',
  process_lifecycle: 'Process lifecycle',
  peripheral_snapshot: 'Peripheral snapshot',
  content_status: 'Content status',
  audio_output: 'Audio',
  browser_compliance: 'Browser safety',
  typing_activity: 'Typing activity',
  keyboard_status: 'Keyboard status',
  file_change: 'File change',
  clipboard_change: 'Clipboard change',
  auto_update_status: 'Auto-update',
};

const allEventTypes = [
  { value: 'activity_snapshot', label: typeLabels.activity_snapshot },
  { value: 'installer_smoke_test', label: typeLabels.installer_smoke_test },
  { value: 'auto_update_status', label: typeLabels.auto_update_status },
  { value: 'terminal_command', label: typeLabels.terminal_command },
  { value: 'browser_tab', label: typeLabels.browser_tab },
  { value: 'browser_compliance', label: typeLabels.browser_compliance },
  { value: 'input_click', label: typeLabels.input_click },
  { value: 'activity_session', label: typeLabels.activity_session },
  { value: 'typing_activity', label: typeLabels.typing_activity },
  { value: 'typed_chunk', label: typeLabels.typed_chunk },
  { value: 'shortcut', label: typeLabels.shortcut },
  { value: 'keyboard_status', label: typeLabels.keyboard_status },
  { value: 'clipboard_change', label: typeLabels.clipboard_change },
  { value: 'file_change', label: typeLabels.file_change },
  { value: 'screenshot_capture', label: typeLabels.screenshot_capture },
  { value: 'audio_output', label: typeLabels.audio_output },
  { value: 'app_open', label: typeLabels.app_open },
  { value: 'app_subwindow', label: typeLabels.app_subwindow },
  { value: 'window_focus', label: typeLabels.window_focus },
  { value: 'window_snapshot', label: typeLabels.window_snapshot },
  { value: 'current_app', label: typeLabels.current_app },
  { value: 'current_subwindow', label: typeLabels.current_subwindow },
  { value: 'process_lifecycle', label: typeLabels.process_lifecycle },
  { value: 'peripheral_snapshot', label: typeLabels.peripheral_snapshot },
  { value: 'content_status', label: typeLabels.content_status },
] as const;

type DashboardData = {
  companies: any[];
  users: any[];
  devices: any[];
  events: any[];
};

type DashboardFilters = {
  mode: 'latest' | 'range';
  user: string;
  eventType: string;
  startTime: string;
  endTime: string;
};

function eventTimestamp(event: any): string {
  return event.captured_at || event.received_at || '';
}

function toDateTimeLocalValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatLocalTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function relativeAge(value: string | null | undefined): string {
  if (!value) return 'unknown';
  const date = new Date(value);
  const ms = Date.now() - date.getTime();
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function rowUser(row: any): string {
  return row.employee_email || row.email || row.os_user || row.employee_username || '';
}

function activityLogEvents(events: any[]): any[] {
  return events.filter((event) => event.event_type !== 'browser_tab');
}

function currentOpenTabs(events: any[], user: string): any[] {
  const seen = new Set<string>();
  const tabs: any[] = [];
  for (const event of events) {
    if (event.event_type !== 'browser_tab') continue;
    if (user !== 'all' && rowUser(event) !== user) continue;
    const payload = event.payload || {};
    const key = [event.employee_email, event.hostname, payload.window_id, payload.url || event.url, payload.title || event.window_title].filter(Boolean).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    tabs.push(event);
  }
  return tabs.slice(0, 40);
}

function browserSafetyAlerts(events: any[], user: string): any[] {
  const latestByBrowser = new Map<string, any>();
  for (const event of events) {
    if (event.event_type !== 'browser_compliance') continue;
    if (user !== 'all' && rowUser(event) !== user) continue;
    const payload = event.payload || {};
    const key = [event.employee_email, event.hostname, payload.browser_key || event.app_name || payload.browser_name].filter(Boolean).join('|');
    const existing = latestByBrowser.get(key);
    const eventTime = new Date(eventTimestamp(event)).getTime();
    const existingTime = existing ? new Date(eventTimestamp(existing)).getTime() : -Infinity;
    if (!existing || eventTime >= existingTime) latestByBrowser.set(key, event);
  }
  return Array.from(latestByBrowser.values())
    .filter((event) => {
      const payload = event.payload || {};
      return payload.severity === 'critical' || event.severity === 'critical';
    })
    .slice(0, 12);
}

function audioDescription(event: any): string {
  const payload = event.payload || {};
  const app = payload.application_name || event.app_name || payload.process_binary || 'Unknown app';
  const contentTitle = payload.content_title || payload.mpris_title || payload.media_title;
  const contentUrl = payload.content_url;
  const track = contentTitle || payload.media_name || event.window_title || 'unknown audio';
  const artist = payload.mpris_artist || payload.media_artist;
  const status = payload.mpris_status || payload.state_hint;
  const source = payload.source;
  const volume = payload.volume ? String(payload.volume).replace(/^Volume:\s*/, '') : '';
  const mute = payload.mute ? `mute=${payload.mute}` : '';

  if (source === 'pactl-default-sink') {
    return [`Output device: ${payload.node_name || track}`, status, volume, mute].filter(Boolean).join(' · ');
  }

  return [
    `Playing: ${artist ? `${artist} — ${track}` : track}`,
    contentUrl,
    `app=${app}`,
    status,
    payload.process_binary && `process=${payload.process_binary}`,
    volume,
    mute,
  ].filter(Boolean).join(' · ');
}

function eventSummary(event: any): string {
  const payload = event.payload || {};
  const location = [event.app_name, event.window_title].filter(Boolean).join(' — ');
  if (event.event_type === 'audio_output') return audioDescription(event);
  if (event.event_type === 'browser_compliance') return [payload.note || 'Browser is open but extension telemetry is missing', payload.status && `status=${payload.status}`, payload.severity && `severity=${payload.severity}`, payload.browser_name || event.app_name].filter(Boolean).join(' · ');
  if (event.event_type === 'typing_activity') return [payload.note || 'typing activity', payload.field_hint && `field=${payload.field_hint}`, payload.key_count != null && `${payload.key_count} input events`, payload.text_length != null && `${payload.text_length} chars`, payload.word_count != null && `${payload.word_count} words`, payload.typed_text, payload.url || event.url].filter(Boolean).join(' · ');
  if (event.event_type === 'keyboard_status') return [payload.status || 'keyboard status', payload.reason || payload.note, payload.device_count != null && `${payload.device_count} readable keyboard devices`, payload.running === false && 'not listening'].filter(Boolean).join(' · ');
  if (event.event_type === 'auto_update_status') return [payload.status || 'auto-update', payload.current_version && `current=${payload.current_version}`, payload.latest_version && `latest=${payload.latest_version}`, payload.method && `method=${payload.method}`, payload.systemd_run_failed && 'systemd-run failed', payload.systemd_run_stderr || payload.systemd_run_error || payload.error].filter(Boolean).join(' · ');
  if (event.event_type === 'clipboard_change') {
    const content = typeof payload.content === 'string' ? payload.content.slice(0, 500) : '';
    return [
      payload.status || 'clipboard changed',
      location && `active window: ${location}`,
      payload.content_length != null && `${payload.content_length} chars`,
      payload.content_redacted && 'redacted',
      payload.content_truncated && 'truncated',
      payload.source && `source=${payload.source}`,
      content && `content: ${content}${payload.content.length > 500 ? '…' : ''}`,
    ].filter(Boolean).join(' · ');
  }
  if (event.event_type === 'file_change') {
    const content = typeof payload.content === 'string' ? payload.content.slice(0, 700) : '';
    return [
      `${payload.file_event_type || 'changed'} ${payload.relative_path || event.window_title || 'file'}`,
      payload.language && `lang=${payload.language}`,
      payload.file_size != null && `${payload.file_size} bytes`,
      payload.content_status && `content=${payload.content_status}`,
      payload.content_redacted && 'redacted',
      payload.content_reason && `reason=${payload.content_reason}`,
      content && `content: ${content}${payload.content.length > 700 ? '…' : ''}`,
    ].filter(Boolean).join(' · ');
  }
  if (event.event_type === 'typed_chunk') return [payload.note || 'typed chunk', location && `where typed: ${location}`, payload.reason && `reason=${payload.reason}`, payload.key_count != null && `${payload.key_count} keys`, payload.duration_seconds != null && `${payload.duration_seconds}s`, payload.typed_text].filter(Boolean).join(' · ');
  if (event.event_type === 'shortcut') return [payload.note || 'shortcut', location && `where typed: ${location}`, payload.shortcut, payload.keys_json].filter(Boolean).join(' · ');
  if (event.event_type === 'activity_session') return [payload.summary || 'activity session', payload.field_hints?.length && `fields=${payload.field_hints.join(', ')}`, payload.typed_text, payload.url || event.url].filter(Boolean).join(' · ');
  if (event.event_type === 'screenshot_capture') return [payload.status && `status=${payload.status}`, payload.backend && `backend=${payload.backend}`, payload.reason, payload.source_event_id && `source=${payload.source_event_id}`].filter(Boolean).join(' · ') || 'screenshot capture attempt';
  if (event.event_type === 'terminal_command') return [payload.terminal_command || event.window_title, payload.terminal_cwd && `cwd=${payload.terminal_cwd}`, payload.terminal_exit_code != null && `exit=${payload.terminal_exit_code}`].filter(Boolean).join(' · ');
  if (event.event_type === 'input_click') return payload.target_hint || [event.app_name, event.window_title].filter(Boolean).join(' · ');
  if (event.event_type === 'browser_tab') return [payload.title || event.window_title, payload.url || event.url].filter(Boolean).join(' · ');
  if (event.event_type === 'window_focus') return `${payload.from_app_name || '—'} → ${payload.to_app_name || event.app_name || '—'} · ${payload.to_window_title || event.window_title || ''}`;
  if (event.event_type === 'app_open') return [payload.app_name || event.app_name, payload.window_count != null && `${payload.window_count} windows`, payload.subwindow_count != null && `${payload.subwindow_count} tabs/views`].filter(Boolean).join(' · ');
  return [event.app_name, event.window_title, event.url].filter(Boolean).join(' · ');
}

function filteredEvents(events: any[], mode: 'latest' | 'range', user: string, eventType: string, startTime: string, endTime: string) {
  const start = mode === 'range' && startTime ? new Date(startTime).getTime() : null;
  const end = mode === 'range' && endTime ? new Date(endTime).getTime() : null;
  return events.filter((event) => {
    const matchesUser = user === 'all' || rowUser(event) === user;
    const matchesType = eventType === 'all' || event.event_type === eventType;
    const timestamp = new Date(eventTimestamp(event)).getTime();
    const matchesStart = !start || !Number.isFinite(timestamp) || timestamp >= start;
    const matchesEnd = !end || !Number.isFinite(timestamp) || timestamp <= end;
    return matchesUser && matchesType && matchesStart && matchesEnd;
  });
}

function EventsTable({ events }: { events: any[] }) {
  const [screenshots, setScreenshots] = useState<Record<string, { loading?: boolean; image?: string; error?: string }>>({});
  async function showScreenshot(eventId: string | number) {
    const key = String(eventId);
    setScreenshots((current) => ({ ...current, [key]: { loading: true } }));
    try {
      const response = await fetch(`/api/screenshot?id=${encodeURIComponent(key)}`);
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Could not load screenshot');
      setScreenshots((current) => ({ ...current, [key]: { image: payload.image } }));
    } catch (error) {
      setScreenshots((current) => ({ ...current, [key]: { error: error instanceof Error ? error.message : String(error) } }));
    }
  }

  if (events.length === 0) return <p className="muted">No events in this filter.</p>;
  return (
    <table className="table">
      <thead><tr><th>Captured</th><th>Received</th><th>Employee</th><th>Host</th><th>Type</th><th>Details</th></tr></thead>
      <tbody>{events.map((event:any, index:number)=>{
        const screenshot = screenshots[String(event.id)];
        return (
        <tr key={`${event.id || index}-${event.event_type}-${event.captured_at}`}>
          <td>{formatLocalTime(event.captured_at)}<br /><span className="muted">{relativeAge(event.captured_at)}</span></td>
          <td>{formatLocalTime(event.received_at)}<br /><span className="muted">uploaded {relativeAge(event.received_at)}</span></td>
          <td>{event.employee_email}</td>
          <td>{event.hostname}</td>
          <td>{typeLabels[event.event_type] || event.event_type}</td>
          <td>
            {eventSummary(event) || '—'}
            {event.has_screenshot && <div style={{marginTop: 8}}>
              <button type="button" onClick={() => showScreenshot(event.id)} disabled={Boolean(screenshot?.loading)}>{screenshot?.loading ? 'Loading…' : 'Show'}</button>
              {screenshot?.error && <span className="bad" style={{marginLeft: 8}}>{screenshot.error}</span>}
              {screenshot?.image && <div style={{marginTop: 8}}><img src={screenshot.image} alt={`Screenshot for ${event.employee_email} at ${formatLocalTime(event.captured_at)}`} style={{maxWidth: '520px', width: '100%', border: '1px solid #d7dfef', borderRadius: 8}} /></div>}
            </div>}
          </td>
        </tr>
      );})}</tbody>
    </table>
  );
}

function CurrentOpenTabs({ tabs }: { tabs: any[] }) {
  if (tabs.length === 0) return <p className="muted">No currently open browser tabs reported yet.</p>;
  return (
    <table className="table">
      <thead><tr><th>Last seen</th><th>Employee</th><th>Host</th><th>Browser</th><th>Tab</th></tr></thead>
      <tbody>{tabs.map((tab:any, index:number)=>{
        const payload = tab.payload || {};
        const title = payload.title || tab.window_title || 'Untitled browser tab';
        const url = payload.url || tab.url || '';
        return (
          <tr key={`${tab.id || index}-${tab.employee_email}-${payload.window_id || url}`}>
            <td>{formatLocalTime(tab.captured_at)}<br /><span className="muted">{relativeAge(tab.captured_at)}</span></td>
            <td>{tab.employee_email}</td>
            <td>{tab.hostname}</td>
            <td>{payload.app_name || tab.app_name || 'Browser'}</td>
            <td><strong>{title}</strong>{url && <><br /><span className="muted">{url}</span></>}</td>
          </tr>
        );
      })}</tbody>
    </table>
  );
}

function BrowserSafetyAlerts({ alerts }: { alerts: any[] }) {
  if (alerts.length === 0) return null;
  return (
    <section className="card redAlert browser-safety-alerts" style={{ marginTop: 16 }}>
      <div className="cardHeader">
        <div>
          <h2>Browser safety alerts</h2>
          <p className="smallNote">Red means a browser is open, but no fresh extension data is coming in. The extension may be missing, disabled, incognito/private, unsupported, or portable.</p>
        </div>
      </div>
      <div className="grid">
        {alerts.map((event:any, index:number) => {
          const payload = event.payload || {};
          return (
            <div className="alertBox" key={`${event.id || index}-${event.employee_email}-${payload.browser_key || event.app_name}`}>
              <strong>{event.employee_email}</strong> · {event.hostname}<br />
              <span className="bad">{payload.browser_name || event.app_name || 'Browser'}: extension missing, disabled, incognito/private, unsupported, or portable</span><br />
              <span>{payload.note || eventSummary(event)}</span><br />
              <span className="muted">Last checked {formatLocalTime(event.captured_at)} ({relativeAge(event.captured_at)})</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function DashboardClient({ data, configured, error, initialFilters }: { data: DashboardData; configured: boolean; error: string; initialFilters: DashboardFilters }) {
  const router = useRouter();
  const pathname = usePathname();
  const allUsers = useMemo(() => Array.from(new Set(data.devices.map(rowUser).filter(Boolean))).sort(), [data.devices]);
  const now = useMemo(() => new Date(), []);
  const [mode, setMode] = useState<'latest' | 'range'>(initialFilters.mode || 'latest');
  const [user, setUser] = useState(initialFilters.user || 'all');
  const [eventType, setEventType] = useState(initialFilters.eventType || 'all');
  const [startTime, setStartTime] = useState(initialFilters.startTime || toDateTimeLocalValue(new Date(now.getTime() - 60 * 60 * 1000)));
  const [endTime, setEndTime] = useState(initialFilters.endTime || toDateTimeLocalValue(now));

  useEffect(() => {
    const params = new URLSearchParams();
    if (mode !== 'latest') params.set('mode', mode);
    if (user !== 'all') params.set('user', user);
    if (eventType !== 'all') params.set('eventType', eventType);
    if (mode === 'range') {
      if (startTime) params.set('start', startTime);
      if (endTime) params.set('end', endTime);
    }
    const nextUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;
    router.replace(nextUrl, { scroll: false });
  }, [mode, user, eventType, startTime, endTime, pathname, router]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      router.refresh();
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [router]);

  const visibleEvents = useMemo(
    () => filteredEvents(activityLogEvents(data.events), mode, user, eventType, startTime, endTime),
    [data.events, mode, user, eventType, startTime, endTime],
  );
  const visibleOpenTabs = useMemo(() => currentOpenTabs(data.events, user), [data.events, user]);
  const visibleBrowserSafetyAlerts = useMemo(() => browserSafetyAlerts(data.events, user), [data.events, user]);
  const latestReceived = data.events[0]?.received_at;
  const latestCaptured = data.events[0]?.captured_at;
  const rangeDisabled = mode === 'latest';

  return (
    <div>
      <section className="card">
        <span className="pill">Admin dashboard</span>
        <h1>Neodym activity</h1>
        {!configured && <p className="warn">DATABASE_URL is not configured yet.</p>}
        {error && <p className="bad">Database error: {error}</p>}
        <p className="muted">Latest captured: {formatLocalTime(latestCaptured)} ({relativeAge(latestCaptured)}). Latest uploaded: {formatLocalTime(latestReceived)} ({relativeAge(latestReceived)}).</p>
      </section>

      <BrowserSafetyAlerts alerts={visibleBrowserSafetyAlerts} />

      <section className="card" style={{marginTop:16}}>
        <div className="cardHeader">
          <div>
            <h2>Currently open tabs</h2>
            <p className="muted smallNote">
              These are live browser state snapshots, so they are separated from the activity logs below.
            </p>
          </div>
        </div>
        <CurrentOpenTabs tabs={visibleOpenTabs} />
      </section>

      <section className="card" style={{marginTop:16}}>
        <div className="cardHeader">
          <div>
            <h2>Activity logs</h2>
            <p className="muted smallNote">
              Showing {visibleEvents.length} of {activityLogEvents(data.events).length}. Use Latest events for the live feed, or choose Selected time period for historical filters.
            </p>
          </div>
          <div className="cardActions">
            <button className="refresh-dashboard" type="button" onClick={() => router.refresh()}>Refresh latest data</button>
          </div>
          <div className="cardFilters rawEventFilters" data-card-filter="true">
            <label>
              View
              <select className="filter-mode" value={mode} onChange={(event) => setMode(event.target.value as 'latest' | 'range')}>
                <option value="latest">Latest events</option>
                <option value="range">Selected time period</option>
              </select>
            </label>
            <label>
              User
              <select className="filter-user" value={user} onChange={(event) => setUser(event.target.value)}>
                <option value="all">All users</option>
                {allUsers.map((option) => <option value={option} key={option}>{option}</option>)}
              </select>
            </label>
            <label>
              Event type
              <select className="filter-event-type" value={eventType} onChange={(event) => setEventType(event.target.value)}>
                <option value="all">All event types</option>
                {allEventTypes.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>
              Start time
              <input className="filter-start-time" type="datetime-local" value={startTime} disabled={rangeDisabled} onChange={(event) => setStartTime(event.target.value)} />
            </label>
            <label>
              End time
              <input className="filter-end-time" type="datetime-local" value={endTime} disabled={rangeDisabled} onChange={(event) => setEndTime(event.target.value)} />
            </label>
          </div>
        </div>
        <EventsTable events={visibleEvents} />
        <p className="muted smallNote">Browser search and normal text fields log exact typed text; password, OTP, token, card, CVV, and PIN-like fields stay redacted.</p>
      </section>
    </div>
  );
}
