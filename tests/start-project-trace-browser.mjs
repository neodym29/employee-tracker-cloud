// Local real-React/browser fixture. All APIs are deterministic mocks, never production.
// Run: node tests/start-project-trace-browser.mjs
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const root = resolve(new URL('..', import.meta.url).pathname);
const dir = mkdtempSync(join(tmpdir(), 'trace-start-browser-'));
const loader = join(dir, 'loader.cjs');
writeFileSync(loader, `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText}`);
writeFileSync(join(dir, 'navigation.js'), 'export const useRouter=()=>({push:url=>{window.navigated=url}});');
writeFileSync(join(dir, 'entry.jsx'), `
import React from 'react';
import {createRoot} from 'react-dom/client';
import ProjectsClient from ${JSON.stringify(join(root, 'app/projects/ProjectsClient.tsx'))};
const accountType=new URLSearchParams(location.search).get('role')||'engineer';
let created=false, tracking='unselected';
const calls=[];
window.fetch=async(url, options={})=>{
 calls.push({url,...options});
 const candidate={id:'7',display_name:'Browser fixture repository',repository_key:'github.com/acme/fixture',branch:'main',match_status:created?'matched':'unmatched',matched_project_id:created?'99':null,tracking_state:tracking,revision:3};
 let data={ok:true};
 if(url==='/api/projects') {if(options.method==='POST'){created=true; data.project={id:'99'};}else data.projects=[];}
 else if(url==='/api/clients') data.clients=[{id:'10',display_name:'Fixture client'}];
 else if(url==='/api/engineers') data.engineers=[];
 else if(url==='/api/files-agent/devices') data.devices=[{id:'1',device_label:'Fixture laptop',last_seen_at:new Date().toISOString(),revoked_at:null}];
 else if(url==='/api/tracemini/repository-candidates/7'){tracking='pending'; data.selection={revision:4};}
 else if(url==='/api/tracemini/repository-scans' && options.method==='POST') data.scan={requestId:'1',state:'completed',count:1};
 else if(url==='/api/tracemini/repository-scans') data.candidates=[candidate];
 else throw new Error('Unexpected fixture API '+url);
 return {ok:true,json:async()=>data};
};
const wait=()=>new Promise(r=>setTimeout(r,100));
const check=(condition,message)=>{if(!condition)throw new Error(message)};
const click=label=>{const el=[...document.querySelectorAll('button')].find(x=>x.textContent===label);check(el&&!el.disabled,'Missing/enabled '+label);el.click()};
createRoot(document.getElementById('root')).render(<ProjectsClient accountType={accountType}/>);
(async()=>{try{
 await wait();await wait();
 document.querySelector('details > summary').click();await wait();await wait();
 check(document.body.textContent.includes('CLI connected'),'Connected state absent');
 click('Use repository');await wait();
 const form=document.querySelector('form');
 check([...form.querySelectorAll('input')].some(x=>x.value==='https://github.com/acme/fixture'),'Remote not populated');
 check(form.closest('section').contains(document.querySelector('.traceProjectSetup')),'Setup outside creation section');
 form.requestSubmit();await wait();await wait();
 check(created&&!window.navigated,'Setup must stay in creation interaction');
 check(form.hidden && form.getClientRects().length === 0,'Create form must disappear after success');
 click('Detect projects');await wait();click('Refresh CLI status');await wait();await wait();
 click('Track repository');await wait();await wait();
 check(document.body.textContent.includes('Pending CLI confirmation'),'Missing honest pending state');
 check(!document.body.textContent.includes('Tracking confirmed by server'),'False tracking confirmation');
 check(calls.filter(c=>c.url==='/api/projects'&&c.method==='POST').length===1,'Duplicate project creation');
 check(!document.querySelector('form form'),'Nested forms');
 check(document.documentElement.scrollWidth<=innerWidth,'Horizontal overflow '+document.documentElement.scrollWidth+'/'+innerWidth);
 document.getElementById('result').textContent='PASS '+accountType+' '+innerWidth;
}catch(e){document.getElementById('result').textContent='FAIL '+e.message;console.error(e)}})();
`);
const webpack = require('next/dist/compiled/webpack/webpack').webpack;
await new Promise((ok, fail) => webpack({mode:'development',devtool:false,context:root,entry:join(dir,'entry.jsx'),output:{path:dir,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.jsx','.js'],modules:[join(root,'node_modules')],alias:{'@':root,'next/navigation':join(dir,'navigation.js')}},module:{rules:[{test:/\.[jt]sx?$/,exclude:/node_modules/,use:loader}]}},(error,stats)=>error||stats.hasErrors()?fail(error||new Error(stats.toString())):ok()));
const css=readFileSync(join(root,'app/globals.css'),'utf8');
writeFileSync(join(dir,'index.html'),`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><pre id="result">RUNNING</pre><script src="bundle.js"></script>`);
for(const role of ['engineer','client']) for(const width of [390,1440]) {
 const result=spawnSync('/usr/bin/google-chrome',['--headless','--no-sandbox','--disable-gpu','--no-proxy-server',`--user-data-dir=${join(dir,role+width)}`,`--window-size=${width},1100`,'--virtual-time-budget=6000','--dump-dom',`--screenshot=${join(dir,role+width+'.png')}`,`file://${dir}/index.html?role=${role}`],{encoding:'utf8',timeout:30000,maxBuffer:3e6});
 writeFileSync(join(dir,role+width+'.html'),result.stdout||'');
 const marker=result.stdout?.match(/<pre id="result">([^<]*)/i)?.[1];
 console.log(marker||result.error||result.stderr);
 assert.match(marker||'',/^PASS /);
}
console.log('Local fixture evidence:',dir);
