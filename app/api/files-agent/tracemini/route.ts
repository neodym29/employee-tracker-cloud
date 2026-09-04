import { NextRequest, NextResponse } from 'next/server';
import { bearerSecret, filesAgentHttpError, FilesAgentError } from '@/lib/files-agent';
import { ingestEmbeddedEvents } from '@/lib/embedded-tracemini-ingest';

export const dynamic='force-dynamic';
const MAX_BODY=128*1024;
export async function readBoundedJson(request:NextRequest):Promise<{raw:Buffer;body:Record<string,unknown>}> {
  if (request.headers.get('content-type') !== 'application/json') throw new FilesAgentError('application/json required',415);
  for (const name of ['authorization','x-tracemini-binding','x-tracemini-signature','x-tracemini-timestamp','x-tracemini-nonce']) if ((request.headers.get(name) || '').length > 512) throw new FilesAgentError('authentication header too large',400);
  const declared=Number(request.headers.get('content-length')||0); if(declared>MAX_BODY) throw new FilesAgentError('request body too large',413);
  const reader=request.body?.getReader(); const chunks:Uint8Array[]=[]; let size=0;
  if(reader){while(true){const {done,value}=await reader.read();if(done)break;if(value){size+=value.byteLength;if(size>MAX_BODY){await reader.cancel();throw new FilesAgentError('request body too large',413);}chunks.push(value);}}}
  const raw=Buffer.concat(chunks.map((chunk)=>Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength))); let parsed:unknown; try{parsed=JSON.parse(raw.toString('utf8'));}catch{throw new FilesAgentError('valid JSON object required',400);}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)) throw new FilesAgentError('JSON object required',400); return {raw,body:parsed as Record<string,unknown>};
}
export async function POST(request:NextRequest){
  try{const credential=bearerSecret(request);if(!credential)throw new FilesAgentError('Bearer device credential required',401);const bindingId=request.headers.get('x-tracemini-binding')||'';const signature=request.headers.get('x-tracemini-signature')||'';if(!bindingId||!signature)throw new FilesAgentError('TraceMini binding proof required',401);const {raw,body}=await readBoundedJson(request);return NextResponse.json({ok:true,...await ingestEmbeddedEvents(credential,raw,body,{bindingId,signature,timestamp:request.headers.get('x-tracemini-timestamp')||'',nonce:request.headers.get('x-tracemini-nonce')||'',path:new URL(request.url).pathname})},{headers:{'cache-control':'no-store, private'}});}catch(error){const failure=filesAgentHttpError(error);return NextResponse.json({ok:false,error:failure.message},{status:failure.status,headers:{'cache-control':'no-store, private'}});}
}
