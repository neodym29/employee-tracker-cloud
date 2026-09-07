// QA-only preload. Deliberately excludes credentials, paths, digests and payload metadata.
const fs=require('node:fs');const original=globalThis.fetch;
globalThis.fetch=async function(url,init){const response=await original(url,init);const body=await response.clone().json().catch(()=>({}));let request={};try{request=JSON.parse(init?.body||'{}')}catch{}
const safe=w=>Object.fromEntries(['kind','work_id','revision','desired_tracking','project_id','tracked','completed','error'].filter(k=>w[k]!==undefined).map(k=>[k,w[k]]));
fs.appendFileSync(process.env.QA_FETCH_LOG,JSON.stringify({path:new URL(url).pathname,status:response.status,request:safe(request),response:{...safe(body),work:body.work?.map(w=>({...safe(w),hasClaim:!!w.claim_token})),workspaceIds:body.workspaceIds}})+'\n');return response;};
