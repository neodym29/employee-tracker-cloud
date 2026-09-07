import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {build} from 'esbuild';
import {patchSource} from '../packages/tracemini-cloud-adapter/patches/source.mjs';
const snapshot = 'vendor/tracemini/pristine';
const manifest = JSON.parse(fs.readFileSync('vendor/tracemini/manifest.json', 'utf8'));
for(const [name, hash] of Object.entries(manifest.files)) {
 const actual = crypto.createHash('sha256').update(fs.readFileSync(`${snapshot}/${name}`)).digest('hex');
 if(actual !== hash) throw new Error(`Pristine source checksum mismatch: ${name}`);
}
const stage = 'build/tracemini/stage'; fs.mkdirSync(stage, {recursive:true});
const names = ['agent.ts','config.ts','git.ts','index.ts','install.ts','pairing.ts','setup.ts'];
for(const name of names) fs.writeFileSync(`${stage}/${name}`, patchSource(name, fs.readFileSync(`${snapshot}/packages/cli/src/${name}`, 'utf8')));
fs.copyFileSync('packages/tracemini-cloud-adapter/src/transport.ts', `${stage}/api.ts`);
fs.copyFileSync('packages/tracemini-cloud-adapter/src/auth-transport.ts', `${stage}/auth-transport.ts`);
fs.writeFileSync(`${stage}/linux-installer.ts`, patchSource('linux-installer.ts',fs.readFileSync(`${snapshot}/apps/server/src/linux-installer.ts`,'utf8')));
const options = {bundle:true, platform:'node', format:'esm', target:'node22', metafile:true};
const result = await build({...options, entryPoints:[`${stage}/index.ts`], outfile:'build/tracemini/cli/index.js'});
fs.writeFileSync('build/tracemini/cli/package.json', '{"type":"module"}\n');
fs.writeFileSync('build/tracemini/metafile.json', JSON.stringify(result.metafile,null,2));
await build({...options,entryPoints:[`${stage}/linux-installer.ts`],outfile:'build/tracemini/installer.mjs'});
await build({...options,entryPoints:[`${stage}/api.ts`],outfile:'build/tracemini/transport.mjs'});
await build({...options,entryPoints:[`${stage}/git.ts`],outfile:'build/tracemini/git.mjs'});
await build({...options,stdin:{contents:"export {tick,flush} from './agent.ts'; export {loadConfig,saveConfig} from './config.ts'; export {api} from './api.ts';",resolveDir:path.resolve(stage)},outfile:'build/tracemini/engine.mjs'});
console.log('Built original TypeScript Git CLI: watch/once/start/event and explicit service-install enabled; sync/login/workspace and report/document capabilities remain gated.');
