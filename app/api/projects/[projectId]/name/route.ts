import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, requireApiSession } from '@/lib/api';
import { nameProjectFromEvidence } from '@/lib/project-naming';

type Context = { params: Promise<{ projectId: string }> };

export async function POST(req: NextRequest, context: Context) {
  try {
    assertSameOrigin(req);
    const { projectId } = await context.params;
    const result = await nameProjectFromEvidence(await requireApiSession(), projectId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
