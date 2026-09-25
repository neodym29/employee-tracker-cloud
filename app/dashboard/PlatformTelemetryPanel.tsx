'use client';

import { useCallback, useEffect, useState } from 'react';

type DatasetTelemetry = { online: boolean; people: number | null; updatedAt: string | null };
type Telemetry = {
  checkedAt: string;
  summary: { healthySources: number; totalSources: number; directoryProfiles: number; entropyRowsScanned: number | null; reportingDgx: number; totalDgx: number };
  attorneys: DatasetTelemetry & { sourceRecords: number | null; processedFiles: number | null; lastAutomaticRun: string | null };
  examiners: DatasetTelemetry;
  entropy: { online: boolean; updatedAt: string | null; stage: string; sourceRowsScanned: number | null; sourceRowsTotal: number | null; scanPercent: number | null; uniqueApplications: number | null; insertedApplications: number | null; embeddings: number | null; malformedRecords: number | null; model: string | null };
  compute: {
    online: boolean;
    checkedAt: string | null;
    dataLake: { cpuPercent: number | null; cpuLoadPercent: number | null; ramPercent: number | null; memoryTotalBytes: number | null; memoryAvailableBytes: number | null; zfsArcPercent: number | null; zfsArcUtilizationPercent: number | null; zfsArcBytes: number | null; storagePercent: number | null; storageTotalBytes: number | null; storageAllocatedBytes: number | null; storageFreeBytes: number | null; zfsPoolCount: number | null; zfsPoolHealth: string; sampledAt: string | null };
    dgx: { resources: Array<{ id: string; label: string; status: string; fresh: boolean; reachable: boolean; reachabilityAgeSeconds: number | null; loadPercent: number | null; cpuPercent: number | null; ramPercent: number | null; gpuPercent: number | null; gpuMemoryPercent: number | null; sampledAt: string | null; ageSeconds: number | null }>; onlineResources: number; activeSessions: number; queuedSessions: number };
  };
};

const integer = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function count(value: number | null, short = false) {
  return value == null ? '—' : (short ? compact : integer).format(value);
}

