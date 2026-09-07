import {NextRequest,NextResponse} from 'next/server';
import {ApiError,requireApiSession,assertSameOrigin} from '@/lib/api';
import {boundedAgentJson,FilesAgentError} from '@/lib/files-agent';
import {ProjectServiceError} from '@/lib/projects';
import {NodeInstallError} from '@/lib/tracemini-install';
import {nodeBrowserDiscovery,nodeBrowserMutation} from '@/lib/tracemini-node-git';
const headers={'cache-control':'no-store, private'};
function failure(e:unknown){const known=e instanceof ApiError||e instanceof ProjectServiceError||e instanceof NodeInstallError||e instanceof FilesAgentError;return NextResponse.json({ok:false,error:'Node discovery request failed. Refresh and retry.',code:known&&'code' in e?e.code:'discovery_failed'},{status:known?e.status:500,headers});}
export async function GET(){try{return NextResponse.json(await nodeBrowserDiscovery(await requireApiSession()),{headers});}catch(e){return failure(e);}}
export async function POST(req:NextRequest){try{const session=await requireApiSession();assertSameOrigin(req);return NextResponse.json(await nodeBrowserMutation(session,await boundedAgentJson(req)),{headers});}catch(e){return failure(e);}}
