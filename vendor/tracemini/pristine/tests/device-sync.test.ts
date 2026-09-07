import {afterEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp, requestOrigin} from '../apps/server/src/app.js';
import {openTestDb} from '../apps/server/src/test-db.js';
import type {DB} from '../apps/server/src/db.js';

const authorization = (token: string) => ({authorization: `Bearer ${token}`});
const tokenFrom = (command: string) => decodeURIComponent(command.match(/--install-token\s+'([^']+)'/)?.[1] || command.match(/\/api\/installers\/linux\/([^']+)/)?.[1] || '');

let db: DB;
afterEach(async () => {
  await db?.close();
  db = undefined as unknown as DB;
});

describe('existing CLI device sync', () => {
  it('generates HTTPS installer origins when hosted behind Vercel', () => {
    const request = {protocol: 'http', get: () => 'tracemini.vercel.app'} as any;
    expect(requestOrigin(request, true)).toBe('https://tracemini.vercel.app');
    expect(requestOrigin(request, false)).toBe('http://tracemini.vercel.app');
  });
  it('generates a sync command and securely replaces the old device credential', async () => {
    db = await openTestDb();
    const app = createApp(db);

    const oldAccount = (await request(app).post('/api/auth/register').send({
      name: 'Old account', email: 'old-device@example.test', password: 'password123',
    }).expect(201)).body;
    const oldWorkspace = (await request(app).get('/api/workspaces').set(authorization(oldAccount.token)).expect(200)).body[0];
    const oldDevice = (await request(app).post('/api/agents/register').set(authorization(oldAccount.token)).send({machineName: 'existing-laptop'}).expect(201)).body;
    await request(app).post('/api/agents/workspace').set(authorization(oldDevice.token)).send({workspaceId: String(oldWorkspace.id)}).expect(200);

    const newAccount = (await request(app).post('/api/auth/register').send({
      name: 'New account', email: 'new-device@example.test', password: 'password123',
    }).expect(201)).body;
    const newWorkspace = (await request(app).get('/api/workspaces').set(authorization(newAccount.token)).expect(200)).body[0];
    const installation = (await request(app).post('/api/agents/installations').set(authorization(newAccount.token)).send({workspaceId: newWorkspace.id}).expect(201)).body;

    expect(installation.syncCommand).toContain('curl --fail');
    expect(installation.syncCommand).not.toContain('| sh');
    expect(installation.syncCommand).toBe(installation.installCommand);
    const setupToken = tokenFrom(installation.syncCommand);
    expect(setupToken).not.toBe('');

    const synced = (await request(app)
      .post('/api/agents/install/exchange')
      .set(authorization(oldDevice.token))
      .send({installToken: setupToken, machineName: 'existing-laptop'})
      .expect(201)).body;

    await request(app).get('/api/agents/status').set(authorization(oldDevice.token)).expect(401);
    expect((await request(app).get('/api/agents/status').set(authorization(synced.agentToken)).expect(200)).body)
      .toMatchObject({id: synced.agentId, workspaceId: newWorkspace.id, machineName: 'existing-laptop'});
  });

  it('removes a newly created device when fresh setup is aborted', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const account = (await request(app).post('/api/auth/register').send({
      name: 'Cancelled install', email: 'cancelled-install@example.test', password: 'password123',
    }).expect(201)).body;
    const workspace = (await request(app).get('/api/workspaces').set(authorization(account.token)).expect(200)).body[0];
    const installation = (await request(app).post('/api/agents/installations').set(authorization(account.token)).send({workspaceId: workspace.id}).expect(201)).body;
    const installed = (await request(app).post('/api/agents/install/exchange').send({
      installToken: tokenFrom(installation.installCommand), machineName: 'cancelled-box', installationId: 'a'.repeat(64),
    }).expect(201)).body;
    expect(installed.created).toBe(true);

    await request(app).post('/api/agents/install/abort').set(authorization(installed.agentToken)).expect(204);
    await request(app).get('/api/agents/status').set(authorization(installed.agentToken)).expect(401);
    const devices = (await request(app).get(`/api/workspaces/${workspace.id}/agents`).set(authorization(account.token)).expect(200)).body;
    expect(devices).toHaveLength(0);
  });

});
