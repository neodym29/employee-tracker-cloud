import { NextRequest, NextResponse } from 'next/server';
import { bearerSecret, boundedAgentJson, filesAgentHttpError, FilesAgentError } from '@/lib/files-agent';
import { createPendingPush } from '@/lib/tracemini-discovery';

export async function POST(req: NextRequest) {
  try {
    const credential = bearerSecret(req);
    if (!credential) throw new FilesAgentError('Bearer device credential required', 401);
    const body = await boundedAgentJson(req);
    return NextResponse.json({ ok: true, ...(await createPendingPush(credential, body)) }, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const failure = filesAgentHttpError(error);
    return NextResponse.json({ ok: false, error: failure.message }, { status: failure.status, headers: { 'cache-control': 'no-store' } });
  }
}
