import {afterEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../apps/server/src/app.js';
import {openTestDb} from '../apps/server/src/test-db.js';
import type {DB} from '../apps/server/src/db.js';

const authorization = (token: string) => ({authorization: `Bearer ${token}`});
let db: DB;
afterEach(async () => { await db?.close(); db = undefined as unknown as DB; });

describe('persistent report progress', () => {
  it('recovers the active job and prevents duplicate generation', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const account = (await request(app).post('/api/auth/register').send({
      name: 'Report user', email: 'active-report@example.test', password: 'password123',
    }).expect(201)).body;
    const workspace = (await request(app).get('/api/workspaces').set(authorization(account.token)).expect(200)).body[0];
    const payload = {workspaceId: String(workspace.id), startDate: '2026-08-01', endDate: '2026-08-24', reporter: 'codex'};

    const first = (await request(app).post('/api/reports/jobs').set(authorization(account.token)).send(payload).expect(201)).body;
    const duplicate = (await request(app).post('/api/reports/jobs').set(authorization(account.token)).send(payload).expect(200)).body;
    expect(duplicate).toMatchObject({id: first.id, status: 'pending'});

    const recovered = (await request(app).get(`/api/workspaces/${workspace.id}/report-jobs/active`).set(authorization(account.token)).expect(200)).body;
    expect(recovered).toMatchObject({id: first.id, status: 'pending'});

    await db.prepare("UPDATE report_jobs SET status='completed',completed_at=? WHERE id=?").run(new Date().toISOString(), first.id);
    expect((await request(app).get(`/api/workspaces/${workspace.id}/report-jobs/active`).set(authorization(account.token)).expect(200)).body).toBeNull();
  });
});
