import { NextRequest } from 'next/server';
import { apiErrorResponse, requireApiSession } from '@/lib/api';
import { getProjectFile, projectFileContentDisposition } from '@/lib/project-files';

type Context = { params: Promise<{ projectId: string; fileId: string }> };

export async function GET(_request: NextRequest, context: Context) {
  try {
    const { projectId, fileId } = await context.params;
    const file = await getProjectFile(await requireApiSession(), projectId, fileId);
    return new Response(file.content, {
      status: 200,
      headers: {
        'content-type': `${file.media_type}; charset=utf-8`,
        'content-length': String(file.byte_size),
        'content-disposition': projectFileContentDisposition(file.path),
        'cache-control': 'no-store, private',
        pragma: 'no-cache',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) { return apiErrorResponse(error); }
}
