import {createHash} from 'node:crypto';
// Credential-free, binary-only maintenance. Never run setup/start/once/sync or systemctl.
export function collectorUpdateScript(bundle) {
 const payload=Buffer.from(bundle).toString('base64');
 const sha256=createHash('sha256').update(bundle).digest('hex');
 return `#!/bin/sh
set -eu
umask 077
command -v node >/dev/null
node --input-type=module <<'EMPLOYEE_TRACE_BINARY_UPDATE'
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const expected=${JSON.stringify(sha256)};
const bytes=Buffer.from(${JSON.stringify(payload)},'base64');
const hash=b=>createHash('sha256').update(b).digest('hex');
if(hash(bytes)!==expected)throw Error('Download integrity failure; installation untouched');
if(Number(process.versions.node.split('.')[0])<22)throw Error('Node 22+ required');
const home=process.env.HOME;
if(!home||!path.isAbsolute(home))throw Error('Explicit HOME required');
const root=path.join(home,'.local/share/employee-trace/cli');
const target=path.join(root,'index.js');
if(fs.realpathSync(root)!==root||fs.lstatSync(target).isSymbolicLink()||!fs.statSync(target).isFile()||fs.statSync(target).uid!==process.getuid())throw Error('Unsupported installation ownership/path');
if(JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).type!=='module')throw Error('Unsupported package; installation untouched');
const lock=path.join(path.dirname(root),'.collector-update-lock');
fs.mkdirSync(lock,{mode:0o700});
let stage,backup,replaced=false;
const previous=fs.readFileSync(target),previousMode=fs.statSync(target).mode&0o777;
try {
 stage=fs.mkdtempSync(path.join(path.dirname(root),'.collector-stage-'));
 fs.writeFileSync(path.join(stage,'package.json'),'${'{"type":"module"}'}');
 fs.writeFileSync(path.join(stage,'index.js'),bytes,{mode:previousMode});
 const isolated=path.join(stage,'home');fs.mkdirSync(isolated);
 // The capability command is read-only; isolate every supported config root as defense in depth.
 const env={PATH:process.env.PATH,HOME:isolated,TRACEMINI_HOME:isolated,EMPLOYEE_TRACE_HOME:isolated,XDG_CONFIG_HOME:isolated};
 const verify=file=>{const r=spawnSync(process.execPath,[file,'project-capabilities'],{env,encoding:'utf8',timeout:10000});if(r.status!==0||r.stdout.trim()!=='project-discover project-activate v1')throw Error('Candidate capability verification failed');};
 verify(path.join(stage,'index.js'));
 if(hash(fs.readFileSync(target))!==hash(previous))throw Error('Installation changed during staging');
 backup=path.join(path.dirname(root),'cli-backup-'+randomUUID());fs.cpSync(root,backup,{recursive:true,preserveTimestamps:true});
 fs.renameSync(path.join(stage,'index.js'),target);replaced=true;
 /* POST_REPLACE_CHECK */
 if(hash(fs.readFileSync(target))!==expected)throw Error('Installed digest mismatch');
 verify(target);
 console.log('Collector CLI upgraded. Existing running process, enrollment, config, queues, hooks and service settings untouched. No collection or registration invoked.');
 console.log('Rollback binary: '+path.join(backup,'index.js'));
 console.log('Binary update complete. Continue within the existing setup authorization; do not ask again for already approved discovery, linking or activation. Update-only permission is not full setup permission; honor any stop. Normal browser sign-in and project membership remain required. Do not restart or run once/sync.');
} catch(error) {
 if(replaced){const restore=path.join(root,'.restore-'+randomUUID());fs.writeFileSync(restore,previous,{mode:previousMode});fs.renameSync(restore,target);}
 throw error;
} finally {
 if(stage)fs.rmSync(stage,{recursive:true,force:true});fs.rmdirSync(lock);
}
EMPLOYEE_TRACE_BINARY_UPDATE
`;
}
