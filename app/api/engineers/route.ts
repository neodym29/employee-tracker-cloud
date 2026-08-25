import { NextResponse } from 'next/server';
import { apiErrorResponse, requireApiSession } from '@/lib/api';
import { listAvailableEngineers } from '@/lib/projects';
export async function GET(){try{return NextResponse.json({ok:true,engineers:await listAvailableEngineers(await requireApiSession('client'))},{headers:{'cache-control':'no-store, private'}});}catch(error){return apiErrorResponse(error);}}
