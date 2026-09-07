/** Auth-only allowlist around the original CLI api signature. Never log response bodies,
 * request arguments or network errors. All Git/document/report transport remains closed. */
export async function api<T = unknown>(config: unknown, url: string, init: RequestInit = {}, agent = true): Promise<T> {
  const c=config as {serverUrl?:string;agentToken?:string};
  const method=init.method || 'GET';
  const exchange=url==='/api/agents/install/exchange' && method==='POST';
  const abort=url==='/api/agents/install/abort' && method==='POST';
  const status=url==='/api/agents/status' && method==='GET';
  if(!agent || (!exchange && !abort && !status))throw new Error('Cloud Trace integration not enabled; repository synchronization pending');
  try {
    const origin=new URL(c.serverUrl || '');
    if(origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash || (origin.protocol!=='https:' && !(origin.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(origin.hostname))))throw new Error();
    if(!exchange && !/^etn_[A-Za-z0-9_-]{43}$/.test(c.agentToken || ''))throw new Error();
    let body:string|undefined;
    if(exchange){
      if(typeof init.body!=='string')throw new Error();const input=JSON.parse(init.body);
      if(Object.keys(input).some(k=>!['installToken','machineName','installationId'].includes(k)))throw new Error();
      body=JSON.stringify({installToken:input.installToken,machineName:input.machineName,installationId:input.installationId});
    }else if(abort){body='{}';}
    const credential=/^etn_[A-Za-z0-9_-]{43}$/.test(c.agentToken || '')?c.agentToken:undefined;
    const r=await fetch(origin.origin+url,{method,body,headers:{'content-type':'application/json',...(credential?{authorization:`Bearer ${credential}`}:{})},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw new Error();
    const text=await r.text();if(text.length>16384)throw new Error();
    const result=JSON.parse(text);
    if(exchange && (!Number.isSafeInteger(result.agentId)||result.agentId<1||!Number.isSafeInteger(result.workspaceId)||result.workspaceId<1||!/^etn_[A-Za-z0-9_-]{43}$/.test(result.agentToken)))throw new Error();
    if(result.syncEnabled!==false || !['pending_sync','revoked'].includes(result.state) || result.capability!=='node-git-v1')throw new Error();
    return result as T;
  } catch {throw new Error('Cloud Trace authentication request failed; regenerate an expired command or check device approval.');}
}
