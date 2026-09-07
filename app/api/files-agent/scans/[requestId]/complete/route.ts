import { NextRequest, NextResponse } from 'next/server';
import { bearerSecret, boundedAgentJson, filesAgentHttpError, FilesAgentError } from '@/lib/files-agent';
import { completeDeviceWork } from '@/lib/tracemini-discovery';

export async function POST(request: NextRequest, context: { params: Promise<{ requestId: string }> }) {
  try {
    const credential = bearerSecret(request);
    if (!credential) throw new FilesAgentError('Bearer device credential required', 401);
    const { requestId } = await context.params;
    const body = await boundedAgentJson(request);
    if (String(body.work_id) !== requestId) throw new FilesAgentError('URL requestId does not match work_id', 400);
    return NextResponse.json({ ok: true, ...(await completeDeviceWork(credential, { ...body, kind: 'scan' })) }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const failure = filesAgentHttpError(error);
    return NextResponse.json({ ok: false, error: failure.message }, { status: failure.status, headers: { 'cache-control': 'no-store' } });
  }
}
