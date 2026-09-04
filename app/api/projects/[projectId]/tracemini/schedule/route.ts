import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { getTraceMiniSchedule, saveTraceMiniSchedule } from '@/lib/tracemini';
type Context = { params: Promise<{ projectId: string }> };
const privateHeaders = { 'cache-control': 'no-store, private' };
export async function GET(_request: NextRequest, context: Context) { try { const { projectId } = await context.params; return NextResponse.json({ ok: true, schedule: await getTraceMiniSchedule(await requireApiSession(), projectId) }, { headers: privateHeaders }); } catch (error) { return apiErrorResponse(error); } }
export async function PUT(request: NextRequest, context: Context) { try { assertSameOrigin(request); const { projectId } = await context.params; return NextResponse.json({ ok: true, schedule: await saveTraceMiniSchedule(await requireApiSession(), projectId, await jsonBody(request)) }, { headers: privateHeaders }); } catch (error) { return apiErrorResponse(error); } }
