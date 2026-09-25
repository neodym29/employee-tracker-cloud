import type { NextRequest } from 'next/server';
import { FilesAgentError } from './files-agent';
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
