'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type HealthStatus = 'up' | 'down' | 'degraded' | 'stale' | 'unknown';
type StatusItem = {
  id: string;
  name: string;
  type: 'hardware' | 'api';
  status: HealthStatus;
  latencyMs: number | null;
  ageSeconds: number | null;
  error: string | null;
  sourceName: string;
  publicUrl: string | null;
};
type StatusNode = {
  id: string;
  name: string;
  publicUrl: string | null;
  dashboardAvailable: boolean;
  ageSeconds: number | null;
  status: HealthStatus;
};
type StatusData = {
  nodeName: string;
  publicUrl: string | null;
  sourceNode: string;
  generatedAt: number | null;
  items: StatusItem[];
  nodes: StatusNode[];
};

const labels: Record<HealthStatus, string> = { up: 'Online', down: 'Down', degraded: 'Degraded', stale: 'Stale', unknown: 'Unknown' };

function age(seconds: number | null) {
  if (seconds == null) return 'Not available';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

function latency(milliseconds: number | null) {
  if (milliseconds == null) return 'Not available';
  return Math.round(milliseconds) === 0 ? 'Local' : `${Math.round(milliseconds)} ms`;
}

function StatusPill({ status }: { status: HealthStatus }) {
  return <span className={`healthPill health-${status}`}><span aria-hidden="true" />{labels[status]}</span>;
}

function TargetCard({ item }: { item: StatusItem }) {
  return <article className="healthCard">
    <div className="healthCardHeading"><div><span className="sectionLabel">{item.type}</span><h3>{item.name}</h3></div><StatusPill status={item.status} /></div>
    <dl className="healthMeta">
      <div><dt>Latency</dt><dd>{latency(item.latencyMs)}</dd></div>
      <div><dt>Checked</dt><dd>{age(item.ageSeconds)}</dd></div>
      <div><dt>Source</dt><dd>{item.sourceName}</dd></div>
      <div><dt>ID</dt><dd>{item.id}</dd></div>
    </dl>
    {item.error && <p className="healthError">{item.error}</p>}
    {item.publicUrl && <a className="healthCardLink" href={item.publicUrl} target="_blank" rel="noreferrer">Open dashboard <span aria-hidden="true">↗</span></a>}
  </article>;
}

function NodeCard({ node }: { node: StatusNode }) {
  return <article className="healthCard">
    <div className="healthCardHeading"><div><span className="sectionLabel">{node.id}</span><h3>{node.name}</h3></div><StatusPill status={node.status} /></div>
    <dl className="healthMeta healthMetaCompact">
      <div><dt>Last seen</dt><dd>{age(node.ageSeconds)}</dd></div>
      <div><dt>Dashboard</dt><dd>{node.publicUrl ? <a href={node.publicUrl} target="_blank" rel="noreferrer">Open dashboard <span aria-hidden="true">↗</span></a> : <span className="healthUnavailable">Unavailable</span>}</dd></div>
    </dl>
    {!node.dashboardAvailable && <p className="healthNodeNote">Reporting health data; its public dashboard is currently unavailable.</p>}
  </article>;
}

export default function StatusLakePanel() {
  const [data, setData] = useState<StatusData | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch('/api/status-lake', { cache: 'no-store' });
      if (!response.ok) throw new Error('Status is unavailable');
      setData(await response.json() as StatusData);
      setError('');
    } catch {
      setError('Live infrastructure status could not be loaded.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const hardware = useMemo(() => data?.items.filter((item) => item.type === 'hardware') || [], [data]);
  const apis = useMemo(() => data?.items.filter((item) => item.type === 'api') || [], [data]);
  const online = data?.items.filter((item) => item.status === 'up').length || 0;
  const issues = data?.items.filter((item) => item.status !== 'up').length || 0;
  const overall = !data?.items.length ? 'No data' : issues === 0 ? 'Healthy' : 'Attention';

  return <section className="statusNativePanel" aria-labelledby="status-lake-title" aria-live="polite">
    <header className="statusNativeHeader">
      <div><span className="sectionLabel">Live infrastructure</span><h2 id="status-lake-title">System status</h2><p>{data ? `${data.nodeName} · ${data.sourceNode} live feed` : 'Loading live health checks…'}</p></div>
      <div className="statusNativeActions"><button type="button" className="secondaryButton" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>{data?.publicUrl && <a className="textLink" href={data.publicUrl} target="_blank" rel="noreferrer">Open source <span aria-hidden="true">↗</span></a>}</div>
    </header>
    {error && <div className="errorBanner statusError" role="alert">{error}</div>}
    <div className="healthSummary" aria-label="Infrastructure summary">
      <div><span>Overall</span><strong className={issues ? 'attention' : 'healthy'}>{overall}</strong></div>
      <div><span>Online</span><strong>{online}</strong></div>
      <div><span>Issues</span><strong>{issues}</strong></div>
      <div><span>Seen nodes</span><strong>{data?.nodes.length || 0}</strong></div>
    </div>
    <div className="healthSection"><div className="healthSectionHeading"><div><span className="sectionLabel">Cluster</span><h3>Health-reporting nodes</h3></div><p>A node can keep reporting health even when its own public dashboard is unavailable.</p></div><div className="healthGrid">{data?.nodes.map((node) => <NodeCard node={node} key={node.id} />)}{data && data.nodes.length === 0 && <p className="healthEmpty">No peer nodes seen yet.</p>}</div></div>
    <div className="healthSection"><div className="healthSectionHeading"><div><span className="sectionLabel">Hardware</span><h3>Servers</h3></div><p>Checked by whichever node can reach the relevant network.</p></div><div className="healthGrid">{hardware.map((item) => <TargetCard item={item} key={item.id} />)}{data && hardware.length === 0 && <p className="healthEmpty">No hardware checks reported.</p>}</div></div>
    <div className="healthSection"><div className="healthSectionHeading"><div><span className="sectionLabel">Software</span><h3>APIs</h3></div><p>Live checks from the available status nodes.</p></div><div className="healthGrid">{apis.map((item) => <TargetCard item={item} key={item.id} />)}{data && apis.length === 0 && <p className="healthEmpty">No API checks reported.</p>}</div></div>
  </section>;
}
