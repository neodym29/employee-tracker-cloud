import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { attachProjectGitRemote, deleteProject, getProject, ProjectServiceError, renameProject, updateProject, updateProjectDeploymentUrl } from '@/lib/projects';

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
    const rename = Object.keys(body).length === 1 && Object.hasOwn(body, 'title');
    const deployment = Object.keys(body).length === 1 && Object.hasOwn(body, 'deploymentUrl');
    if (attach && Object.keys(body).some((key) => key !== 'gitRemote')) {
      throw new ProjectServiceError('Git remote attach cannot be combined with project edits');
    }
    const project = attach
      ? await attachProjectGitRemote(session, projectId, body.gitRemote)
      : deployment
        ? await updateProjectDeploymentUrl(session, projectId, body.deploymentUrl)
      : rename
        ? await renameProject(session, projectId, body.title)
        : await updateProject(session, projectId, body);
    return NextResponse.json({ ok: true, project });
  } catch (error) { return apiErrorResponse(error); }
}

export async function DELETE(req: NextRequest, context: Context) {
  try {
    assertSameOrigin(req);
    const { projectId } = await context.params;
    return NextResponse.json({ ok: true, result: await deleteProject(await requireApiSession(), projectId) });
  } catch (error) { return apiErrorResponse(error); }
}
