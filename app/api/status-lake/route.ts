import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const sources = [
  'https://status-lake.neodym.ai',
  'https://status-dgx.neodym.ai',
];
const statuses = new Set(['up', 'down', 'degraded', 'stale', 'unknown']);
const hiddenChecks = new Set(['status-pc', 'denver-data-lake']);
const dashboardChecks: Record<string, { checkId: string; url: string }> = {
  'data-lake': { checkId: 'status-lake', url: 'https://status-lake.neodym.ai' },
  dgx: { checkId: 'status-dgx', url: 'https://status-dgx.neodym.ai' },
  pc: { checkId: 'status-pc', url: 'https://status-pc.neodym.ai' },
};
const dashboardUrls: Record<string, string> = {
  'status-lake': 'https://status-lake.neodym.ai',
  'status-dgx': 'https://status-dgx.neodym.ai',
};

function text(value: unknown, fallback = '') {
  return typeof value === 'string' ? value.slice(0, 160) : fallback;
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function status(value: unknown) {
  const parsed = text(value, 'unknown');
  return statuses.has(parsed) ? parsed : 'unknown';
}

export async function GET() {
  try {
    let activeSource = '';
    let payload: Record<string, unknown> | null = null;
    for (const candidate of sources) {
      try {
        const response = await fetch(`${candidate}/api/status`, { cache: 'no-store', signal: AbortSignal.timeout(6_000) });
        if (!response.ok) continue;
        payload = await response.json() as Record<string, unknown>;
        activeSource = candidate;
        break;
      } catch {
        // Try the next independent status node.
      }
    }
    if (!payload || !activeSource) throw new Error('all status mirrors unavailable');

    const sourceItems = Array.isArray(payload.items) ? payload.items : [];
    const sourceNodes = Array.isArray(payload.nodes) ? payload.nodes : [];

    const items = sourceItems.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return [];
      const item = candidate as Record<string, unknown>;
      const type = text(item.type);
      if (type !== 'hardware' && type !== 'api') return [];
      if (hiddenChecks.has(text(item.id))) return [];
      const itemStatus = status(item.status);
      return [{
        id: text(item.id, 'unknown'),
        name: text(item.name, 'Unnamed check'),
        type,
        status: itemStatus,
        latencyMs: number(item.latency_ms),
        ageSeconds: number(item.age_seconds),
        error: item.error == null ? null : text(item.error),
        sourceName: text(item.source_node_name || item.source_node_id, 'Unknown node'),
        publicUrl: itemStatus === 'up' ? dashboardUrls[text(item.id)] || null : null,
      }];
    });
    const nodes = sourceNodes.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return [];
      const node = candidate as Record<string, unknown>;
      const id = text(node.node_id, 'unknown');
      const dashboard = dashboardChecks[id];
      const dashboardCheck = dashboard && sourceItems.find((candidateItem) => candidateItem && typeof candidateItem === 'object' && text((candidateItem as Record<string, unknown>).id) === dashboard.checkId) as Record<string, unknown> | undefined;
      const dashboardAvailable = Boolean(dashboard && dashboardCheck && status(dashboardCheck.status) === 'up');
      return [{
        id,
        name: text(node.node_name, 'Unnamed node'),
        publicUrl: dashboardAvailable ? dashboard.url : null,
        dashboardAvailable,
        ageSeconds: number(node.age_seconds),
        status: status(node.status),
      }];
    });

    return NextResponse.json({
      nodeName: text(payload.node_name, activeSource.includes('dgx') ? 'DGX status node' : 'Data Lake status node'),
      publicUrl: activeSource,
      sourceNode: activeSource.includes('dgx') ? 'DGX mirror' : 'Data Lake',
      generatedAt: number(payload.generated_at),
      items,
      nodes,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Live infrastructure status is unavailable.' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
