import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(p,'utf8');
test('scan polling reconciles server completion immediately when candidate data refreshes',()=>{
 const s=read('app/components/trace-node/RepositorySelection.tsx');
 assert.match(s,/void poll\(\);\s*const timer/);
 assert.match(s,/\[scanActive, workspaceId, reload, candidates\]/);
 assert.match(s,/setScanRequests\(updated\)/);
 assert.match(s,/updated.every\(scan => scan.status === "completed"/);
});
test('Install automatically reuses connection check on mount and periodically',()=>{
 const s=read('app/components/trace-node/Install.tsx');
 assert.match(s,/void checkConnection\(\);/);
 assert.match(s,/setInterval\(\(\) => void checkConnection\(\), 10_000\)/);
 assert.match(s,/clearInterval\(timer\)/);
 assert.match(s,/No Node CLI enrollment found/);
});
