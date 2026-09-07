import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {gunzipSync} from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
const root = new URL('../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
test('pristine original snapshot is pinned and every source hash verifies', () => {
  assert.ok(fs.existsSync(new URL('vendor/tracemini/manifest.json', root)), 'pinned snapshot missing');
  const manifest = JSON.parse(read('vendor/tracemini/manifest.json'));
  assert.equal(manifest.commit, '7363d85f9785a53fed363ea5f609640d831cfd42');
  for (const [name, hash] of Object.entries(manifest.files)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL(`vendor/tracemini/pristine/${name}`, root))).digest('hex'), hash, name);
  assert.ok(manifest.files['packages/cli/src/git.ts']);
  assert.ok(manifest.files['apps/web/src.tsx']);
});
test('original Node installer embeds executable Git CLI, not a ZIP or Python substitute', async () => {
  assert.ok(fs.existsSync(new URL('build/tracemini/installer.mjs', root)), 'original installer not built');
  const {linuxInstaller, linuxInstallCommand} = await import('../build/tracemini/installer.mjs');
  const script = linuxInstaller(new URL('build/tracemini/cli', root).pathname, 'https://cloud.invalid', 'test-only-token');
  assert.doesNotMatch(script, /python|\.zip|files-agent|sudo apt|tracemini\.service|\.local\/share\/tracemini/);
  assert.match(script, /employee-trace\.service/);
  const payload = [...script.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64/g)].map(m => gunzipSync(Buffer.from(m[1], 'base64')).toString()).join('\n');
  assert.match(payload, /repositoryFingerprint/);
  assert.match(payload, /commitHistoryAfterHeads/);
  assert.doesNotMatch(payload, /startDocumentLoopbackServer|class CodexRunner|pdfjs-dist/);
  const command=linuxInstallCommand('https://cloud.invalid', 'test-only-token');
  assert.match(command, /umask 077.*mktemp -d/);
  assert.match(command, /--data-binary @- 'https:\/\/cloud.invalid\/api\/installers\/linux'/);
  assert.doesNotMatch(command, /linux\/test-only-token|--location/);
  const help = execFileSync(process.execPath, ['build/tracemini/cli/index.js', '--help'], {cwd: root, encoding: 'utf8', env: {...process.env, EMPLOYEE_TRACE_HOME: '/tmp/employee-trace-test-no-install'}});
  assert.match(help, /employee-trace/);
});
test('unfinished transport fails closed without sending credentials or payloads', async () => {
  assert.ok(fs.existsSync(new URL('build/tracemini/transport.mjs', root)), 'cloud boundary missing');
  const {api} = await import('../build/tracemini/transport.mjs');
  const old = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('secret'); };
  try { await assert.rejects(api({agentToken:'secret'}, '/api/agents/install/exchange'), /not enabled/); assert.equal(calls, 0); }
  finally { globalThis.fetch = old; }
});
test('compiled CLI setup fails without cloud API and never claims installation or enables tracking', async t => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'trace-no-api-'));
  t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const requests=[];
  const server=createServer((req,res)=>{requests.push(req.url);req.resume();res.writeHead(404).end();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const home=path.join(tmp,'state');
  const bin=path.join(tmp,'bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'systemctl'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const setup=promisify(execFile)(process.execPath,[new URL('build/tracemini/cli/index.js',root).pathname,'setup','--server',`http://127.0.0.1:${server.address().port}`,'--install-token','eti_'+crypto.randomBytes(32).toString('base64url')],{
    env:{...process.env,HOME:tmp,PATH:bin+':'+process.env.PATH,EMPLOYEE_TRACE_HOME:home},timeout:10000,
  });
  setup.child.stdin.end(tmp+'\nn\n'); // Exercise the restored original guided setup before its failed exchange.
  await assert.rejects(setup,error=>{
    assert.equal(error.code,1);
    assert.match(error.stderr,/Cloud Trace authentication request failed/);
    assert.doesNotMatch(error.stdout,/Device enrolled|completed successfully|Background service started/);
    return true;
  });
  assert.deepEqual(requests,['/api/agents/install/exchange']);
  assert.equal(fs.existsSync(path.join(home,'config.json')),false);
  assert.equal(fs.existsSync(path.join(home,'queue.json')),false);
  assert.equal(fs.existsSync(path.join(tmp,'.config/systemd/user/employee-trace.service')),false);
});
test('original compiled Git engine discovers committed repositories and refuses upstream hooks untouched', async () => {
  const engine = await import('../build/tracemini/git.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-trace-git-'));
  const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, {cwd:repo, encoding:'utf8', stdio:['ignore','pipe','pipe']});
  try {
    git('init'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
    fs.writeFileSync(path.join(repo,'fixture.txt'),'fixture\n'); git('add','.'); git('commit','-m','fixture');
    assert.deepEqual(engine.discover(tmp), [repo]);
    assert.match(engine.repositoryFingerprint(repo), /^[a-f0-9]{64}$/);
    assert.equal(engine.commitData(repo).filesChanged, 1);
    const hook = path.join(repo,'.git/hooks/post-commit');
    const original = '#!/bin/sh\n# TraceMini managed hook\nexit 0\n'; fs.writeFileSync(hook,original);
    assert.throws(() => engine.installHooks(repo), /Upstream hook conflict/);
    assert.equal(fs.readFileSync(hook,'utf8'), original);
    assert.equal(fs.existsSync(hook+'.employee-trace-owner'),false);
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
});
test('Install generator reproduces the checked-in JSX and keeps original layout helpers', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-install-generator-'));
  t.after(() => fs.rmSync(tmp, {recursive:true, force:true}));
  fs.symlinkSync(new URL('vendor', root).pathname, path.join(tmp, 'vendor'), 'dir');
  execFileSync(process.execPath, [new URL('scripts/extract-tracemini-install.mjs', root).pathname], {cwd:tmp});
  const generated = fs.readFileSync(path.join(tmp, 'app/components/trace-node/Install.tsx'), 'utf8');
  assert.equal(generated, read('app/components/trace-node/Install.tsx'));
  const upstream = read('vendor/tracemini/pristine/apps/web/src.tsx');
  for (const marker of ['function BusyIndicator(', 'const Copy =', 'function PageHeading(', 'className="card install-card"', 'className="step-number"', 'className="command"']) {
    assert.ok(upstream.includes(marker), `original seam: ${marker}`);
    assert.ok(generated.includes(marker), `retained seam: ${marker}`);
  }
});

