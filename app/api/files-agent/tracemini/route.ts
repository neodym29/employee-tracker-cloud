import { NextRequest, NextResponse } from 'next/server';
import { bearerSecret, filesAgentHttpError, FilesAgentError } from '@/lib/files-agent';
import { ingestEmbeddedEvents } from '@/lib/embedded-tracemini-ingest';

export const dynamic='force-dynamic';
import { readBoundedJson } from '@/lib/tracemini-request-body';
export async function POST(request:NextRequest){
  try{const credential=bearerSecret(request);if(!credential)throw new FilesAgentError('Bearer device credential required',401);const bindingId=request.headers.get('x-tracemini-binding')||'';const signature=request.headers.get('x-tracemini-signature')||'';if(!bindingId||!signature)throw new FilesAgentError('Neo-Nexus binding proof required',401);const {raw,body}=await readBoundedJson(request);return NextResponse.json({ok:true,...await ingestEmbeddedEvents(credential,raw,body,{bindingId,signature,timestamp:request.headers.get('x-tracemini-timestamp')||'',nonce:request.headers.get('x-tracemini-nonce')||'',path:new URL(request.url).pathname})},{headers:{'cache-control':'no-store, private'}});}catch(error){const failure=filesAgentHttpError(error);return NextResponse.json({ok:false,error:failure.message},{status:failure.status,headers:{'cache-control':'no-store, private'}});}
}
