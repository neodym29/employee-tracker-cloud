import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, requireApiSession } from '@/lib/api';
import { listProjectFiles } from '@/lib/project-files';

type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: NextRequest, context: Context) {
  try {
    const { projectId } = await context.params;
    return NextResponse.json(
      { ok: true, files: await listProjectFiles(await requireApiSession(), projectId) },
      { headers: { 'cache-control': 'no-store, private', pragma: 'no-cache' } },
    );
  } catch (error) { return apiErrorResponse(error); }
}
