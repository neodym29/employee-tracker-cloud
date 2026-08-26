import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { createProject, listProjects } from '@/lib/projects';

export async function GET() {
  try { return NextResponse.json({ ok: true, projects: await listProjects(await requireApiSession()) }, { headers: { 'cache-control': 'no-store, private' } }); }
  catch (error) { return apiErrorResponse(error); }
}
export async function POST(req: NextRequest) {
  try { assertSameOrigin(req); const session=await requireApiSession(); return NextResponse.json({ ok:true, project:await createProject(session,await jsonBody(req)) },{status:201}); }
  catch (error) { return apiErrorResponse(error); }
}
