import {NextRequest,NextResponse} from 'next/server';
import {bearerSecret,boundedAgentJson} from '../../../../../lib/files-agent';
import {nodeGitRequest} from '../../../../../lib/tracemini-node-git';
import {NodeInstallError} from '../../../../../lib/tracemini-install';
import {ProjectServiceError} from '../../../../../lib/projects';
export const runtime='nodejs';
export async function POST(req:NextRequest,context:{params:Promise<{operation:string}>}){
  const headers={'cache-control':'no-store, private'};
  try {const {operation}=await context.params;return NextResponse.json(await nodeGitRequest(bearerSecret(req),operation,await boundedAgentJson(req)),{headers});}
  catch(e){const status=e instanceof NodeInstallError||e instanceof ProjectServiceError?e.status:500;return NextResponse.json({error:'node_git_request_failed'},{status,headers});}
}
