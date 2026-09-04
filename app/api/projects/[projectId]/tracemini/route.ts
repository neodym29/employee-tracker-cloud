import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { getTraceMiniConfig, removeTraceMiniConfig, saveTraceMiniConfig, setTraceMiniEnabled, testTraceMiniConnection } from '@/lib/tracemini';

type Context = { params: Promise<{ projectId: string }> };
const privateHeaders = { 'cache-control': 'no-store, private' };

export async function GET(_request: NextRequest, context: Context) {
  try { const { projectId } = await context.params; return NextResponse.json({ ok: true, config: await getTraceMiniConfig(await requireApiSession(), projectId) }, { headers: privateHeaders }); }
  catch (error) { return apiErrorResponse(error); }
}

export async function PUT(request: NextRequest, context: Context) {
  try {
    assertSameOrigin(request);
    const { projectId } = await context.params;
    return NextResponse.json({ ok: true, config: await saveTraceMiniConfig(await requireApiSession(), projectId, await jsonBody(request)) }, { headers: privateHeaders });
  } catch (error) { return apiErrorResponse(error); }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    assertSameOrigin(request);
    const { projectId } = await context.params;
    const session = await requireApiSession();
    const body = await jsonBody(request);
    if (body.action === 'test') return NextResponse.json({ ok: true, test: await testTraceMiniConnection(session, projectId) }, { headers: privateHeaders });
    if (body.action === 'enable' || body.action === 'disable') return NextResponse.json({ ok: true, config: await setTraceMiniEnabled(session, projectId, body.action === 'enable') }, { headers: privateHeaders });
    return NextResponse.json({ ok: false, error: 'Invalid TraceMini action', code: 'invalid_request' }, { status: 400, headers: privateHeaders });
  } catch (error) { return apiErrorResponse(error); }
}

export async function DELETE(request: NextRequest, context: Context) {
  try { assertSameOrigin(request); const { projectId } = await context.params; return NextResponse.json({ ok: true, result: await removeTraceMiniConfig(await requireApiSession(), projectId) }, { headers: privateHeaders }); }
  catch (error) { return apiErrorResponse(error); }
}
