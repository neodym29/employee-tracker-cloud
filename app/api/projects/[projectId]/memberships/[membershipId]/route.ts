import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { respondToMembership } from '@/lib/projects';
type Context={params:Promise<{projectId:string;membershipId:string}>};
export async function POST(req:NextRequest,context:Context){try{assertSameOrigin(req);const {projectId,membershipId}=await context.params;const body=await jsonBody(req);return NextResponse.json({ok:true,membership:await respondToMembership(await requireApiSession(),projectId,membershipId,body.action)});}catch(error){return apiErrorResponse(error);}}
