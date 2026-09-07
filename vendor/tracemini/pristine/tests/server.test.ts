import {afterEach, describe, expect, it, vi} from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {AsyncLocalStorage} from 'node:async_hooks';
import crypto from 'node:crypto';
import type {DB} from '../apps/server/src/db.js';
import {openTestDb} from '../apps/server/src/test-db.js';
import {createApp} from '../apps/server/src/app.js';
import {linuxInstaller} from '../apps/server/src/linux-installer.js';

let db: DB;
afterEach(async () => {
  vi.restoreAllMocks();
  if (db) {
    await db.close();
    db = undefined as unknown as DB;
  }
});
const auth = (token: string) => ({authorization: `${String.fromCharCode(66, 101, 97, 114, 101, 114)} ${token}`});
const installToken = (installation: any) => decodeURIComponent(installation.installCommand.match(/\/api\/installers\/linux\/([^']+)/)[1]);
const execFileAsync = promisify(execFile);
const testFingerprint = 'a'.repeat(64);
const approveRepository = async (app: any, userToken: string, agentToken: string, workspaceId: number, candidate: {localKey: string; name: string; remoteUrl: string; branch?: string}) => {
  await request(app).post('/api/agents/repository-candidates').set(auth(agentToken)).send({repositories: [{...candidate, traced: false, identityFingerprint: testFingerprint}]}).expect(200);
  const candidates = (await request(app).get(`/api/workspaces/${workspaceId}/repository-candidates`).set(auth(userToken)).expect(200)).body;
  const selected = candidates.find((current: any) => current.local_key === candidate.localKey);
  await request(app).patch(`/api/workspaces/${workspaceId}/repository-candidates/${selected.id}`).set(auth(userToken)).send({traced: true}).expect(200);
  return selected;
};
const inviteAndAccept = async (app: any, managerToken: string, workspaceId: number, recipient: any, role = 'Developer') => {
  const invitation = (await request(app).post(`/api/workspaces/${workspaceId}/invitations`).set(auth(managerToken)).send({email: recipient.user.email, role}).expect(201)).body;
  await request(app).post(`/api/invitations/${invitation.id}/accept`).set(auth(recipient.token)).expect(200);
  return invitation;
};

class SerializedTransactionsDb {
  private tail: Promise<void> = Promise.resolve();
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private pendingPushReads = 0;
  private releasePendingPushReads?: () => void;
  private readonly pendingPushReadsReady = new Promise<void>(resolve => { this.releasePendingPushReads = resolve; });

  constructor(private readonly inner: DB) {}

  prepare(sql: string) {
    const statement = this.inner.prepare(sql);
    if (sql !== "SELECT * FROM pending_pushes WHERE id=? AND agent_id=? AND status='pending'") return statement;
    return {
      ...statement,
      get: async (...values: any[]) => {
        const row = await statement.get(...values);
        if (!this.transactionContext.getStore()) {
          this.pendingPushReads += 1;
          if (this.pendingPushReads === 2) this.releasePendingPushReads?.();
          await this.pendingPushReadsReady;
        }
        return row;
      },
    };
  }

  query(text: string, values?: any[]) { return this.inner.query(text, values); }

  async transaction<T>(fn: (db: DB) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await this.inner.transaction(async () => this.transactionContext.run(true, () => fn(this as unknown as DB)));
    } finally {
      release();
    }
  }
}

class TransactionRecordingDb {
  readonly calls: Array<{sql: string; inTransaction: boolean}> = [];
  private readonly transactionContext = new AsyncLocalStorage<boolean>();

  constructor(private readonly inner: DB) {}

  prepare(sql: string) {
    const statement = this.inner.prepare(sql);
    const record = (fn: (...values: any[]) => any) => async (...values: any[]) => {
      this.calls.push({sql, inTransaction: Boolean(this.transactionContext.getStore())});
      return fn(...values);
    };
    return {get: record(statement.get), all: record(statement.all), run: record(statement.run)};
  }

  query(text: string, values?: any[]) { return this.inner.query(text, values); }
  transaction<T>(fn: (db: DB) => Promise<T>): Promise<T> {
    return this.inner.transaction(async () => this.transactionContext.run(true, () => fn(this as unknown as DB)));
  }
  reset() { this.calls.length = 0; }
}

class ManagerPreflightGateDb {
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private triggered = false;
  private signalReached!: () => void;
  private releaseGate!: () => void;
  readonly reached = new Promise<void>(resolve => { this.signalReached = resolve; });
  private readonly released = new Promise<void>(resolve => { this.releaseGate = resolve; });

  constructor(private readonly inner: DB) {}

  prepare(sql: string) {
    const statement = this.inner.prepare(sql);
    if (sql !== 'SELECT * FROM workspace_members WHERE user_id=? AND workspace_id=?') return statement;
    return {
      ...statement,
      get: async (...values: any[]) => {
        const row = await statement.get(...values);
        if (!this.triggered && !this.transactionContext.getStore()) {
          this.triggered = true;
          this.signalReached();
          await this.released;
        }
        return row;
      },
    };
  }

  query(text: string, values?: any[]) { return this.inner.query(text, values); }
  transaction<T>(fn: (db: DB) => Promise<T>): Promise<T> {
    return this.inner.transaction(async () => this.transactionContext.run(true, () => fn(this as unknown as DB)));
  }
  release() { this.releaseGate(); }
}

describe('approved server workflows', () => {
  it('uses database-aware health and returns a retryable response when hosted sessions are exhausted', async () => {
    const failure: any = new Error('MaxClientsInSessionMode: max clients reached in session mode');
    failure.code = 'EMAXCONNSESSION';
    const unavailable = {query: async () => { throw failure; }} as unknown as DB;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await request(createApp(unavailable)).get('/api/health').expect(503);
    expect(response.body.error).toContain('temporarily busy');
    expect(response.headers['retry-after']).toBe('5');
    logged.mockRestore();
  });

  it('describes the installed background service as a device', () => {
    const installerSource = fs.readFileSync(path.resolve('packages/cli/src/install.ts'), 'utf8');
    expect(installerSource).toContain('Description=TraceMini local Git device');
    expect(installerSource).not.toContain('Description=TraceMini local Git agent');
    expect(installerSource).toContain('Restart=always');
    expect(installerSource).not.toContain('Restart=on-failure');
  });

  it('creates a personal Manager workspace without exposing retired invite codes', async () => {
    db = await openTestDb();
    const app = createApp(db);
    expect((await request(app).get('/api/agents/status').set(auth('invalid-device-token')).expect(401)).body).toEqual({error: 'unauthorized device'});
    await request(app).post('/api/auth/password-reset/request').send({email: 'joey@test.local'}).expect(404);
    await request(app).post('/api/auth/password-reset/complete').send({token: 'removed', password: 'password123'}).expect(404);

    const joey = (await request(app).post('/api/auth/register').send({name: 'Joey', email: 'joey@test.local', password: 'password123'}).expect(201)).body;
    const workspaces = (await request(app).get('/api/workspaces').set(auth(joey.token)).expect(200)).body;

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({name: "Joey's workspace", role: 'Manager'});
    expect(workspaces[0]).not.toHaveProperty('invite_code');
    expect(workspaces[0]).not.toHaveProperty('invite_enabled');

    const jane = (await request(app).post('/api/auth/register').send({name: 'Jane', email: 'jane@test.local', password: 'password123'}).expect(201)).body;
    const janeWorkspace = (await request(app).get('/api/workspaces').set(auth(jane.token)).expect(200)).body[0];
    expect(janeWorkspace).not.toHaveProperty('invite_code');

    await inviteAndAccept(app, joey.token, workspaces[0].id, jane);
    await request(app).patch(`/api/workspaces/${workspaces[0].id}`).set(auth(jane.token)).send({name: 'Developer rename'}).expect(403);
    await request(app).patch(`/api/workspaces/${workspaces[0].id}`).set(auth(joey.token)).send({name: '   '}).expect(400);
    expect((await request(app).patch(`/api/workspaces/${workspaces[0].id}`).set(auth(joey.token)).send({name: '  Product delivery  '}).expect(200)).body).toEqual({id: workspaces[0].id, name: 'Product delivery'});
    expect((await request(app).get('/api/workspaces').set(auth(jane.token)).expect(200)).body.find((workspace: any) => workspace.id === workspaces[0].id).name).toBe('Product delivery');
  });

  it('retries invite-code collisions without misreporting them as duplicate email', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const holder = (await request(app).post('/api/auth/register').send({name: 'Holder', email: 'holder@test.local', password: 'password123'}).expect(201)).body;
    const holderWorkspace = (await request(app).get('/api/workspaces').set(auth(holder.token)).expect(200)).body[0];
    await db.prepare('UPDATE workspaces SET invite_code=? WHERE id=?').run('AAAAAAAAAA', holderWorkspace.id);

    const realRandomBytes = crypto.randomBytes.bind(crypto);
    const inviteBytes = ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'];
    vi.spyOn(crypto, 'randomBytes').mockImplementation(((size: number) =>
      size === 5 ? Buffer.from(inviteBytes.shift()!, 'hex') : realRandomBytes(size)) as any);

    const newcomer = (await request(app).post('/api/auth/register').send({name: 'Collision', email: 'collision@test.local', password: 'password123'}).expect(201)).body;
    const newcomerWorkspace = (await request(app).get('/api/workspaces').set(auth(newcomer.token)).expect(200)).body[0];
    expect((await db.prepare('SELECT invite_code,invite_enabled FROM workspaces WHERE id=?').get(newcomerWorkspace.id) as any)).toMatchObject({invite_code: 'BBBBBBBBBB', invite_enabled: false});
    await request(app).post(`/api/workspaces/${newcomerWorkspace.id}/invite/regenerate`).set(auth(newcomer.token)).expect(410);
  });

  it('retires shared invite-code joins and management endpoints', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const user = (await request(app).post('/api/auth/register').send({name: 'Invite', email: 'invite@test.local', password: 'password123'}).expect(201)).body;
    const workspace = (await request(app).get('/api/workspaces').set(auth(user.token)).expect(200)).body[0];

    await request(app).post('/api/workspaces/join').set(auth(user.token)).send({inviteCode: 'AAAAAAAAAA'}).expect(410);
    await request(app).post(`/api/workspaces/${workspace.id}/invite/regenerate`).set(auth(user.token)).expect(410);
    await request(app).post(`/api/workspaces/${workspace.id}/invite/disable`).set(auth(user.token)).expect(410);
    expect((await db.prepare('SELECT invite_enabled FROM workspaces WHERE id=?').get(workspace.id) as any).invite_enabled).toBe(false);
  });

  it('rejects invalid registration email and password values at the API boundary', async () => {
    db = await openTestDb();
    const app = createApp(db);
    await request(app).post('/api/auth/register').send({name: 'Short', email: 'short@example.test', password: 'short'}).expect(400);
    await request(app).post('/api/auth/register').send({name: 'Invalid', email: 'not-an-email', password: 'password123'}).expect(400);
    await request(app).post('/api/auth/register').send({name: '   ', email: 'blank@example.test', password: 'password123'}).expect(400);
    await request(app).post('/api/auth/register').send({name: 'Duplicate', email: 'duplicate@example.test', password: 'password123'}).expect(201);
    await request(app).post('/api/auth/register').send({name: 'Duplicate again', email: 'duplicate@example.test', password: 'password123'}).expect(409);
  });

  it('exchanges an install token once and enforces Manager invariants', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const register = async (name: string) => (await request(app).post('/api/auth/register').send({name, email: `${name}@test.local`, password: 'password123'}).expect(201)).body;
    const manager = await register('manager');
    const memberUser = await register('member');
    const workspace = (await request(app).post('/api/workspaces').set(auth(manager.token)).send({name: 'Managed'}).expect(201)).body;
    expect((await request(app).get('/api/workspaces').set(auth(manager.token))).body[0].role).toBe('Manager');
    await inviteAndAccept(app, manager.token, workspace.id, memberUser);
    const visibleMembers = (await request(app).get(`/api/workspaces/${workspace.id}/members`).set(auth(memberUser.token)).expect(200)).body;
    expect(visibleMembers.map((member: any) => member.name)).toEqual(expect.arrayContaining(['manager', 'member']));
    await request(app).get(`/api/workspaces/${workspace.id}/repositories`).set(auth(memberUser.token)).expect(200);

    const installation = (await request(app).post('/api/agents/installations').set(auth(memberUser.token)).set('x-forwarded-proto', 'https').set('host', 'tracemini-eight.vercel.app').send({workspaceId: workspace.id}).expect(201)).body;
    expect(installation).not.toHaveProperty('code');
    expect(installation.installCommand).toContain('https://tracemini-eight.vercel.app');
    const token = installToken(installation);
    const installationIdentity = 'c'.repeat(64);
    const exchange = (await request(app).post('/api/agents/install/exchange').send({installToken: token, machineName: 'member-box', installationId: installationIdentity}).expect(201)).body;
    expect(exchange).toMatchObject({workspaceId: workspace.id, agentId: expect.any(Number), agentToken: expect.any(String)});
    expect(exchange).not.toHaveProperty('userToken');
    await request(app).post('/api/agents/install/exchange').send({installToken: token, machineName: 'replay'}).expect(409);

    const synchronizedInstallation = (await request(app).post('/api/agents/installations').set(auth(memberUser.token)).send({workspaceId: workspace.id}).expect(201)).body;
    const synchronized = (await request(app).post('/api/agents/install/exchange').set(auth(exchange.agentToken)).send({installToken: installToken(synchronizedInstallation), machineName: 'member-box', installationId: installationIdentity}).expect(201)).body;
    expect(synchronized.agentId).toBe(exchange.agentId);
    await request(app).get('/api/agents/status').set(auth(exchange.agentToken)).expect(401);
    await request(app).get('/api/agents/status').set(auth(synchronized.agentToken)).expect(200);
    const visibleDevices = (await request(app).get(`/api/workspaces/${workspace.id}/agents`).set(auth(memberUser.token)).expect(200)).body;
    expect(visibleDevices.filter((device: any) => device.user_id === memberUser.user.id)).toHaveLength(1);

    const restoredInstallation = (await request(app).post('/api/agents/installations').set(auth(memberUser.token)).send({workspaceId: workspace.id}).expect(201)).body;
    const restored = (await request(app).post('/api/agents/install/exchange').send({installToken: installToken(restoredInstallation), machineName: 'member-box', installationId: installationIdentity}).expect(201)).body;
    expect(restored.agentId).toBe(exchange.agentId);
    await request(app).get('/api/agents/status').set(auth(synchronized.agentToken)).expect(401);
    await request(app).get('/api/agents/status').set(auth(restored.agentToken)).expect(200);
    expect((await request(app).get(`/api/workspaces/${workspace.id}/agents`).set(auth(memberUser.token)).expect(200)).body.filter((device: any) => device.user_id === memberUser.user.id)).toHaveLength(1);

    const legacyLogin = (await request(app).post('/api/agents/register').set(auth(memberUser.token)).send({machineName: 'member-box', installationId: installationIdentity}).expect(201)).body;
    expect(legacyLogin.agentId).toBe(exchange.agentId);
    await request(app).get('/api/agents/status').set(auth(restored.agentToken)).expect(401);
    await request(app).get('/api/agents/status').set(auth(legacyLogin.token)).expect(200);
    expect((await request(app).get(`/api/workspaces/${workspace.id}/agents`).set(auth(memberUser.token)).expect(200)).body.filter((device: any) => device.user_id === memberUser.user.id)).toHaveLength(1);

    const parallel = (await request(app).post('/api/auth/register').send({name: 'Parallel device', email: 'parallel-device@example.test', password: 'password123'}).expect(201)).body;
    await inviteAndAccept(app, manager.token, workspace.id, parallel);
    const parallelSetups = await Promise.all([1, 2].map(async () => (await request(app).post('/api/agents/installations').set(auth(parallel.token)).send({workspaceId: workspace.id}).expect(201)).body));
    const parallelIdentity = 'd'.repeat(64);
    const parallelExchanges = await Promise.all(parallelSetups.map(setup => request(app).post('/api/agents/install/exchange').send({installToken: installToken(setup), machineName: 'parallel-box', installationId: parallelIdentity}).expect(201).then(response => response.body)));
    expect(new Set(parallelExchanges.map(exchangeResult => exchangeResult.agentId)).size).toBe(1);
    expect((await request(app).get(`/api/workspaces/${workspace.id}/agents`).set(auth(parallel.token)).expect(200)).body.filter((device: any) => device.user_id === parallel.user.id)).toHaveLength(1);
    const parallelStatuses = await Promise.all(parallelExchanges.map(exchangeResult => request(app).get('/api/agents/status').set(auth(exchangeResult.agentToken)).then(response => response.status)));
    expect(parallelStatuses.sort()).toEqual([200, 401]);

    const memberId = memberUser.user.id;
    await request(app).patch(`/api/workspaces/${workspace.id}/members/${memberId}`).set(auth(memberUser.token)).send({role: 'Manager'}).expect(403);
    await request(app).patch(`/api/workspaces/${workspace.id}/members/${memberId}`).set(auth(manager.token)).send({role: 'Manager'}).expect(200);
    await request(app).patch(`/api/workspaces/${workspace.id}/members/${manager.user.id}`).set(auth(manager.token)).send({role: 'Developer'}).expect(200);
    await request(app).patch(`/api/workspaces/${workspace.id}/members/${memberId}`).set(auth(memberUser.token)).send({role: 'Developer'}).expect(409);
    await request(app).delete(`/api/workspaces/${workspace.id}/members/${memberId}`).set(auth(memberUser.token)).expect(409);
    await request(app).post(`/api/workspaces/${workspace.id}/invite/regenerate`).set(auth(manager.token)).expect(410);
  });

  it('serves and runs the Linux CLI bundle in an isolated home', async () => {
    db = await openTestDb();
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-installer-'));
    const home = path.join(temporary, "home with ' quote");
    const cliDir = path.join(temporary, 'compiled-cli');
    const fakeBin = path.join(temporary, 'bin');
    fs.mkdirSync(home, {recursive: true});
    fs.mkdirSync(cliDir);
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(cliDir, 'index.js'), `#!/usr/bin/env node
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2), command=args.shift(), flag=n=>args[args.indexOf(n)+1]; const configPath=path.join(os.homedir(),'.tracemini','config.json');
if(command==='setup'){const response=await fetch(flag('--server')+'/api/agents/install/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({installToken:flag('--install-token'),machineName:'fixture-box'})});if(!response.ok)throw new Error(await response.text());const value=await response.json();fs.mkdirSync(path.dirname(configPath),{recursive:true});fs.writeFileSync(configPath,JSON.stringify({serverUrl:flag('--server'),agentToken:value.agentToken,workspaceId:value.workspaceId}));fs.mkdirSync(path.join(os.homedir(),'.config/systemd/user'),{recursive:true});fs.writeFileSync(path.join(os.homedir(),'.config/systemd/user/tracemini.service'),'fixture');execFileSync('systemctl',['--user','daemon-reload']);execFileSync('systemctl',['--user','enable','--now','tracemini.service']);console.log('installed');}
else if(command==='--help'){console.log('help');}
else if(command==='status'){console.log(JSON.stringify(JSON.parse(fs.readFileSync(configPath,'utf8'))));}
`);
    fs.writeFileSync(path.join(fakeBin, 'node'), `#!/bin/sh\nif [ "\${1:-}" = -p ]; then echo 22; else exec ${process.execPath} "$@"; fi\n`, {mode: 0o755});
    fs.writeFileSync(path.join(fakeBin, 'sudo'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HOME/sudo.log"\n`, {mode: 0o755});
    fs.writeFileSync(path.join(fakeBin, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HOME/systemctl.log"\n`, {mode: 0o755});
    const app = createApp(db, undefined, cliDir);
    const server = app.listen(0);
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
      const origin = `http://127.0.0.1:${address.port}`;
      const user = (await request(origin).post('/api/auth/register').send({name: 'Installer', email: 'installer@test.local', password: 'password123'}).expect(201)).body;
      const workspace = (await request(origin).post('/api/workspaces').set(auth(user.token)).send({name: 'Install'}).expect(201)).body;
      const installation = (await request(origin).post('/api/agents/installations').set(auth(user.token)).send({workspaceId: workspace.id}).expect(201)).body;
      expect(installation.installCommand).toContain('curl --fail');
      expect(installation.installCommand).not.toContain('| sh');
      const token = installToken(installation);
      const bundle = await request(origin).get(`/api/installers/linux/${encodeURIComponent(token)}`).expect(200).expect('content-type', /text\/x-shellscript/);
      const installerPath = path.join(temporary, 'install.sh');
      fs.writeFileSync(installerPath, bundle.text, {mode: 0o700});
      const env = {...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`};
      await execFileAsync('sh', [installerPath], {env});
      const wrapper = path.join(home, '.local/bin/tracemini');
      expect(fs.existsSync(wrapper)).toBe(true);
      expect(execFileSync(wrapper, ['status'], {env, encoding: 'utf8'})).toContain(origin);
      expect(fs.readFileSync(path.join(home, 'sudo.log'), 'utf8')).toContain('apt-get install -y poppler-utils tesseract-ocr');
      expect(fs.readFileSync(path.join(home, 'systemctl.log'), 'utf8')).toContain('--user enable --now tracemini.service');
      await request(origin).post('/api/agents/install/exchange').send({installToken: token, machineName: 'replay'}).expect(409);
      await request(origin).get(`/api/installers/linux/${encodeURIComponent(token)}`).expect(410);

      const upgrade = (await request(origin).post('/api/agents/installations').set(auth(user.token)).send({workspaceId: workspace.id}).expect(201)).body;
      const brokenCliDir = path.join(temporary, 'broken-cli');
      fs.mkdirSync(brokenCliDir);
      fs.writeFileSync(path.join(brokenCliDir, 'index.js'), `#!/usr/bin/env node
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const args=process.argv.slice(2),command=args.shift(),flag=n=>args[args.indexOf(n)+1];
if(command==='--help'){console.log('help');process.exit(0);}
if(command==='setup'){const configPath=path.join(os.homedir(),'.tracemini','config.json');const previous=JSON.parse(fs.readFileSync(configPath,'utf8'));const response=await fetch(flag('--server')+'/api/agents/install/exchange',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+previous.agentToken},body:JSON.stringify({installToken:flag('--install-token'),machineName:'fixture-box'})});const value=await response.json();fs.writeFileSync(configPath,JSON.stringify({...previous,agentToken:value.agentToken}));fs.writeFileSync(path.join(flag('--transaction-dir'),'credential-exchanged'),'');process.exit(1);}
`);
      const failedUpgrade = path.join(temporary, 'failed-upgrade.sh');
      fs.writeFileSync(failedUpgrade, linuxInstaller(brokenCliDir, origin, installToken(upgrade)), {mode: 0o700});
      await expect(execFileAsync('sh', [failedUpgrade], {env})).rejects.toThrow();
      expect(fs.readFileSync(path.join(home, '.local/share/tracemini/cli/index.js'), 'utf8')).toContain("else if(command==='status')");
      expect(execFileSync(wrapper, ['status'], {env, encoding: 'utf8'})).toContain(origin);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(temporary, {recursive: true, force: true});
    }
  });

  it('queues refresh and push work, exposes stats, archive and agent status', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const user = (await request(app).post('/api/auth/register').send({name: 'Ada', email: 'ada@test.local', password: 'password123'}).expect(201)).body;
    const bootstrap = (await request(app).get('/api/bootstrap').set(auth(user.token)).expect(200)).body;
    expect(bootstrap).toMatchObject({user: {id: user.user.id, name: 'Ada'}, workspaces: [{name: "Ada's workspace", role: 'Manager'}]});
    const workspace = (await request(app).post('/api/workspaces').set(auth(user.token)).send({name: 'Mini'}).expect(201)).body;
    const installation = (await request(app).post('/api/agents/installations').set(auth(user.token)).send({workspaceId: workspace.id}).expect(201)).body;
    const agent = (await request(app).post('/api/agents/install/exchange').send({installToken: installToken(installation), machineName: 'ada-box'}).expect(201)).body;
    const detectedDevices = (await request(app).get(`/api/workspaces/${workspace.id}/agents`).set(auth(user.token)).expect(200)).body;
    expect(detectedDevices).toContainEqual(expect.objectContaining({id: agent.agentId, user_id: user.user.id, machine_name: 'ada-box'}));
    const scan = (await request(app).post(`/api/workspaces/${workspace.id}/repository-scans`).set(auth(user.token)).send({agentId: agent.agentId}).expect(202)).body;
    expect((await request(app).get(`/api/workspaces/${workspace.id}/repository-scans/${scan.id}`).set(auth(user.token)).expect(200)).body).toMatchObject({id: scan.id, agent_id: agent.agentId, status: 'queued'});
    await request(app).post(`/api/agents/refresh-requests/${scan.id}/claim`).set(auth(agent.agentToken)).expect(200);
    await request(app).post(`/api/agents/refresh-requests/${scan.id}/complete`).set(auth(agent.agentToken)).send({repositoriesFound: 2}).expect(200);
    expect((await request(app).get(`/api/workspaces/${workspace.id}/repository-scans/${scan.id}`).set(auth(user.token)).expect(200)).body).toMatchObject({status: 'completed', repositories_found: 2});
    await request(app).post('/api/repositories/register').set(auth(agent.agentToken)).send({workspaceId: String(workspace.id), name: 'Project', remoteUrl: 'file:///tmp/remote.git', localKey: '/clone'}).expect(409);
    await approveRepository(app, user.token, agent.agentToken, workspace.id, {localKey: '/clone', name: 'Project', remoteUrl: 'file:///tmp/remote.git', branch: 'main'});
    await request(app).post('/api/repositories/register').set(auth(agent.agentToken)).send({workspaceId: String(workspace.id), name: 'Project', remoteUrl: 'file:///tmp/remote.git', localKey: '/clone'}).expect(409);
    const repo = (await request(app).post('/api/repositories/register').set(auth(agent.agentToken)).send({workspaceId: String(workspace.id), name: 'Project', remoteUrl: 'file:///tmp/remote.git', localKey: '/clone', branch: 'main', headSha: 'abc', remoteHeadSha: 'abc', identityFingerprint: testFingerprint}).expect(200)).body;
    const renamedRepo = (await request(app).post('/api/repositories/register').set(auth(agent.agentToken)).send({workspaceId: String(workspace.id), name: 'RemoteProject', remoteUrl: 'file:///tmp/remote.git', localKey: '/clone', branch: 'main', headSha: 'abc', remoteHeadSha: 'abc', identityFingerprint: testFingerprint}).expect(200)).body;
    expect(renamedRepo).toMatchObject({id: repo.id, name: 'RemoteProject'});
    await request(app).post('/api/agents/repository-candidates').set(auth(agent.agentToken)).send({repositories: [{localKey: '/legacy', name: 'Legacy', remoteUrl: 'file:///tmp/legacy.git', traced: false}]}).expect(200);
    const legacyCandidate = (await request(app).get(`/api/workspaces/${workspace.id}/repository-candidates`).set(auth(user.token)).expect(200)).body.find((candidate: any) => candidate.local_key === '/legacy');
    await request(app).patch(`/api/workspaces/${workspace.id}/repository-candidates/${legacyCandidate.id}`).set(auth(user.token)).send({traced: true}).expect(200);
    await request(app).post('/api/repositories/register').set(auth(agent.agentToken)).send({workspaceId: String(workspace.id), name: 'Legacy', remoteUrl: 'file:///tmp/legacy.git', localKey: '/legacy'}).expect(409);

    const pending = (await request(app).post('/api/pushes/pending').set(auth(agent.agentToken)).send({repositoryId: repo.id, localKey: '/clone', identityFingerprint: testFingerprint, eventKey: 'push-1', remoteName: 'origin', remoteUrl: 'file:///tmp/remote.git', ref: 'refs/heads/main', expectedSha: 'abc', occurredAt: new Date().toISOString()}).expect(201)).body;
    const sync = (await request(app).get('/api/agents/sync').set(auth(agent.agentToken)).expect(200)).body;
    expect(sync).toMatchObject({workspaceIds: expect.arrayContaining([workspace.id]), jobs: [], refreshRequests: [], repositorySelections: expect.arrayContaining([expect.objectContaining({id: legacyCandidate.id})]), pushes: [expect.objectContaining({id: pending.id})]});
    expect((await request(app).get('/api/agents/pushes').set(auth(agent.agentToken)).expect(200)).body[0].id).toBe(pending.id);
    expect((await request(app).post(`/api/agents/pushes/${pending.id}/complete`).set(auth(agent.agentToken)).send({status: 'unconfirmed', identityFingerprint: testFingerprint}).expect(200)).body.retrying).toBe(true);
    expect((await request(app).get('/api/agents/pushes').set(auth(agent.agentToken)).expect(200)).body).toEqual([]);
    await db.prepare("UPDATE pending_pushes SET attempts=2,next_check_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(pending.id);
    await request(app).post(`/api/agents/pushes/${pending.id}/complete`).set(auth(agent.agentToken)).send({status: 'confirmed', observedSha: 'abc', identityFingerprint: testFingerprint}).expect(200);

    await request(app).post('/api/activity').set(auth(agent.agentToken)).send({eventKey: 'commit-stat', repositoryId: repo.id, localKey: '/clone', identityFingerprint: testFingerprint, type: 'commit', occurredAt: '2026-08-21T10:00:00.000Z', data: {commitSha: 'abc', filesChanged: 3, insertions: 12, deletions: 4}}).expect(201);
    await request(app).post('/api/activity').set(auth(agent.agentToken)).send({eventKey: 'commit-stat-recovered', repositoryId: repo.id, localKey: '/clone', identityFingerprint: testFingerprint, type: 'commit', occurredAt: '2026-08-21T09:59:00.000Z', data: {commitSha: 'abc', filesChanged: 3, insertions: 12, deletions: 4, importedFromHistory: true}}).expect(200);
    await request(app).post('/api/activity').set(auth(agent.agentToken)).send({eventKey: 'stage-stat', repositoryId: repo.id, localKey: '/clone', identityFingerprint: testFingerprint, type: 'stage', occurredAt: '2026-08-21T11:00:00.000Z', data: {filesChanged: 99, insertions: 99, deletions: 99}}).expect(201);
    await request(app).post('/api/activity').set(auth(agent.agentToken)).send({eventKey: 'branch-fractional-offset', repositoryId: repo.id, localKey: '/clone', identityFingerprint: testFingerprint, type: 'branch', occurredAt: '2026-08-21T10:45:00.000Z', data: {}}).expect(201);
    await request(app).post('/api/activity').set(auth(agent.agentToken)).send({eventKey: 'rewrite-arbitrary-offset', repositoryId: repo.id, localKey: '/clone', identityFingerprint: testFingerprint, type: 'rewrite', occurredAt: '2026-08-21T10:40:00.000Z', data: {}}).expect(201);
    await request(app).post('/api/activity').set(auth(agent.agentToken)).send({eventKey: 'merge-stat', repositoryId: repo.id, localKey: '/clone', identityFingerprint: testFingerprint, type: 'merge', occurredAt: '2026-08-22T12:00:00.000Z', data: {}}).expect(201);
    const rangeDashboard = (await request(app).get(`/api/workspaces/${workspace.id}/dashboard?timezone=UTC&from=2026-08-21&to=2026-08-23`).set(auth(user.token)).expect(200)).body;
    expect(rangeDashboard.timeline).toMatchObject({from: '2026-08-21', to: '2026-08-23', granularity: 'day', users: [expect.objectContaining({userId: user.user.id, name: 'Ada'})]});
    expect(rangeDashboard.timeline.users[0].points).toHaveLength(3);
    expect(rangeDashboard.timeline.users[0].points.map((point: any) => ({label: point.label, total: point.total}))).toEqual([
      {label: '2026-08-21', total: 4},
      {label: '2026-08-22', total: 1},
      {label: '2026-08-23', total: 0},
    ]);
    expect(rangeDashboard.timeline.users[0].totals).toMatchObject({commit: 1, stage: 1, branch: 1, rewrite: 1, merge: 1});
    const fractionalTimeline = (await request(app).get(`/api/workspaces/${workspace.id}/timeline?timezone=UTC%2B05%3A30&from=2026-08-21&to=2026-08-21`).set(auth(user.token)).expect(200)).body;
    expect(fractionalTimeline.users[0].points[15].total).toBe(1);
    expect(fractionalTimeline.users[0].points[16].total).toBe(3);
    const arbitraryOffsetTimeline = (await request(app).get(`/api/workspaces/${workspace.id}/timeline?timezone=UTC%2B05%3A20&from=2026-08-21&to=2026-08-21`).set(auth(user.token)).expect(200)).body;
    expect(arbitraryOffsetTimeline.users[0].points[15].total).toBe(1);
    expect(arbitraryOffsetTimeline.users[0].points[16].total).toBe(3);
    const refreshedTimeline = (await request(app).get(`/api/workspaces/${workspace.id}/timeline?timezone=UTC&from=2026-08-21&to=2026-08-23`).set(auth(user.token)).expect(200)).body;
    expect(refreshedTimeline).toEqual(rangeDashboard.timeline);
    const stats = (await request(app).get(`/api/workspaces/${workspace.id}/stats`).set(auth(user.token)).expect(200)).body;
    expect(stats.totals).toEqual({commits: 1, filesChanged: 3, insertions: 12, deletions: 4});
    expect(stats.daily[0]).toMatchObject({date: '2026-08-21', commits: 1});
    const today = new Date().toISOString();
    await request(app).post('/api/activity').set(auth(agent.agentToken)).send({eventKey: 'commit-today', repositoryId: repo.id, localKey: '/clone', identityFingerprint: testFingerprint, type: 'commit', occurredAt: today, data: {filesChanged: 1, insertions: 2, deletions: 0, sourceCode: 'CANARY /opaque/QZ7M4N8891/source.ts', remoteUrl: 'file:///home/ada/private/project', diagnostic: 'EACCES: /home/ada/private/project'}}).expect(201);
    await db.prepare('UPDATE repositories SET name=?,remote_url=?,normalized_remote=? WHERE id=?').run('/opaque/QZ7M4N8891/private-project', '/home/ada/private/project', 'home/ada/private/project', repo.id);
    const dashboard = (await request(app).get(`/api/workspaces/${workspace.id}/dashboard?timezone=UTC`).set(auth(user.token)).expect(200)).body;
    expect(dashboard.stats.totals.commits).toBe(2);
    expect(dashboard.today).toMatchObject({date: today.slice(0, 10), users: [expect.objectContaining({userId: user.user.id, name: 'Ada', totals: expect.objectContaining({commit: 1, push: 1, pull: 0, stage: 0})})]});
    expect(dashboard.today.users[0].hourly).toHaveLength(24);
    expect(dashboard.today.users[0].hourly.reduce((sum: number, point: any) => sum + point.total, 0)).toBe(2);
    expect(dashboard.today.users[0].hourly.every((point: any) => point.total === point.commit + point.push + point.pull + point.stage + point.branch + point.merge + point.rewrite)).toBe(true);
    expect(dashboard.events).toHaveLength(7);
    expect(dashboard.events.every((event: any) => event.local_key === null)).toBe(true);
    expect(JSON.stringify(dashboard.events)).not.toContain('/home/ada');
    expect(JSON.stringify(dashboard.events)).not.toContain('/opaque/');
    expect(JSON.stringify(dashboard.events)).not.toContain('CANARY');
    expect(dashboard.repositories[0]).toMatchObject({id: repo.id, name: 'private-project', clone_count: 1, remote_url: null, normalized_remote: null});
    const selectedRepositoryDashboard = (await request(app).get(`/api/workspaces/${workspace.id}/dashboard?timezone=UTC&repositoryIds=${repo.id}`).set(auth(user.token)).expect(200)).body;
    expect(selectedRepositoryDashboard.events).toHaveLength(7);
    expect(selectedRepositoryDashboard.stats.totals.commits).toBe(2);
    const emptyRepositoryDashboard = (await request(app).get(`/api/workspaces/${workspace.id}/dashboard?timezone=UTC&repositoryIds=`).set(auth(user.token)).expect(200)).body;
    expect(emptyRepositoryDashboard.events).toEqual([]);
    expect(emptyRepositoryDashboard.stats.totals.commits).toBe(0);
    expect(emptyRepositoryDashboard.timeline.users[0].hourly.every((point: any) => point.total === 0)).toBe(true);
    const settings = (await request(app).get(`/api/workspaces/${workspace.id}/settings`).set(auth(user.token)).expect(200)).body;
    expect(settings).toMatchObject({members: [{id: user.user.id, role: 'Manager'}]});
    expect(settings.repositoryCandidates).toHaveLength(2);
    expect(settings.agents[0]).toMatchObject({id: agent.agentId, status: 'online'});

    await request(app).patch(`/api/workspaces/${workspace.id}/repositories/${repo.id}`).set(auth(user.token)).send({archived: true}).expect(200);
    expect((await request(app).get(`/api/workspaces/${workspace.id}/repositories?includeArchived=true`).set(auth(user.token))).body[0].archived).toBe(1);
    expect((await request(app).get(`/api/workspaces/${workspace.id}/agents`).set(auth(user.token)).expect(200)).body[0]).toMatchObject({machine_name: 'ada-box', status: 'online'});
    await request(app).delete(`/api/workspaces/${workspace.id}/agents/${agent.agentId}`).set(auth(user.token)).expect(409);
    await request(app).post(`/api/workspaces/${workspace.id}/agents/${agent.agentId}/revoke`).set(auth(user.token)).expect(200);
    await request(app).post('/api/agents/heartbeat').set(auth(agent.agentToken)).expect(401);
    expect((await request(app).get(`/api/workspaces/${workspace.id}/agents`).set(auth(user.token)).expect(200)).body[0]).toMatchObject({machine_name: 'ada-box', status: 'revoked'});
    await request(app).delete(`/api/workspaces/${workspace.id}/agents/${agent.agentId}`).set(auth(user.token)).expect(204);
    expect((await request(app).get(`/api/workspaces/${workspace.id}/agents`).set(auth(user.token)).expect(200)).body).toEqual([]);
    await request(app).delete(`/api/workspaces/${workspace.id}`).set(auth(user.token)).expect(204);
    expect((await request(app).get('/api/workspaces').set(auth(user.token)).expect(200)).body).toMatchObject([{name: "Ada's workspace", role: 'Manager'}]);
  });

  it('regenerates an owned report with a custom prompt and selected AI', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const user = (await request(app).post('/api/auth/register').send({name: 'Report Owner', email: 'report-owner@test.local', password: 'password123'}).expect(201)).body;
    const workspace = (await request(app).post('/api/workspaces').set(auth(user.token)).send({name: 'Reports'}).expect(201)).body;
    const installation = (await request(app).post('/api/agents/installations').set(auth(user.token)).send({workspaceId: workspace.id}).expect(201)).body;
    const agent = (await request(app).post('/api/agents/install/exchange').send({installToken: installToken(installation), machineName: 'report-box'}).expect(201)).body;
    await approveRepository(app, user.token, agent.agentToken, workspace.id, {localKey: '/product', name: 'Product', remoteUrl: 'file:///tmp/product.git'});
    const repository = (await request(app).post('/api/repositories/register').set(auth(agent.agentToken)).send({workspaceId: String(workspace.id), name: 'Product', remoteUrl: 'file:///tmp/product.git', localKey: '/product', identityFingerprint: testFingerprint}).expect(200)).body;
    await request(app).post('/api/activity').set(auth(agent.agentToken)).send({eventKey: 'report-evidence', repositoryId: repository.id, localKey: '/product', identityFingerprint: testFingerprint, type: 'commit', occurredAt: '2026-08-21T10:00:00.000Z', data: {message: 'Deliver reporting'}}).expect(201);

    const originalJob = (await request(app).post('/api/reports/jobs').set(auth(user.token)).send({workspaceId: String(workspace.id), startDate: '2026-08-21', endDate: '2026-08-21', reporter: 'codex', name: 'August Engineering Review'}).expect(201)).body;
    expect((await request(app).get(`/api/reports/jobs/${originalJob.id}`).set(auth(user.token)).expect(200)).body).toMatchObject({report_name: 'August Engineering Review'});
    await request(app).post(`/api/agents/jobs/${originalJob.id}/claim`).set(auth(agent.agentToken)).expect(200);
    await request(app).post(`/api/agents/jobs/${originalJob.id}/complete`).set(auth(agent.agentToken)).send({markdown: '   '}).expect(400);
    await request(app).post(`/api/agents/jobs/${originalJob.id}/complete`).set(auth(agent.agentToken)).send({markdown: '# Original'}).expect(201);
    const originalReport = (await request(app).get(`/api/workspaces/${workspace.id}/reports`).set(auth(user.token)).expect(200)).body[0];
    expect(originalReport).toMatchObject({name: 'August Engineering Review'});

    await request(app).post(`/api/reports/${originalReport.id}/regenerate`).set(auth(user.token)).send({reporter: 'hermes', prompt: ''}).expect(400);
    const regeneration = (await request(app).post(`/api/reports/${originalReport.id}/regenerate`).set(auth(user.token)).send({reporter: 'hermes', prompt: 'Lead with outcomes and group work by capability.'}).expect(201)).body;
    const queued = (await request(app).get('/api/agents/jobs').set(auth(agent.agentToken)).expect(200)).body[0];
    expect(queued).toMatchObject({id: regeneration.id, reporter: 'hermes', target_report_id: originalReport.id, custom_prompt: 'Lead with outcomes and group work by capability.'});
    await request(app).post(`/api/agents/jobs/${regeneration.id}/claim`).set(auth(agent.agentToken)).expect(200);
    const context = (await request(app).get(`/api/agents/jobs/${regeneration.id}/context`).set(auth(agent.agentToken)).expect(200)).body;
    expect(context.job).toMatchObject({target_report_id: originalReport.id, custom_prompt: 'Lead with outcomes and group work by capability.'});
    await request(app).post(`/api/agents/jobs/${regeneration.id}/complete`).set(auth(agent.agentToken)).send({markdown: '# Regenerated\n\nEngineering outcomes.'}).expect(201);
    await request(app).get(`/api/agents/jobs/${regeneration.id}/context`).set(auth(agent.agentToken)).expect(404);

    expect((await request(app).get(`/api/reports/${originalReport.id}`).set(auth(user.token)).expect(200)).body).toMatchObject({id: originalReport.id, job_id: regeneration.id, name: 'August Engineering Review', markdown: '# Regenerated\n\nEngineering outcomes.', report_scope: 'personal', user_name: 'Report Owner'});
    expect((await request(app).get(`/api/workspaces/${workspace.id}/reports`).set(auth(user.token)).expect(200)).body).toHaveLength(1);
    const workspaceJob = (await request(app).post('/api/reports/jobs').set(auth(user.token)).send({workspaceId: String(workspace.id), startDate: '2026-08-21', endDate: '2026-08-21', reporter: 'codex', reportScope: 'workspace'}).expect(201)).body;
    expect((await request(app).get(`/api/reports/jobs/${workspaceJob.id}`).set(auth(user.token)).expect(200)).body).toMatchObject({report_scope: 'workspace'});
    await db.prepare('DELETE FROM report_jobs WHERE id=?').run(workspaceJob.id);

    const manager = (await request(app).post('/api/auth/register').send({name: 'Report Manager', email: 'report-manager@test.local', password: 'password123'}).expect(201)).body;
    await inviteAndAccept(app, user.token, workspace.id, manager);
    await request(app).patch(`/api/reports/${originalReport.id}`).set(auth(manager.token)).send({name: 'Manager override'}).expect(404);
    await request(app).patch(`/api/reports/${originalReport.id}`).set(auth(user.token)).send({name: '   '}).expect(400);
    expect((await request(app).patch(`/api/reports/${originalReport.id}`).set(auth(user.token)).send({name: '  Platform Delivery Review  '}).expect(200)).body).toMatchObject({id: originalReport.id, name: 'Platform Delivery Review'});
    expect((await request(app).get(`/api/reports/${originalReport.id}`).set(auth(user.token)).expect(200)).body.name).toBe('Platform Delivery Review');

    await request(app).patch(`/api/workspaces/${workspace.id}/members/${manager.user.id}`).set(auth(user.token)).send({role: 'Manager'}).expect(200);
    await request(app).delete(`/api/workspaces/${workspace.id}/members/${user.user.id}`).set(auth(manager.token)).expect(204);
    await request(app).post(`/api/reports/${originalReport.id}/regenerate`).set(auth(user.token)).send({reporter: 'codex', prompt: 'Try again.'}).expect(403);
    await request(app).patch(`/api/reports/${originalReport.id}`).set(auth(user.token)).send({name: 'No longer allowed'}).expect(403);
  });

  it('completes report jobs queued before report naming was deployed', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const user = (await request(app).post('/api/auth/register').send({name: 'Legacy Report Owner', email: 'legacy-report@test.local', password: 'password123'}).expect(201)).body;
    const workspace = (await request(app).post('/api/workspaces').set(auth(user.token)).send({name: 'Legacy Reports'}).expect(201)).body;
    const installation = (await request(app).post('/api/agents/installations').set(auth(user.token)).send({workspaceId: workspace.id}).expect(201)).body;
    const agent = (await request(app).post('/api/agents/install/exchange').send({installToken: installToken(installation), machineName: 'legacy-report-box'}).expect(201)).body;
    const job = (await request(app).post('/api/reports/jobs').set(auth(user.token)).send({workspaceId: String(workspace.id), startDate: '2026-08-01', endDate: '2026-08-07', reporter: 'codex'}).expect(201)).body;

    await db.prepare('UPDATE report_jobs SET report_name=NULL WHERE id=?').run(job.id);
    await request(app).post(`/api/agents/jobs/${job.id}/claim`).set(auth(agent.agentToken)).expect(200);
    await request(app).post(`/api/agents/jobs/${job.id}/complete`).set(auth(agent.agentToken)).send({markdown: '# Legacy report'}).expect(201);

    const summary = (await request(app).get(`/api/workspaces/${workspace.id}/reports`).set(auth(user.token)).expect(200)).body[0];
    expect(summary).toMatchObject({name: 'Engineering contributions · 2026-08-01 — 2026-08-07'});
    expect(summary).not.toHaveProperty('markdown');
    expect((await request(app).get(`/api/reports/${summary.id}`).set(auth(user.token)).expect(200)).body)
      .toMatchObject({name: 'Engineering contributions · 2026-08-01 — 2026-08-07', markdown: '# Legacy report'});
  });

  it('allows only one concurrent push finalizer to publish the winning outcome', async () => {
    db = await openTestDb();
    const app = createApp(new SerializedTransactionsDb(db) as unknown as DB);
    const user = (await request(app).post('/api/auth/register').send({name: 'Push', email: 'push-race@test.local', password: 'password123'}).expect(201)).body;
    const workspace = (await request(app).post('/api/workspaces').set(auth(user.token)).send({name: 'Push Race'}).expect(201)).body;
    const installation = (await request(app).post('/api/agents/installations').set(auth(user.token)).send({workspaceId: workspace.id}).expect(201)).body;
    const agent = (await request(app).post('/api/agents/install/exchange').send({installToken: installToken(installation), machineName: 'push-box'}).expect(201)).body;
    await approveRepository(app, user.token, agent.agentToken, workspace.id, {localKey: '/race', name: 'Race', remoteUrl: 'file:///tmp/race.git'});
    const repository = (await request(app).post('/api/repositories/register').set(auth(agent.agentToken)).send({workspaceId: String(workspace.id), name: 'Race', remoteUrl: 'file:///tmp/race.git', localKey: '/race', identityFingerprint: testFingerprint}).expect(200)).body;
    const pending = (await request(app).post('/api/pushes/pending').set(auth(agent.agentToken)).send({repositoryId: repository.id, localKey: '/race', identityFingerprint: testFingerprint, eventKey: 'push-race', remoteName: 'origin', remoteUrl: 'file:///tmp/race.git', ref: 'refs/heads/main', expectedSha: 'expected', occurredAt: '2026-08-24T00:00:00.000Z'}).expect(201)).body;
    await db.prepare('UPDATE pending_pushes SET attempts=2 WHERE id=?').run(pending.id);

    const responses = await Promise.all([
      request(app).post(`/api/agents/pushes/${pending.id}/complete`).set(auth(agent.agentToken)).send({status: 'confirmed', observedSha: 'confirmed-sha', identityFingerprint: testFingerprint}),
      request(app).post(`/api/agents/pushes/${pending.id}/complete`).set(auth(agent.agentToken)).send({status: 'unconfirmed', observedSha: 'unconfirmed-sha', identityFingerprint: testFingerprint}),
    ]);

    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const push: any = await db.prepare('SELECT * FROM pending_pushes WHERE id=?').get(pending.id);
    const event: any = await db.prepare('SELECT * FROM activity_events WHERE event_key=?').get('push-race');
    const eventData = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    expect(eventData).toMatchObject({confirmation: push.status, observedSha: push.observed_sha});
  });

  it('rejects a privileged member mutation when manager authority becomes stale', async () => {
    db = await openTestDb();
    const setupApp = createApp(db);
    const register = async (name: string) => (await request(setupApp).post('/api/auth/register').send({name, email: `${name}@manager-race.test`, password: 'password123'}).expect(201)).body;
    const actor = await register('stale-manager');
    const backup = await register('backup-manager');
    const target = await register('promotion-target');
    const workspace = (await request(setupApp).post('/api/workspaces').set(auth(actor.token)).send({name: 'Authority Race'}).expect(201)).body;
    for (const user of [backup, target]) await inviteAndAccept(setupApp, actor.token, workspace.id, user);
    await request(setupApp).patch(`/api/workspaces/${workspace.id}/members/${backup.user.id}`).set(auth(actor.token)).send({role: 'Manager'}).expect(200);

    const gated = new ManagerPreflightGateDb(db);
    const app = createApp(gated as unknown as DB);
    const responsePromise = request(app).patch(`/api/workspaces/${workspace.id}/members/${target.user.id}`).set(auth(actor.token)).send({role: 'Manager'}).then(response => response);
    await gated.reached;
    await db.prepare("UPDATE workspace_members SET role='Developer' WHERE workspace_id=? AND user_id=?").run(workspace.id, actor.user.id);
    gated.release();

    const response = await responsePromise;
    expect(response.status).toBe(403);
    expect((await db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspace.id, target.user.id) as any).role).toBe('Developer');
  });

  it('keeps lifecycle authority and target selection inside workspace transactions', async () => {
    db = await openTestDb();
    const recording = new TransactionRecordingDb(db);
    const app = createApp(recording as unknown as DB);
    const register = async (name: string) => (await request(app).post('/api/auth/register').send({name, email: `${name}@locks.test`, password: 'password123'}).expect(201)).body;
    const manager = await register('locking-manager');
    const member = await register('locking-member');
    const workspace = (await request(app).post('/api/workspaces').set(auth(manager.token)).send({name: 'Locked'}).expect(201)).body;
    await inviteAndAccept(app, manager.token, workspace.id, member);
    const installation = (await request(app).post('/api/agents/installations').set(auth(member.token)).send({workspaceId: workspace.id}).expect(201)).body;

    recording.reset();
    const exchanged = (await request(app).post('/api/agents/install/exchange').send({installToken: installToken(installation), machineName: 'locked-box'}).expect(201)).body;
    const exchangeSql = recording.calls.filter(call => call.inTransaction).map(call => call.sql);
    expect(exchangeSql.findIndex(sql => sql === 'SELECT id FROM workspaces WHERE id=? FOR UPDATE')).toBeLessThan(exchangeSql.findIndex(sql => sql.includes('FROM setup_codes') && sql.includes('FOR UPDATE')));
    expect(exchangeSql).toContain('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?');

    recording.reset();
    await request(app).patch(`/api/workspaces/${workspace.id}/members/${member.user.id}`).set(auth(manager.token)).send({role: 'Manager'}).expect(200);
    expect(recording.calls).toContainEqual({sql: "SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='Manager'", inTransaction: true});

    await request(app).post('/api/agents/repository-candidates').set(auth(exchanged.agentToken)).send({repositories: [{localKey: '/work/locked-repo', name: 'locked-repo', remoteUrl: 'https://github.com/team/locked-repo.git', branch: 'main', traced: false, identityFingerprint: testFingerprint}]}).expect(200);
    const candidate = (await request(app).get(`/api/workspaces/${workspace.id}/repository-candidates`).set(auth(member.token)).expect(200)).body[0];
    await request(app).patch(`/api/workspaces/${workspace.id}/repository-candidates/${candidate.id}`).set(auth(member.token)).send({traced: true}).expect(200);
    recording.reset();
    await request(app).post('/api/repositories/register').set(auth(exchanged.agentToken)).send({workspaceId: String(workspace.id), name: 'locked-repo', remoteUrl: 'https://github.com/team/locked-repo.git', localKey: '/work/locked-repo', identityFingerprint: testFingerprint}).expect(200);
    const registrationSql = recording.calls.filter(call => call.inTransaction).map(call => call.sql);
    expect(registrationSql.findIndex(sql => sql === 'SELECT id FROM workspaces WHERE id=? FOR UPDATE')).toBeLessThan(registrationSql.findIndex(sql => sql === 'SELECT * FROM agents WHERE id=? FOR UPDATE'));

    recording.reset();
    await request(app).post(`/api/workspaces/${workspace.id}/agents/${exchanged.agentId}/revoke`).set(auth(manager.token)).expect(404);
    await request(app).post(`/api/workspaces/${workspace.id}/agents/${exchanged.agentId}/revoke`).set(auth(member.token)).expect(200);
    const revokeSql = recording.calls.filter(call => call.inTransaction).map(call => call.sql);
    expect(recording.calls).toContainEqual({sql: 'SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?', inTransaction: true});

    recording.reset();
    await request(app).delete(`/api/workspaces/${workspace.id}/members/${member.user.id}`).set(auth(manager.token)).expect(204);
    expect(recording.calls).toContainEqual({sql: "SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='Manager'", inTransaction: true});

    recording.reset();
    await request(app).delete(`/api/workspaces/${workspace.id}`).set(auth(manager.token)).expect(204);
    expect(recording.calls).toContainEqual({sql: "SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='Manager'", inTransaction: true});
  });

  it('keeps one account device online across workspaces and removes only departed workspace work', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const createUser = async (name: string) => (await request(app).post('/api/auth/register').send({name, email: `${name}@isolation.test`, password: 'password123'}).expect(201)).body;
    const member = await createUser('account-device-member');
    const manager = await createUser('account-device-manager');
    const workspaceA = (await request(app).post('/api/workspaces').set(auth(member.token)).send({name: 'Workspace A'}).expect(201)).body;
    const workspaceB = (await request(app).post('/api/workspaces').set(auth(member.token)).send({name: 'Workspace B'}).expect(201)).body;
    await inviteAndAccept(app, member.token, workspaceA.id, manager);
    await request(app).patch(`/api/workspaces/${workspaceA.id}/members/${manager.user.id}`).set(auth(member.token)).send({role: 'Manager'}).expect(200);

    const installation = (await request(app).post('/api/agents/installations').set(auth(member.token)).send({workspaceId: workspaceA.id}).expect(201)).body;
    const agent = (await request(app).post('/api/agents/install/exchange').send({installToken: installToken(installation), machineName: 'account-box'}).expect(201)).body;
    expect((await request(app).get(`/api/workspaces/${workspaceA.id}/agents`).set(auth(member.token)).expect(200)).body).toHaveLength(1);
    expect((await request(app).get(`/api/workspaces/${workspaceB.id}/agents`).set(auth(member.token)).expect(200)).body).toHaveLength(1);

    const repositories: any[] = [];
    const sharedLocalKey = '/shared-working-tree';
    for (const workspace of [workspaceA, workspaceB]) {
      await request(app).post('/api/agents/repository-candidates').set(auth(agent.agentToken)).send({workspaceId: workspace.id, repositories: [{localKey: sharedLocalKey, name: workspace.name, remoteUrl: `file:///tmp/workspace-${workspace.id}.git`, traced: false, identityFingerprint: testFingerprint}]}).expect(200);
      const candidates = (await request(app).get(`/api/workspaces/${workspace.id}/repository-candidates`).set(auth(member.token)).expect(200)).body;
      expect(candidates).toEqual([
        expect.objectContaining({local_key: sharedLocalKey, machine_name: 'account-box'}),
      ]);
      await request(app).patch(`/api/workspaces/${workspace.id}/repository-candidates/${candidates[0].id}`).set(auth(member.token)).send({traced: true}).expect(200);
      const repository = (await request(app).post('/api/repositories/register').set(auth(agent.agentToken)).send({workspaceId: String(workspace.id), localKey: sharedLocalKey, name: workspace.name, remoteUrl: `file:///tmp/workspace-${workspace.id}.git`, identityFingerprint: testFingerprint}).expect(200)).body;
      repositories.push(repository);
      await request(app).post('/api/activity').set(auth(agent.agentToken)).send({eventKey: `before-${workspace.id}`, repositoryId: repository.id, localKey: sharedLocalKey, identityFingerprint: testFingerprint, type: 'commit', occurredAt: new Date().toISOString()}).expect(201);
    }
    expect((await db.prepare('SELECT COUNT(*)::INTEGER count FROM local_clones WHERE agent_id=? AND local_key=?').get(agent.agentId, sharedLocalKey) as any).count).toBe(2);
    expect((await db.prepare('SELECT COUNT(*)::INTEGER count FROM activity_events WHERE agent_id=?').get(agent.agentId) as any).count).toBe(2);
    expect((await db.prepare('SELECT COUNT(*)::INTEGER count FROM activity_event_repositories').get() as any).count).toBe(4);
    expect((await request(app).get(`/api/workspaces/${workspaceA.id}/dashboard`).set(auth(member.token)).expect(200)).body.events).toHaveLength(2);
    expect((await request(app).get(`/api/workspaces/${workspaceB.id}/dashboard`).set(auth(member.token)).expect(200)).body.events).toHaveLength(2);

    const jobA = (await request(app).post('/api/reports/jobs').set(auth(member.token)).send({workspaceId: String(workspaceA.id), startDate: '2026-08-21', endDate: '2026-08-21', reporter: 'codex'}).expect(201)).body;
    const jobB = (await request(app).post('/api/reports/jobs').set(auth(member.token)).send({workspaceId: String(workspaceB.id), startDate: '2026-08-21', endDate: '2026-08-21', reporter: 'codex'}).expect(201)).body;

    await request(app).delete(`/api/workspaces/${workspaceA.id}/members/${member.user.id}`).set(auth(manager.token)).expect(204);
    const statusAfterRemoval = (await request(app).get('/api/agents/status').set(auth(agent.agentToken)).expect(200)).body;
    expect(statusAfterRemoval.workspaceId).not.toBe(workspaceA.id);
    expect(await db.prepare('SELECT workspace_id FROM agents WHERE id=?').get(agent.agentId)).toMatchObject({workspace_id: statusAfterRemoval.workspaceId});
    const workspaceIds = (await request(app).post('/api/agents/heartbeat').set(auth(agent.agentToken)).expect(200)).body.workspaceIds;
    expect(workspaceIds).toContain(statusAfterRemoval.workspaceId);
    expect(workspaceIds).toContain(workspaceB.id);
    expect(workspaceIds).not.toContain(workspaceA.id);
    await request(app).post('/api/activity').set(auth(agent.agentToken)).send({eventKey: 'after-a', repositoryId: repositories[0].id, localKey: sharedLocalKey, identityFingerprint: testFingerprint, type: 'commit', occurredAt: new Date().toISOString()}).expect(403);
    await request(app).post('/api/activity').set(auth(agent.agentToken)).send({eventKey: 'after-b', repositoryId: repositories[1].id, localKey: sharedLocalKey, identityFingerprint: testFingerprint, type: 'commit', occurredAt: new Date().toISOString()}).expect(201);
    await request(app).post(`/api/agents/jobs/${jobA.id}/claim`).set(auth(agent.agentToken)).expect(409);
    await request(app).post(`/api/agents/jobs/${jobB.id}/claim`).set(auth(agent.agentToken)).expect(200);
    expect(await db.prepare('SELECT status,error FROM report_jobs WHERE id=?').get(jobA.id)).toMatchObject({status: 'failed', error: 'workspace membership removed'});
    await request(app).get(`/api/reports/jobs/${jobA.id}`).set(auth(member.token)).expect(404);
    expect((await request(app).get(`/api/workspaces/${workspaceB.id}/repository-candidates`).set(auth(member.token)).expect(200)).body).toEqual([
      expect.objectContaining({local_key: sharedLocalKey}),
    ]);
    expect((await db.prepare('SELECT COUNT(*)::INTEGER count FROM local_clones WHERE agent_id=? AND local_key=?').get(agent.agentId, sharedLocalKey) as any).count).toBe(1);
  });

  it('lets a user select which repositories their device should trace', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const user = (await request(app).post('/api/auth/register').send({name: 'Repo owner', email: 'repos@test.local', password: 'password123'}).expect(201)).body;
    const workspace = (await request(app).post('/api/workspaces').set(auth(user.token)).send({name: 'Repository selection'}).expect(201)).body;
    const installation = (await request(app).post('/api/agents/installations').set(auth(user.token)).send({workspaceId: workspace.id}).expect(201)).body;
    const device = (await request(app).post('/api/agents/install/exchange').send({installToken: installToken(installation), machineName: 'repo-box'}).expect(201)).body;

    await request(app).post('/api/agents/repository-candidates').set(auth(device.agentToken)).send({repositories: [
      {localKey: '/home/user/app', name: 'app', remoteUrl: 'git@github.com:user/app.git', branch: 'main', traced: false, identityFingerprint: 'a'.repeat(64)},
      {localKey: '/home/user/api', name: 'api', remoteUrl: 'git@github.com:user/api.git', branch: 'main', traced: true},
    ]}).expect(200);

    const candidates = (await request(app).get(`/api/workspaces/${workspace.id}/repository-candidates`).set(auth(user.token)).expect(200)).body;
    expect(candidates).toHaveLength(2);
    expect(candidates.find((repo: any) => repo.name === 'app')).toMatchObject({machine_name: 'repo-box', traced: false, desired_traced: false});

    const appCandidate = candidates.find((repo: any) => repo.name === 'app');
    await request(app).patch(`/api/workspaces/${workspace.id}/repository-candidates/${appCandidate.id}`).set(auth(user.token)).send({traced: true}).expect(200);
    await request(app).post('/api/agents/repository-candidates').set(auth(device.agentToken)).send({repositories: [
      {localKey: '/home/user/app', name: 'app', remoteUrl: 'git@github.com:user/app.git', branch: 'main', traced: false, identityFingerprint: 'a'.repeat(64)},
    ]}).expect(200);
    const selections = (await request(app).get('/api/agents/repository-selections').set(auth(device.agentToken)).expect(200)).body;
    expect(selections).toEqual(expect.arrayContaining([
      expect.objectContaining({id: appCandidate.id, local_key: '/home/user/app', desired_traced: true}),
      expect.objectContaining({local_key: '/home/user/api', traced: true, desired_traced: false}),
    ]));
    const appSelection = selections.find((selection: any) => selection.id === appCandidate.id);
    await request(app).post(`/api/agents/repository-selections/${appCandidate.id}/claim`).set(auth(device.agentToken)).send({revision: appSelection.revision, desiredTraced: true}).expect(200);
    const repository = (await request(app).post('/api/repositories/register').set(auth(device.agentToken)).send({workspaceId: String(workspace.id), name: 'app', remoteUrl: 'git@github.com:user/app.git', localKey: '/home/user/app', branch: 'main', identityFingerprint: 'a'.repeat(64)}).expect(200)).body;
    await request(app).post(`/api/agents/repository-selections/${appCandidate.id}/complete`).set(auth(device.agentToken)).send({traced: true, desiredTraced: true, revision: appSelection.revision}).expect(200);
    expect((await request(app).get('/api/agents/repository-selections').set(auth(device.agentToken)).expect(200)).body).toEqual([expect.objectContaining({local_key: '/home/user/api', desired_traced: false})]);

    await request(app).post('/api/activity').set(auth(device.agentToken)).send({eventKey: 'selected-event', repositoryId: repository.id, localKey: '/home/user/app', identityFingerprint: 'a'.repeat(64), type: 'commit', occurredAt: new Date().toISOString()}).expect(201);
    await request(app).post('/api/activity').set(auth(device.agentToken)).send({eventKey: 'wrong-physical-clone', repositoryId: repository.id, localKey: '/home/user/app', identityFingerprint: 'b'.repeat(64), type: 'commit', occurredAt: new Date().toISOString()}).expect(403);
    const selectedPush = (await request(app).post('/api/pushes/pending').set(auth(device.agentToken)).send({repositoryId: repository.id, localKey: '/home/user/app', identityFingerprint: 'a'.repeat(64), eventKey: 'selected-push', remoteName: 'origin', remoteUrl: 'git@github.com:user/app.git', ref: 'refs/heads/main', expectedSha: 'abc', occurredAt: new Date().toISOString()}).expect(201)).body;
    await request(app).post(`/api/agents/pushes/${selectedPush.id}/complete`).set(auth(device.agentToken)).send({status: 'confirmed', observedSha: 'abc', identityFingerprint: 'b'.repeat(64)}).expect(409);
    expect((await db.prepare('SELECT status FROM pending_pushes WHERE id=?').get(selectedPush.id) as any).status).toBe('pending');
    expect(await db.prepare('SELECT 1 FROM activity_events WHERE event_key=?').get('selected-push')).toBeUndefined();
    await db.prepare('UPDATE repository_candidates SET repository_fingerprint=? WHERE id=?').run('b'.repeat(64), appCandidate.id);
    await request(app).post(`/api/agents/pushes/${selectedPush.id}/complete`).set(auth(device.agentToken)).send({status: 'confirmed', observedSha: 'abc', identityFingerprint: 'a'.repeat(64)}).expect(409);
    expect((await db.prepare('SELECT status FROM pending_pushes WHERE id=?').get(selectedPush.id) as any).status).toBe('pending');
    await db.prepare('UPDATE repository_candidates SET repository_fingerprint=? WHERE id=?').run('a'.repeat(64), appCandidate.id);
    const deselection = await request(app).patch(`/api/workspaces/${workspace.id}/repository-candidates/${appCandidate.id}`).set(auth(user.token)).send({traced: false}).expect(200);
    expect((await request(app).get('/api/agents/pushes').set(auth(device.agentToken)).expect(200)).body).toEqual([]);
    await request(app).post(`/api/agents/repository-selections/${appCandidate.id}/complete`).set(auth(device.agentToken)).send({traced: true, desiredTraced: true, revision: appSelection.revision}).expect(409);
    await request(app).post('/api/activity').set(auth(device.agentToken)).send({eventKey: 'deselected-event', repositoryId: repository.id, localKey: '/home/user/app', type: 'commit', occurredAt: new Date().toISOString()}).expect(403);
    await request(app).patch(`/api/workspaces/${workspace.id}/repository-candidates/${appCandidate.id}`).set(auth(user.token)).send({traced: true}).expect(200);
    await request(app).post(`/api/agents/repository-selections/${appCandidate.id}/complete`).set(auth(device.agentToken)).send({traced: false, desiredTraced: false, revision: deselection.body.revision}).expect(409);
    expect((await request(app).get('/api/agents/repository-selections').set(auth(device.agentToken)).expect(200)).body).toEqual(expect.arrayContaining([expect.objectContaining({id: appCandidate.id, traced: false, desired_traced: true})]));
    await request(app).post('/api/agents/repository-candidates').set(auth(device.agentToken)).send({repositories: [
      {localKey: '/home/user/app', name: 'replacement', remoteUrl: 'git@github.com:user/replacement.git', branch: 'main', traced: false, identityFingerprint: 'b'.repeat(64), identityChanged: true},
    ]}).expect(200);
    const replaced = (await request(app).get(`/api/workspaces/${workspace.id}/repository-candidates`).set(auth(user.token)).expect(200)).body.find((candidate: any) => candidate.id === appCandidate.id);
    expect(replaced).toMatchObject({traced: false, desired_traced: false, repository_id: null});
    await request(app).post('/api/activity').set(auth(device.agentToken)).send({eventKey: 'replacement-event', repositoryId: repository.id, localKey: '/home/user/app', type: 'commit', occurredAt: new Date().toISOString()}).expect(403);
  });
});
