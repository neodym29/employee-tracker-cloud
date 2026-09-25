import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const endpoints = {
  attorneys: 'https://attorneys.neodym.ai/api/health',
  examiners: 'https://examiners.neodym.ai/api/health',
  entropy: 'https://entropy-review.vercel.app/pipeline-status.json',
  compute: 'https://compute.neodym.ai/api/telemetry-summary',
  dgxStatus: 'https://status-dgx.neodym.ai/api/status',
} as const;

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function percent(value: unknown) {
  const parsed = number(value);
  return parsed == null ? null : Math.round(Math.min(100, parsed) * 10) / 10;
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' ? value.slice(0, 160) : fallback;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function fetchJson(url: string) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { accept: 'application/json', 'user-agent': 'Neo-Nexus platform telemetry' },
    signal: AbortSignal.timeout(9_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

async function readAttorneys() {
  try {
    const payload = await fetchJson(endpoints.attorneys);
    return {
      online: payload.ok === true,
      people: number(payload.rows_loaded),
      sourceRecords: number(payload.rem_rows_loaded),
      processedFiles: number(payload.processed_file_count),
      updatedAt: text(payload.last_loaded_at) || null,
      lastAutomaticRun: text(payload.last_auto_run_date) || null,
    };
  } catch {
    return { online: false, people: null, sourceRecords: null, processedFiles: null, updatedAt: null, lastAutomaticRun: null };
  }
}

async function readExaminers() {
  try {
    const payload = await fetchJson(endpoints.examiners);
    return {
      online: payload.ok === true,
      people: number(payload.rows_loaded),
      updatedAt: text(payload.last_loaded_at) || null,
    };
  } catch {
    return { online: false, people: null, updatedAt: null };
  }
}

async function readEntropy() {
  try {
    const payload = await fetchJson(endpoints.entropy);
    const manifest = object(payload.manifest);
    const embedding = object(payload.embedding);
    const seen = number(manifest.seen);
    const sourceTotal = number(manifest.source_total);
    return {
      online: true,
      updatedAt: text(payload.updated_at) || null,
      stage: text(embedding.stage || manifest.stage, 'running').replaceAll('_', ' '),
      sourceRowsScanned: seen,
      sourceRowsTotal: sourceTotal,
      scanPercent: seen != null && sourceTotal ? Math.round(seen / sourceTotal * 1_000) / 10 : null,
      uniqueApplications: number(manifest.unique_patents),
      insertedApplications: number(manifest.inserted),
      embeddings: number(embedding.done),
      malformedRecords: number(manifest.malformed),
      model: text(embedding.model) || null,
    };
  } catch {
    return { online: false, updatedAt: null, stage: 'unavailable', sourceRowsScanned: null, sourceRowsTotal: null, scanPercent: null, uniqueApplications: null, insertedApplications: null, embeddings: null, malformedRecords: null, model: null };
  }
}

async function readCompute() {
  try {
    const payload = await fetchJson(endpoints.compute);
    const dataLake = object(payload.dataLake);
    const dgx = object(payload.dgx);
    const resources = Array.isArray(dgx.resources) ? dgx.resources.flatMap((candidate) => {
      const resource = object(candidate);
      const id = text(resource.id);
      if (!id) return [];
      return [{
        id,
        label: text(resource.label, 'Compute'),
        status: text(resource.status, 'unknown'),
        fresh: resource.fresh === true || (resource.fresh !== false && text(resource.status, 'unknown') !== 'unknown' && text(resource.status, 'unknown') !== 'unreachable' && (number(resource.ageSeconds) ?? Number.POSITIVE_INFINITY) <= 120),
        loadPercent: percent(resource.loadPercent),
        cpuPercent: percent(resource.cpuPercent),
        ramPercent: percent(resource.ramPercent),
        gpuPercent: percent(resource.gpuPercent),
        gpuMemoryPercent: percent(resource.gpuMemoryPercent),
        sampledAt: text(resource.sampledAt) || null,
        ageSeconds: number(resource.ageSeconds),
      }];
    }) : [];
    return {
      online: payload.ok === true,
      checkedAt: text(payload.checkedAt) || null,
      dataLake: {
        cpuPercent: percent(dataLake.cpuPercent),
        cpuLoadPercent: percent(dataLake.cpuLoadPercent),
        ramPercent: percent(dataLake.ramPercent),
        memoryTotalBytes: number(dataLake.memoryTotalBytes),
        memoryAvailableBytes: number(dataLake.memoryAvailableBytes),
        zfsArcPercent: percent(dataLake.zfsArcPercent),
        zfsArcUtilizationPercent: percent(dataLake.zfsArcUtilizationPercent),
        zfsArcBytes: number(dataLake.zfsArcBytes),
        storagePercent: percent(dataLake.storagePercent),
        storageTotalBytes: number(dataLake.storageTotalBytes),
        storageAllocatedBytes: number(dataLake.storageAllocatedBytes),
        storageFreeBytes: number(dataLake.storageFreeBytes),
        zfsPoolCount: number(dataLake.zfsPoolCount),
        zfsPoolHealth: text(dataLake.zfsPoolHealth, 'unavailable'),
        sampledAt: text(dataLake.sampledAt) || null,
      },
      dgx: {
        resources,
        onlineResources: number(dgx.onlineResources) || 0,
        activeSessions: number(dgx.activeSessions) || 0,
        queuedSessions: number(dgx.queuedSessions) || 0,
      },
    };
  } catch {
    return { online: false, checkedAt: null, dataLake: { cpuPercent: null, cpuLoadPercent: null, ramPercent: null, memoryTotalBytes: null, memoryAvailableBytes: null, zfsArcPercent: null, zfsArcUtilizationPercent: null, zfsArcBytes: null, storagePercent: null, storageTotalBytes: null, storageAllocatedBytes: null, storageFreeBytes: null, zfsPoolCount: null, zfsPoolHealth: 'unavailable', sampledAt: null }, dgx: { resources: [], onlineResources: 0, activeSessions: 0, queuedSessions: 0 } };
  }
}

async function readDgxReachability() {
  try {
    const payload = await fetchJson(endpoints.dgxStatus);
    const items = Array.isArray(payload.items) ? payload.items : [];
    return new Map<string, { reachable: boolean; reachabilityAgeSeconds: number | null }>(items.flatMap((candidate) => {
      const item = object(candidate);
      const id = text(item.id);
      const label = id === 'dgx-spark-15cf' ? 'DGX Spark 15cf' : id === 'dgx-spark-4c33' ? 'DGX Spark 4c33' : '';
      if (!label) return [];
      const ageSeconds = number(item.age_seconds);
      return [[label, {
        reachable: text(item.status) === 'up' && ageSeconds != null && ageSeconds <= 120,
        reachabilityAgeSeconds: ageSeconds,
      }] as const];
    }));
  } catch {
    return new Map<string, { reachable: boolean; reachabilityAgeSeconds: number | null }>();
  }
}

export async function GET() {
  const [attorneys, examiners, entropy, computeSnapshot, dgxReachability] = await Promise.all([readAttorneys(), readExaminers(), readEntropy(), readCompute(), readDgxReachability()]);
  const compute = {
    ...computeSnapshot,
    dgx: {
      ...computeSnapshot.dgx,
      resources: computeSnapshot.dgx.resources.map((resource) => ({
        ...resource,
        status: (dgxReachability.get(resource.label)?.reachable ?? resource.fresh) && !resource.fresh ? 'online-no-metrics' : resource.status,
        reachable: dgxReachability.get(resource.label)?.reachable ?? resource.fresh,
        reachabilityAgeSeconds: dgxReachability.get(resource.label)?.reachabilityAgeSeconds ?? null,
      })),
    },
  };
  const sources = [attorneys, examiners, entropy, compute];
  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    summary: {
      healthySources: sources.filter((source) => source.online).length,
      totalSources: sources.length,
      directoryProfiles: (attorneys.people || 0) + (examiners.people || 0),
      entropyRowsScanned: entropy.sourceRowsScanned,
      reportingDgx: compute.dgx.onlineResources,
      totalDgx: compute.dgx.resources.length,
    },
    attorneys,
    examiners,
    entropy,
    compute,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
