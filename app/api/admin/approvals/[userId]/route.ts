import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requirePlatformAdminApiSession } from '@/lib/api';
import { reviewAccount } from '@/lib/projects';
type Context={params:Promise<{userId:string}>};
export async function POST(req:NextRequest,context:Context){try{assertSameOrigin(req);const {userId}=await context.params;const body=await jsonBody(req);return NextResponse.json({ok:true,account:await reviewAccount(await requirePlatformAdminApiSession(),userId,body.action)});}catch(error){return apiErrorResponse(error);}}
