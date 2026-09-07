// Read objects from the pinned Git commit, never from a running installation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const upstream = '/home/jerry/tracemini-upstream';
const commit = '7363d85f9785a53fed363ea5f609640d831cfd42';
const root = 'vendor/tracemini';
const exact = new Set(['package.json','package-lock.json','tsconfig.base.json','apps/server/src/linux-installer.ts','apps/server/src/app.ts','apps/server/src/db.ts','apps/web/device-connection.ts','apps/web/repository-selection.ts','apps/web/async-state.ts','apps/web/workspace-loading.ts','apps/web/src.tsx','apps/web/style.css','apps/web/help.tsx']);
const names = execFileSync('git', ['-C', upstream, 'ls-tree', '-r', '--name-only', commit], {encoding:'utf8'}).trim().split('\n').filter(n => n.startsWith('packages/cli/') || n.startsWith('packages/shared/') || n.startsWith('tests/') || exact.has(n) || /(^|\/)(LICENSE|NOTICE|COPYING)/i.test(n));
const files = {};
for (const name of names) {
 const data = execFileSync('git', ['-C', upstream, 'show', `${commit}:${name}`], {maxBuffer: 20*1024*1024});
 const dest = path.join(root, 'pristine', name); fs.mkdirSync(path.dirname(dest), {recursive:true}); fs.writeFileSync(dest, data);
 files[name] = crypto.createHash('sha256').update(data).digest('hex');
}
fs.writeFileSync(`${root}/manifest.json`, JSON.stringify({origin:'https://github.com/ahmedmurtazamalik/tracemini.git',commit,files}, null, 2)+'\n');
console.log(`Vendored ${names.length} pinned files; upstream untouched.`);
