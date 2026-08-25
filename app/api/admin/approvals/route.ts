import { NextResponse } from 'next/server';
import { apiErrorResponse, requirePlatformAdminApiSession } from '@/lib/api';
import { listPendingApprovals } from '@/lib/projects';
export async function GET(){try{return NextResponse.json({ok:true,approvals:await listPendingApprovals(await requirePlatformAdminApiSession())},{headers:{'cache-control':'no-store, private'}});}catch(error){return apiErrorResponse(error);}}
