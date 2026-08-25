import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { getProject, updateProject } from '@/lib/projects';
type Context={params:Promise<{projectId:string}>};
export async function GET(_req:NextRequest,context:Context){try{const {projectId}=await context.params;return NextResponse.json({ok:true,project:await getProject(await requireApiSession(),projectId)},{headers:{'cache-control':'no-store, private'}});}catch(error){return apiErrorResponse(error);}}
export async function PATCH(req:NextRequest,context:Context){try{assertSameOrigin(req);const {projectId}=await context.params;return NextResponse.json({ok:true,project:await updateProject(await requireApiSession('client'),projectId,await jsonBody(req))});}catch(error){return apiErrorResponse(error);}}