function time(value: string | null) {
  if (!value) return 'Not available';
  const parsed = new Date(value.includes(' UTC') ? value.replace(' UTC', 'Z') : value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function freshness(seconds: number | null) {
  if (seconds == null) return 'No sample';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`;
  const days = Math.round(seconds / 86_400);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function percent(value: number | null) {
  return value == null ? '—' : `${Math.round(value)}%`;
}

function bytes(value: number | null) {
  if (value == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount >= 100 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

function Metric({ label, value, tone = 'violet' }: { label: string; value: number | null; tone?: 'violet' | 'green' | 'amber' | 'blue' }) {
  const bounded = value == null ? 0 : Math.max(0, Math.min(100, value));
  return <div className="telemetryMetric">
    <div><span>{label}</span><strong>{percent(value)}</strong></div>
    <span className={`telemetryTrack ${tone}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value == null ? undefined : Math.round(bounded)} aria-valuetext={percent(value)}><i style={{ width: `${bounded}%` }} /></span>
  </div>;
}

function SourceState({ online, label, offlineLabel = 'Unavailable' }: { online: boolean; label: string; offlineLabel?: string }) {
  return <span className={`telemetryState ${online ? 'online' : 'offline'}`}><i aria-hidden="true" />{online ? label : offlineLabel}</span>;
}

export default function PlatformTelemetryPanel() {
  const [data, setData] = useState<Telemetry | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch('/api/platform-telemetry', { cache: 'no-store' });
      if (!response.ok) throw new Error('Telemetry unavailable');
      setData(await response.json() as Telemetry);
      setError('');
    } catch {
      setError('Platform telemetry could not be loaded. Existing dashboard data is unchanged.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return <section className="telemetryPanel" aria-labelledby="telemetry-title" aria-live="polite">
    <header className="telemetryHeader">
      <div><span className="sectionLabel">Operations telemetry</span><h2 id="telemetry-title">Platform pulse</h2><p>Live dataset volume, processing throughput, and infrastructure utilization.</p></div>
      <div className="telemetryHeaderActions"><span>Updated {data ? time(data.checkedAt) : '—'}</span><button type="button" className="secondaryButton" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh telemetry'}</button></div>
    </header>
    {error && <div className="errorBanner" role="alert">{error}</div>}
    <div className="telemetrySummary" aria-label="Telemetry summary">
      <div><span>Live sources</span><strong>{data ? `${data.summary.healthySources}/${data.summary.totalSources}` : '—'}</strong></div>
      <div><span>Directory profiles</span><strong>{data ? count(data.summary.directoryProfiles, true) : '—'}</strong></div>
      <div><span>Patent rows scanned</span><strong>{data ? count(data.summary.entropyRowsScanned, true) : '—'}</strong></div>
      <div><span>DGX metrics live</span><strong>{data ? `${data.summary.reportingDgx}/${data.summary.totalDgx}` : '—'}</strong></div>
    </div>

    <div className="telemetrySectionHeading"><div><span className="sectionLabel">Data products</span><h3>Directory and pipeline activity</h3></div><p>Counts come directly from each service’s current dataset or checkpoint.</p></div>
    <div className="telemetryProductGrid">
      <article className="telemetryCard">
        <header><div><span className="telemetryMark">A</span><h3>Attorney directory</h3></div><SourceState online={data?.attorneys.online === true} label="Live" /></header>
        <strong className="telemetryHeroValue">{count(data?.attorneys.people ?? null)}</strong><span className="telemetryHeroLabel">attorney profiles indexed</span>
        <dl><div><dt>Source records</dt><dd>{count(data?.attorneys.sourceRecords ?? null)}</dd></div><div><dt>Processed files</dt><dd>{count(data?.attorneys.processedFiles ?? null)}</dd></div><div><dt>Last refresh</dt><dd>{time(data?.attorneys.updatedAt ?? null)}</dd></div></dl>
        <a href="https://attorneys.neodym.ai/" target="_blank" rel="noreferrer">Open Attorneys <span aria-hidden="true">↗</span></a>
      </article>
      <article className="telemetryCard">
        <header><div><span className="telemetryMark blue">E</span><h3>Examiner directory</h3></div><SourceState online={data?.examiners.online === true} label="Live" /></header>
        <strong className="telemetryHeroValue">{count(data?.examiners.people ?? null)}</strong><span className="telemetryHeroLabel">examiner profiles indexed</span>
        <dl><div><dt>Current dataset</dt><dd>{count(data?.examiners.people ?? null)} records</dd></div><div><dt>Last refresh</dt><dd>{time(data?.examiners.updatedAt ?? null)}</dd></div></dl>
        <a href="https://examiners.neodym.ai/" target="_blank" rel="noreferrer">Open Examiners <span aria-hidden="true">↗</span></a>
      </article>
      <article className="telemetryCard entropyTelemetryCard">
        <header><div><span className="telemetryMark amber">PE</span><h3>Patent Entropy pipeline</h3></div><SourceState online={data?.entropy.online === true} label={data?.entropy.stage || 'Running'} /></header>
        <div className="pipelineHeadline"><strong>{percent(data?.entropy.scanPercent ?? null)}</strong><span>of the source manifest scanned</span></div>
        <Metric label="Corpus scan" value={data?.entropy.scanPercent ?? null} tone="amber" />
        <dl><div><dt>Rows scanned</dt><dd>{count(data?.entropy.sourceRowsScanned ?? null)}</dd></div><div><dt>Unique applications</dt><dd>{count(data?.entropy.uniqueApplications ?? null)}</dd></div><div><dt>Abstract embeddings</dt><dd>{count(data?.entropy.embeddings ?? null)}</dd></div><div><dt>Malformed</dt><dd>{count(data?.entropy.malformedRecords ?? null)}</dd></div></dl>
        <a href="https://entropy-review.vercel.app/pipeline.html" target="_blank" rel="noreferrer">Open pipeline <span aria-hidden="true">↗</span></a>
      </article>
    </div>

    <div className="telemetrySectionHeading computeTelemetryHeading"><div><span className="sectionLabel">Compute estate</span><h3>Data Lake and DGX utilization</h3></div><p>Current safe aggregate metrics; no user, prompt, key, or session details leave Compute.</p></div>
    <div className="computeTelemetryGrid">
      <article className="telemetryCard infrastructureCard">
        <header><div><span className="telemetryMark green">DL</span><h3>Data Lake</h3></div><SourceState online={data?.compute.online === true && data?.compute.dataLake.zfsPoolHealth !== 'unavailable'} label={data?.compute.dataLake.zfsPoolHealth === 'online' ? 'ZFS healthy' : 'ZFS degraded'} /></header>
        <div className="metricStack"><Metric label="CPU" value={data?.compute.dataLake.cpuPercent ?? data?.compute.dataLake.cpuLoadPercent ?? null} tone="green" /><Metric label="System memory" value={data?.compute.dataLake.ramPercent ?? null} tone="green" /><Metric label="ZFS ARC memory" value={data?.compute.dataLake.zfsArcPercent ?? null} tone="blue" /><Metric label="ZFS pool capacity" value={data?.compute.dataLake.storagePercent ?? null} tone="amber" /></div>
        <dl><div><dt>ZFS allocated</dt><dd>{bytes(data?.compute.dataLake.storageAllocatedBytes ?? null)}</dd></div><div><dt>ZFS free</dt><dd>{bytes(data?.compute.dataLake.storageFreeBytes ?? null)}</dd></div><div><dt>ARC cache</dt><dd>{bytes(data?.compute.dataLake.zfsArcBytes ?? null)}</dd></div></dl>
        <p className="telemetryFreshness">Sampled {time(data?.compute.dataLake.sampledAt ?? null)}</p>
      </article>
      {(data?.compute.dgx.resources || []).map((resource) => {
        const current = resource.fresh === true;
        const reachable = resource.reachable === true;
        return <article className="telemetryCard infrastructureCard" key={resource.id}>
          <header><div><span className="telemetryMark">GX</span><h3>{resource.label}</h3></div><SourceState online={reachable} label={current ? resource.status.replaceAll('-', ' ') : 'Online'} offlineLabel="Unreachable" /></header>
          <div className="metricStack"><Metric label="CPU" value={current ? resource.cpuPercent : null} /><Metric label="Memory" value={current ? resource.ramPercent : null} /><Metric label="GPU" value={current ? resource.gpuPercent : null} tone="amber" /><Metric label="GPU memory" value={current ? resource.gpuMemoryPercent : null} tone="blue" /></div>
          <p className="telemetryFreshness">{current ? <>Latest utilization sample {freshness(resource.ageSeconds)}</> : reachable ? <>Hardware is online; utilization metrics need collector reconnection.</> : <>Last successful metrics {freshness(resource.ageSeconds)}</>}</p>
        </article>;
      })}
      {data && data.compute.dgx.resources.length === 0 && <article className="telemetryCard infrastructureCard unavailableTelemetry"><h3>DGX telemetry unavailable</h3><p>Compute is not currently returning a safe aggregate telemetry feed.</p></article>}
    </div>
    <footer className="telemetryFooter"><span><strong>{data?.compute.dgx.activeSessions ?? 0}</strong> active sessions</span><span><strong>{data?.compute.dgx.queuedSessions ?? 0}</strong> queued</span><a href="https://compute.neodym.ai/history.html" target="_blank" rel="noreferrer">Open Compute history <span aria-hidden="true">↗</span></a></footer>
  </section>;
}
