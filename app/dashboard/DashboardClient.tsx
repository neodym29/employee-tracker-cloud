'use client';

import { useMemo, useState } from 'react';

const typeLabels: Record<string, string> = {
  activity_snapshot: 'Active window',
  app_open: 'Open app',
  app_subwindow: 'App activity',
  browser_tab: 'Web surfing',
  input_click: 'Click',
  window_focus: 'Focus change',
  audio_output: 'Audio',
};

type DashboardData = {
  companies: any[];
  users: any[];
  devices: any[];
  events: any[];
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

function audioDescription(event: any): string {
  const payload = event.payload || {};
  const app = payload.application_name || event.app_name || payload.process_binary || 'Unknown app';
  const track = payload.mpris_title || payload.media_title || payload.media_name || event.window_title || 'unknown audio';
  const artist = payload.mpris_artist || payload.media_artist;
  const status = payload.mpris_status || payload.state_hint;
  const source = payload.source;
  const volume = payload.volume ? String(payload.volume).replace(/^Volume:\s*/, '') : '';
  const mute = payload.mute ? `mute=${payload.mute}` : '';

  if (source === 'pactl-default-sink') {
    return [`Output device: ${payload.node_name || track}`, status, volume, mute].filter(Boolean).join(' · ');
  }

  return [
    `Playing in ${app}: ${artist ? `${artist} — ${track}` : track}`,
    status,
    payload.process_binary && `process=${payload.process_binary}`,
    volume,
    mute,
  ].filter(Boolean).join(' · ');
}

function eventSummary(event: any): string {
  const payload = event.payload || {};
  if (event.event_type === 'audio_output') return audioDescription(event);
  if (event.event_type === 'input_click') return payload.target_hint || [event.app_name, event.window_title].filter(Boolean).join(' · ');
  if (event.event_type === 'browser_tab') return [payload.title || event.window_title, payload.url || event.url].filter(Boolean).join(' · ');
  if (event.event_type === 'window_focus') return `${payload.from_app_name || '—'} → ${payload.to_app_name || event.app_name || '—'} · ${payload.to_window_title || event.window_title || ''}`;
  if (event.event_type === 'app_open') return [payload.app_name || event.app_name, payload.window_count != null && `${payload.window_count} windows`, payload.subwindow_count != null && `${payload.subwindow_count} tabs/views`].filter(Boolean).join(' · ');
  return [event.app_name, event.window_title, event.url].filter(Boolean).join(' · ');
}

function filteredEvents(events: any[], user: string, eventType: string, startTime: string, endTime: string) {
  const start = startTime ? new Date(startTime).getTime() : null;
  const end = endTime ? new Date(endTime).getTime() : null;
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
  if (events.length === 0) return <p className="muted">No events in this filter.</p>;
  return (
    <table className="table">
      <thead><tr><th>Captured</th><th>Received</th><th>Employee</th><th>Host</th><th>Type</th><th>Details</th></tr></thead>
      <tbody>{events.map((event:any, index:number)=>(
        <tr key={`${event.id || index}-${event.event_type}-${event.captured_at}`}>
          <td>{formatLocalTime(event.captured_at)}<br /><span className="muted">{relativeAge(event.captured_at)}</span></td>
          <td>{formatLocalTime(event.received_at)}<br /><span className="muted">uploaded {relativeAge(event.received_at)}</span></td>
          <td>{event.employee_email}</td>
          <td>{event.hostname}</td>
          <td>{typeLabels[event.event_type] || event.event_type}</td>
          <td>{eventSummary(event) || '—'}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

export default function DashboardClient({ data, configured, error }: { data: DashboardData; configured: boolean; error: string }) {
  const allUsers = useMemo(() => Array.from(new Set(data.events.map(rowUser).filter(Boolean))).sort(), [data.events]);
  const eventTypes = useMemo(() => Array.from(new Set(data.events.map((event) => event.event_type).filter(Boolean))).sort(), [data.events]);
  const now = useMemo(() => new Date(), []);
  const [user, setUser] = useState('all');
  const [eventType, setEventType] = useState('all');
  const [startTime, setStartTime] = useState(() => toDateTimeLocalValue(new Date(now.getTime() - 60 * 60 * 1000)));
  const [endTime, setEndTime] = useState(() => toDateTimeLocalValue(now));
  const visibleEvents = useMemo(
    () => filteredEvents(data.events, user, eventType, startTime, endTime),
    [data.events, user, eventType, startTime, endTime],
  );
  const latestReceived = data.events[0]?.received_at;
  const latestCaptured = data.events[0]?.captured_at;

  return (
    <div>
      <section className="card">
        <span className="pill">Admin dashboard</span>
        <h1>Neodym activity</h1>
        {!configured && <p className="warn">DATABASE_URL is not configured yet.</p>}
        {error && <p className="bad">Database error: {error}</p>}
        <p className="muted">Latest captured: {formatLocalTime(latestCaptured)} ({relativeAge(latestCaptured)}). Latest uploaded: {formatLocalTime(latestReceived)} ({relativeAge(latestReceived)}).</p>
      </section>

      <section className="card" style={{marginTop:16}}>
        <div className="cardHeader">
          <div>
            <h2>Latest raw events</h2>
            <p className="muted smallNote">Showing {visibleEvents.length} of {data.events.length}. Select an exact time window, user, and event type.</p>
          </div>
          <div className="cardFilters rawEventFilters" data-card-filter="true">
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
                {eventTypes.map((option) => <option value={option} key={option}>{typeLabels[option] || option}</option>)}
              </select>
            </label>
            <label>
              Start time
              <input className="filter-start-time" type="datetime-local" value={startTime} onChange={(event) => setStartTime(event.target.value)} />
            </label>
            <label>
              End time
              <input className="filter-end-time" type="datetime-local" value={endTime} onChange={(event) => setEndTime(event.target.value)} />
            </label>
          </div>
        </div>
        <EventsTable events={visibleEvents} />
        <p className="muted smallNote">Raw keystroke/character capture is intentionally not enabled because it can collect passwords, private messages, and secrets.</p>
      </section>
    </div>
  );
}
