import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { inviteEngineer } from '@/lib/projects';
type Context={params:Promise<{projectId:string}>};
export async function POST(req:NextRequest,context:Context){try{assertSameOrigin(req);const {projectId}=await context.params;const body=await jsonBody(req);return NextResponse.json({ok:true,membership:await inviteEngineer(await requireApiSession('client'),projectId,body.engineerId)},{status:201});}catch(error){return apiErrorResponse(error);}}
