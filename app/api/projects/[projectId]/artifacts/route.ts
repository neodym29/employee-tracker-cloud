import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { createArtifact, listArtifacts } from '@/lib/projects';
type Context={params:Promise<{projectId:string}>};
export async function GET(_req:NextRequest,context:Context){try{const {projectId}=await context.params;return NextResponse.json({ok:true,artifacts:await listArtifacts(await requireApiSession(),projectId)},{headers:{'cache-control':'no-store, private'}});}catch(error){return apiErrorResponse(error);}}
export async function POST(req:NextRequest,context:Context){try{assertSameOrigin(req);const {projectId}=await context.params;return NextResponse.json({ok:true,artifact:await createArtifact(await requireApiSession(),projectId,await jsonBody(req))},{status:201});}catch(error){return apiErrorResponse(error);}}