test('Trace onboarding never presents the Python collector as the original CLI', () => {
  assert.doesNotMatch(read('app/components/DesktopCliConnection.tsx'), /FilesAgentDownload/);
  assert.match(read('app/components/DesktopCliConnection.tsx'), /TraceNodeInstall/);
  const extracted=read('app/components/trace-node/Install.tsx');
  assert.match(extracted, /function Install\(/);
  assert.doesNotMatch(extracted, /workspaceId|userId|\/api\/reports/);
  assert.match(extracted, /folders you approve/);
  assert.match(extracted, /automatically starts the namespaced/);
  assert.match(extracted, /employee-trace\.service/);
  assert.match(extracted, /select repositories in this GUI/);
  assert.match(extracted, /Enrollment alone is not an online heartbeat/);
  assert.match(extracted, /Git hooks and tracking require your explicit repository selection/);
  assert.doesNotMatch(extracted, /enrollment preview|sync pending|synchronization is not enabled|No hooks, watched folders or background service are enabled|stops at sync pending|commands remain gated/);
  assert.match(extracted, /expires after 10 minutes and works once/);
  assert.match(extracted, /Keep it out of chat, tickets and logs/);
  assert.match(extracted, /rolls back local installation changes/);
  assert.match(read('next.config.ts'), /build\/tracemini\/cli/);
});
