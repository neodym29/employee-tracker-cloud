import { NextRequest,NextResponse } from 'next/server';
import { apiErrorResponse,assertSameOrigin,jsonBody,requireApiSession } from '@/lib/api';
import { issueEmbeddedBindingCode } from '@/lib/embedded-tracemini-ingest';
import { revokeTraceMiniRoot } from '@/lib/tracemini';
type Context={params:Promise<{projectId:string}>};
export async function POST(request:NextRequest,context:Context){try{assertSameOrigin(request);const {projectId}=await context.params;return NextResponse.json({ok:true,binding:await issueEmbeddedBindingCode(await requireApiSession(),projectId,await jsonBody(request))},{headers:{'cache-control':'no-store, private'}});}catch(error){return apiErrorResponse(error);}}
export async function DELETE(request:NextRequest,context:Context){try{assertSameOrigin(request);const {projectId}=await context.params;const body=await jsonBody(request);return NextResponse.json({ok:true,result:await revokeTraceMiniRoot(await requireApiSession(),projectId,body.bindingId)},{headers:{'cache-control':'no-store, private'}});}catch(error){return apiErrorResponse(error);}}
