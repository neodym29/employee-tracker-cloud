import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import {
  createProject,
  listAvailableClients,
  listAvailableEngineers,
  listProjectMemberships,
  listProjects,
} from '@/lib/projects';
import { listClientEngineerUpdates } from '@/lib/engineer-updates';

export async function GET() {
  try {
    const session = await requireApiSession();
    const projects = await listProjects(session);
    let detailsError = false;

    if (session.account_type === 'client') {
      let engineers = [];
      let engineerUpdates: Awaited<ReturnType<typeof listClientEngineerUpdates>> = [];
      const projectMemberships: Record<string, unknown[]> = {};
      try { engineers = await listAvailableEngineers(session); }
      catch { detailsError = true; }
      try { engineerUpdates = await listClientEngineerUpdates(session); }
      catch { detailsError = true; }
      for (const project of projects) {
        if (!project.can_delete) continue;
        try { projectMemberships[String(project.id)] = await listProjectMemberships(session, project.id); }
        catch { detailsError = true; }
      }
      return NextResponse.json(
        { ok: true, projects, engineers, engineerUpdates, projectMemberships, detailsError },
        { headers: { 'cache-control': 'no-store, private' } },
      );
    }

    let clients = [];
    try { clients = await listAvailableClients(session); }
    catch { detailsError = true; }
    return NextResponse.json(
      { ok: true, projects, clients, detailsError },
      { headers: { 'cache-control': 'no-store, private' } },
    );
  }
  catch (error) { return apiErrorResponse(error); }
}
export async function POST(req: NextRequest) {
  try { assertSameOrigin(req); const session=await requireApiSession(); return NextResponse.json({ ok:true, project:await createProject(session,await jsonBody(req)) },{status:201}); }
  catch (error) { return apiErrorResponse(error); }
}
