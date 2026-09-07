import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {build} from 'esbuild';
const read=p=>fs.existsSync(p)?fs.readFileSync(p,'utf8'):'';
test('Node browser routes authenticate and protect mutations, call real adapters',()=>{
 const s=read('app/api/agents/discovery/route.ts');
 for(const marker of ['requireApiSession','assertSameOrigin','boundedAgentJson','nodeBrowserDiscovery','nodeBrowserMutation','no-store'])assert.ok(s.includes(marker),marker);
});
test('Start project uses original Node repository selection and CAS, never Python discovery',()=>{
 const s=read('app/components/trace-node/RepositorySelection.tsx');
 for(const marker of ['repositorySelectionState(candidate)','repository-choice-list','revision: candidate.revision','candidate.project_id','scanRequests'])assert.ok(s.includes(marker),marker);
 assert.ok(!s.includes('candidate.local_key'));
 assert.ok(!read('app/projects/ProjectsClient.tsx').includes('<TraceMiniProjectDiscovery'));
});
test('original browser state distinguishes stop requested from acknowledged',async()=>{
 const source=read('app/components/trace-node/repository-selection.ts');assert.ok(source.includes('repositorySelectionState'));
 const b=await build({stdin:{contents:source,loader:'ts'},write:false,format:'esm'});
 const {repositorySelectionState}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
 assert.equal(repositorySelectionState({traced:true,desired_traced:false}).label,'Stopping trace on device…');
 assert.equal(repositorySelectionState({traced:false,desired_traced:false}).pending,false);
 assert.equal(repositorySelectionState({traced:false,desired_traced:true}).pending,true);
});
