import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { attachProjectGitRemote, getProject, ProjectServiceError, updateProject } from '@/lib/projects';

type Context = { params: Promise<{ projectId: string }> };

export async function GET(_req: NextRequest, context: Context) {
  try {
    const { projectId } = await context.params;
    return NextResponse.json(
      { ok: true, project: await getProject(await requireApiSession(), projectId) },
      { headers: { 'cache-control': 'no-store, private' } },
    );
  } catch (error) { return apiErrorResponse(error); }
}

export async function PATCH(req: NextRequest, context: Context) {
  try {
    assertSameOrigin(req);
    const { projectId } = await context.params;
    const session = await requireApiSession();
    const body = await jsonBody(req);
    const attach = Object.hasOwn(body, 'gitRemote');
    if (attach && Object.keys(body).some((key) => key !== 'gitRemote')) {
      throw new ProjectServiceError('Git remote attach cannot be combined with project edits');
    }
    const project = attach
      ? await attachProjectGitRemote(session, projectId, body.gitRemote)
      : await updateProject(session, projectId, body);
    return NextResponse.json({ ok: true, project });
  } catch (error) { return apiErrorResponse(error); }
}
