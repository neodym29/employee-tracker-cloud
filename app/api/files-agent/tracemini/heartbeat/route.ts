import { NextRequest,NextResponse } from 'next/server';
import { bearerSecret,filesAgentHttpError,FilesAgentError } from '@/lib/files-agent';
import { heartbeatEmbeddedBinding } from '@/lib/embedded-tracemini-ingest';
import { readBoundedJson } from '../route';
export const dynamic='force-dynamic';
export async function POST(request:NextRequest){try{const credential=bearerSecret(request);if(!credential)throw new FilesAgentError('Bearer device credential required',401);const bindingId=request.headers.get('x-tracemini-binding')||'';const signature=request.headers.get('x-tracemini-signature')||'';const {raw}=await readBoundedJson(request);return NextResponse.json(await heartbeatEmbeddedBinding(credential,raw,{bindingId,signature,timestamp:request.headers.get('x-tracemini-timestamp')||'',nonce:request.headers.get('x-tracemini-nonce')||'',path:new URL(request.url).pathname}),{headers:{'cache-control':'no-store, private'}});}catch(error){const failure=filesAgentHttpError(error);return NextResponse.json({ok:false,error:failure.message},{status:failure.status,headers:{'cache-control':'no-store, private'}});}}
