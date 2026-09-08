// Disposable local Next + PostgreSQL + original CLI + real Chromium acceptance. No production env reads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync,execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import {chromium} from '/tmp/trace-qa-tools/node_modules/playwright/index.mjs';
const exec=promisify(execFile),root=process.cwd(),out=fs.mkdtempSync('/tmp/trace-http-browser-'),scratch=fs.mkdtempSync('/tmp/trace-http-private-');
const origin='http://localhost:3297',secret=crypto.randomBytes(32).toString('hex');
let container,db,server,browser;const rows=[],errors=[],http=[];
const record=(name,value)=>{rows.push({name,value});fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({rows,errors,http},null,2));console.log(name,JSON.stringify(value));};
try{
 container=execFileSync('docker',['run','-d','--rm','-e','POSTGRES_PASSWORD=test','-e','POSTGRES_DB=test','-p','127.0.0.1::5432','postgres:16-alpine'],{encoding:'utf8'}).trim();
 const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8'}).trim().split(':').pop();
 const env={PATH:process.env.PATH,HOME:scratch,NODE_ENV:'production',NEXT_PUBLIC_APP_URL:origin,DATABASE_URL:`postgres://postgres:test@localhost:${port}/test`,AUTH_SECRET:secret,FILES_AGENT_BINDING_KEY:crypto.randomBytes(48).toString('hex'),PORT:'3297',EMPLOYEE_TRACE_HOME:path.join(scratch,'state')};
 Object.assign(process.env,{DATABASE_URL:env.DATABASE_URL});
 await build({entryPoints:['lib/db.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',outfile:'build/qa-local-db.cjs'});
 const mod=await import(path.join(root,'build/qa-local-db.cjs'));db=mod.getPool();
 for(let i=0;;i++){try{await db.query('select 1');break;}catch(e){if(i>60)throw e;await new Promise(r=>setTimeout(r,200));}}
 await mod.ensureSchema();
 await db.query("insert into companies(id,name,domain) values(1,'Fixture','example.test');insert into app_users(id,company_id,email,role,account_type,approval_status,display_name) values(11,1,'test@example.test','employee','client','approved','Fixture client');insert into projects(id,client_id,title,status,approval_status,git_repository_key,git_remote_url) values(700,11,'Browser fixture repository','completed','approved','github.com/acme/existing','https://github.com/acme/existing');");
 for(const name of ['020_tracemini_project_discovery.sql','021_tracemini_node_install.sql','022_tracemini_node_git.sql'])await db.query(fs.readFileSync('migrations/'+name,'utf8'));
 // Full-schema projects default to telemetry paused; explicitly authorize this disposable fixture.
 await db.query('update projects set tracemini_telemetry_paused=false where id=700');
 record('fixture_telemetry',(await db.query('select tracemini_telemetry_paused from projects where id=700')).rows);
 const token='etn_'+crypto.randomBytes(32).toString('base64url');
 await db.query('insert into tracemini_node_contexts(id,company_id,user_id) values(50,1,11)');
 await db.query("insert into tracemini_node_devices(id,context_id,company_id,user_id,installation_hash,credential_hash,machine_name) values(5,50,1,11,$1,$2,'Fixture laptop')",['a'.repeat(64),crypto.createHash('sha256').update(token).digest('hex')]);
 const log=fs.openSync(path.join(out,'next.log'),'w');server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3297'],{cwd:root,env,stdio:['ignore',log,log]});
 for(let i=0;;i++){try{await fetch(origin+'/login');break;}catch(e){if(i>60)throw e;await new Promise(r=>setTimeout(r,500));}}
 record('anonymous_discovery',(await fetch(origin+'/api/agents/discovery')).status);
 const repo=path.join(scratch,'widget');fs.mkdirSync(repo);const git=(...a)=>execFileSync('git',['-C',repo,...a],{stdio:'ignore'});git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','test@example.test');fs.writeFileSync(path.join(repo,'private.txt'),'private');git('add','.');git('commit','-m','private fixture');git('remote','add','origin','https://github.com/acme/widget.git');
 fs.mkdirSync(env.EMPLOYEE_TRACE_HOME);fs.writeFileSync(path.join(env.EMPLOYEE_TRACE_HOME,'config.json'),JSON.stringify({serverUrl:origin,agentToken:token,agentId:5,workspaceId:50,watchedPaths:[],watchedRoots:[],clones:[],documents:[]}));
 const cli=(...a)=>exec(process.execPath,['--require',path.join(root,'tests/local-node-fetch-diagnostics.cjs'),path.join(root,'build/tracemini/cli/index.js'),...a],{env:{...env,QA_FETCH_LOG:path.join(out,'cli-http.jsonl')},timeout:25000});
 const state=async label=>record(label,{selections:(await db.query('select candidate_id,revision,desired_tracking,claim_token is not null as claimed,completed_at is not null as completed from tracemini_repository_selections')).rows,candidates:(await db.query('select id,revision,tracking_state from tracemini_repository_candidates')).rows});
 const probe=await fetch(origin+'/api/agents/git/sync',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'});record('next_git_sync',{status:probe.status,body:await probe.json()});
 if(probe.status!==200){await build({entryPoints:['lib/tracemini-node-git.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',outfile:'build/qa-local-node.cjs',plugins:[{name:'server-only',setup(b){b.onResolve({filter:/^server-only$/},()=>({path:'empty',namespace:'qa'}));b.onLoad({filter:/.*/,namespace:'qa'},()=>({contents:''}));}}]});try{await(await import(path.join(root,'build/qa-local-node.cjs'))).nodeGitRequest(token,'sync',{});}catch(e){record('direct_diagnostic',{message:e.message,code:e.code});}}
 try{await cli('watch',repo);}catch(e){record('cli_watch_failed',true);}
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--no-proxy-server']});
 const context=await browser.newContext({viewport:{width:1440,height:1100},permissions:['clipboard-read','clipboard-write']});
 const payload=Buffer.from(JSON.stringify({id:'11',company_id:'1',email:'test@example.test',role:'employee',account_type:'client',company_domain:'example.test',exp:Date.now()+3600000})).toString('base64url');
 await context.addCookies([{name:'trace_session_v2',value:payload+'.'+crypto.createHmac('sha256',secret).update(payload).digest('base64url'),url:origin,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{const u=new URL(r.url());if(u.pathname.startsWith('/api/')&&!u.pathname.includes('/installers/'))http.push({method:r.request().method(),path:u.pathname,status:r.status()});});
 const anonymousSetup=await fetch(origin+'/trace-setup',{redirect:'manual'});assert.equal(anonymousSetup.status,307);assert.ok(anonymousSetup.headers.get('location').includes('/login'));record('anonymous_setup_redirect',true);
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1100});await page.goto(origin+'/projects');await page.getByRole('heading',{name:'Create project',exact:true}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'Account repositories'}).count(),0);assert.equal(await page.locator('.command pre').count(),0);assert.equal(await page.getByRole('button',{name:/Prepare agent setup prompt|Scan repositories on my devices/}).count(),0);
  await page.screenshot({path:path.join(out,`${width}-projects.png`),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth));record('projects_no_inline_setup_'+width,true);
  await page.locator('main').getByRole('link',{name:'Set up Trace CLI',exact:true}).click();await page.waitForURL(origin+'/trace-setup');await page.getByRole('heading',{name:'Account repositories'}).waitFor();
  assert.equal(await page.locator('nav a[href="/trace-setup"][aria-current="page"]').count(),1);await page.getByRole('link',{name:'Back to projects',exact:true}).click();await page.waitForURL(origin+'/projects');
 }
 await page.locator('nav').getByRole('link',{name:'Set up Trace CLI',exact:true}).click();await page.waitForURL(origin+'/trace-setup');await page.reload();await page.getByRole('heading',{name:'Account repositories'}).waitFor();record('authenticated_dedicated_setup',true);
 await page.getByRole('button',{name:/^(Prepare agent setup prompt|Connect another device)$/}).click();await page.locator('.command pre').waitFor();
 const command=await page.locator('.command pre').innerText();assert.ok(command.includes("'/api/installers/linux'") || command.includes("/api/installers/linux'"));assert.ok(command.includes('--data-binary @-'));assert.ok(command.includes('--request POST'));assert.ok(!/\.zip|unzip/i.test(command));
 await page.getByRole('button',{name:'COPY AGENT SETUP PROMPT',exact:true}).click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),command);assert.ok(command.startsWith('Set up Employee Trace'));assert.ok(command.includes('do not perform it automatically.'));record('entire_setup_prompt_copy',true);
 await page.screenshot({path:path.join(out,'desktop-install-masked.png'),fullPage:true,mask:[page.locator('.command pre')]});
 for(const width of [1440,390]){await page.setViewportSize({width,height:1100});const previous=await page.locator('.command pre').innerText();await page.getByRole('button',{name:'Generate a new prompt',exact:true}).click();await page.waitForFunction(previous=>{const p=document.querySelector('.command pre');return p&&p.textContent!==previous;},previous);const prompt=await page.locator('.command pre').innerText();await page.getByRole('button',{name:/^(COPY AGENT SETUP PROMPT|Copied)$/}).click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),prompt);record('generated_entire_prompt_copy_'+width,true);await page.screenshot({path:path.join(out,`${width}-install-masked.png`),fullPage:true,mask:[page.locator('.command pre')]});record('install_geometry_'+width,await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth})));}
 if(probe.status!==200)throw Error('Full schema Git sync 500 blocks candidate/selection/history/stop; install browser lane completed');
 await page.setViewportSize({width:1440,height:1100});
 await page.getByRole('button',{name:'Scan repositories on my devices'}).click();await cli('once');await page.getByRole('button',{name:'Link to existing project',exact:true}).waitFor({timeout:20000});assert.equal((await db.query('select matched_project_id from tracemini_repository_candidates')).rows[0].matched_project_id,null);record('unmatched_link_visible',true);await page.screenshot({path:path.join(out,'unmatched-link-masked.png'),fullPage:true,mask:[page.locator('.command pre')]}); for(const width of [1440,390]){await page.setViewportSize({width,height:1100});await page.getByRole('button',{name:'Link to existing project',exact:true}).click();await page.getByRole('combobox',{name:/Existing project for/}).selectOption('700');await page.screenshot({path:path.join(out,`${width}-repo-link-masked.png`),fullPage:true,mask:[page.locator('.command pre')]});await page.getByRole('button',{name:'Confirm link',exact:true}).click();await page.getByRole('link',{name:'Open existing project',exact:true}).waitFor();assert.equal(String((await db.query('select explicit_project_id from tracemini_repository_candidates')).rows[0].explicit_project_id),'700');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth));record('completed_project_explicit_link_'+width,true);if(width===1440){await db.query('update tracemini_repository_candidates set explicit_project_id=null');await page.getByRole('button',{name:'Refresh Node status'}).click();await page.getByRole('button',{name:'Link to existing project',exact:true}).waitFor();}}
 await page.setViewportSize({width:1440,height:1100});
 await page.getByRole('switch').first().click();await page.locator('.selection-state').filter({hasText:/pending|waiting|starting/i}).waitFor({timeout:10000});
 record('selection_pending',await page.locator('.selection-state').allTextContents());
 await page.screenshot({path:path.join(out,'desktop-pending-masked.png'),fullPage:true,mask:[page.locator('.command pre')]});
 await state('before_activation');const activation=await cli('once');await state('after_activation');record('activation_cli_output',{stdout:activation.stdout,stderr:activation.stderr});await page.getByRole('button',{name:'Refresh Node status'}).click();await page.waitForTimeout(500);
 assert.deepEqual(await page.locator('.selection-state').allTextContents(),['Traced']);record('selection_confirmed',await page.locator('.selection-state').allTextContents());
 await page.getByText(/Scan complete on 1 device\. Found/).waitFor({timeout:15000});
 await page.getByRole('heading',{name:'Node enrollment verified',exact:true}).waitFor();
 assert.equal(await page.getByText('Waiting for an authenticated Node poll.',{exact:false}).count(),0);
 record('scan_and_enrollment_reconciled',true);
 const events=(await db.query('select action,evidence_eligible from project_tracemini_events')).rows;assert.ok(events.some(e=>e.action==='commit_history'));record('history',events);
 assert.ok(fs.existsSync(path.join(repo,'.git/hooks/post-commit')));record('managed_hook',true);
 for(const width of [1440,390]){await page.setViewportSize({width,height:1100});await page.screenshot({path:path.join(out,`${width}-confirmed-masked.png`),fullPage:true,mask:[page.locator('.command pre')]});record('geometry_'+width,await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth})));}
 await page.getByRole('switch').first().click();await page.locator('.selection-state').filter({hasText:'Stopping trace on device'}).waitFor({timeout:10000});record('stop_pending',await page.locator('.selection-state').allTextContents());await cli('once');await page.getByRole('button',{name:'Refresh Node status'}).click();await page.waitForTimeout(500);assert.deepEqual(await page.locator('.selection-state').allTextContents(),['Not selected']);await state('after_stop');record('stop_confirmed',await page.locator('.selection-state').allTextContents());assert.ok(!fs.existsSync(path.join(repo,'.git/hooks/post-commit')));
 for(const width of [1440,390]){await page.setViewportSize({width,height:1100});await page.screenshot({path:path.join(out,`${width}-stopped-masked.png`),fullPage:true,mask:[page.locator('.command pre')]});}
 // Regression: an acknowledged failed activation must not remain “Starting”.
 await db.query('update projects set tracemini_telemetry_paused=true where id=700');
 await page.getByRole('switch').first().click();await page.locator('.selection-state').filter({hasText:'Starting trace on device'}).waitFor();await cli('once');
 await page.getByRole('button',{name:'Refresh Node status'}).click();
 await page.getByText('Device could not apply selection. Retry or reconnect.',{exact:false}).waitFor({timeout:10000});
 await state('paused_activation_acknowledged');record('paused_activation_not_pending',await page.locator('.selection-state').allTextContents());assert.ok(!fs.existsSync(path.join(repo,'.git/hooks/post-commit')));
 record('browser_errors',errors);assert.equal(errors.length,0);record('completed',true);
}catch(e){record('failure',e.message);process.exitCode=1;}finally{await browser?.close();if(server&&server.exitCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await exited;}await db?.end();if(container)execFileSync('docker',['rm','-f',container],{stdio:'ignore'});fs.rmSync(scratch,{recursive:true,force:true});record('owned_cleanup',{serverExited:!server||server.exitCode!==null||server.signalCode!==null,privateStateRemoved:!fs.existsSync(scratch),containerRemoved:!container||!execFileSync('docker',['ps','-aq','--filter','id='+container],{encoding:'utf8'}).trim()});console.log('EVIDENCE',out);}
