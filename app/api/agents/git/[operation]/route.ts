import {NextRequest,NextResponse} from 'next/server';
import {bearerSecret,boundedAgentJson} from '../../../../../lib/files-agent';
import {nodeGitRequest} from '../../../../../lib/tracemini-node-git';
import {NodeInstallError} from '../../../../../lib/tracemini-install';
import {ProjectServiceError} from '../../../../../lib/projects';
export const runtime='nodejs';
export const maxDuration=300;
export async function POST(req:NextRequest,context:{params:Promise<{operation:string}>}){
  const headers={'cache-control':'no-store, private'};
  try {const {operation}=await context.params;return NextResponse.json(await nodeGitRequest(bearerSecret(req),operation,await boundedAgentJson(req)),{headers});}
  catch(e){
    const status=e instanceof NodeInstallError||e instanceof ProjectServiceError?e.status:500;
    // Never log the request, credential, repository mapping, or response body.
    // A small structured server-side diagnostic is enough to distinguish a
    // schema/runtime failure from an expected authorization/lease rejection.
    console.error('node_git_request_failed',{
      status,
      name:e instanceof Error?e.name:'UnknownError',
      message:e instanceof Error?e.message:'Unknown failure',
      code:typeof e==='object'&&e&&'code' in e?String(e.code):undefined,
      constraint:typeof e==='object'&&e&&'constraint' in e?String(e.constraint):undefined,
    });
    return NextResponse.json({error:'node_git_request_failed'},{status,headers});
  }
}
