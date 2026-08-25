import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { createRecordVersion } from '@/lib/projects';
type Context={params:Promise<{projectId:string;recordId:string}>};
export async function POST(req:NextRequest,context:Context){try{assertSameOrigin(req);const {projectId,recordId}=await context.params;return NextResponse.json({ok:true,record:await createRecordVersion(await requireApiSession(),projectId,recordId,await jsonBody(req))},{status:201});}catch(error){return apiErrorResponse(error);}}
