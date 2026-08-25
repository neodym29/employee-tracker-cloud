import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, requireApiSession } from '@/lib/api';
import { listProjectMemberships, requestMembership } from '@/lib/projects';
type Context={params:Promise<{projectId:string}>};
export async function GET(_req:NextRequest,context:Context){try{const {projectId}=await context.params;return NextResponse.json({ok:true,memberships:await listProjectMemberships(await requireApiSession('client'),projectId)},{headers:{'cache-control':'no-store, private'}});}catch(error){return apiErrorResponse(error);}}
export async function POST(req:NextRequest,context:Context){try{assertSameOrigin(req);const {projectId}=await context.params;return NextResponse.json({ok:true,membership:await requestMembership(await requireApiSession('engineer'),projectId)},{status:201});}catch(error){return apiErrorResponse(error);}}
