import {afterEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import type {DB} from '../apps/server/src/db.js';
import {openTestDb} from '../apps/server/src/test-db.js';
import {createApp} from '../apps/server/src/app.js';

let db: DB;
afterEach(async () => db && await db.close());
const authorization = (token: string) => ({authorization: ['Bearer', token].join(' ')});

describe('report date API contract', () => {
  it('returns PostgreSQL DATE values as YYYY-MM-DD strings', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const user = (await request(app).post('/api/auth/register').send({name: 'Reporter', email: 'reporter@example.test', password: 'password123'}).expect(201)).body;
    const workspace = (await request(app).post('/api/workspaces').set(authorization(user.token)).send({name: 'Reports'}).expect(201)).body;
    const agent = (await request(app).post('/api/agents/register').set(authorization(user.token)).send({machineName: 'reporter-box'}).expect(201)).body;
    await request(app).post('/api/agents/workspace').set(authorization(agent.token)).send({workspaceId: String(workspace.id)}).expect(200);
    for (const [startDate, endDate] of [['0001-01-01', '2026-08-24'], ['2026-08-24', '9999-12-31']]) {
      await request(app).post('/api/reports/jobs').set(authorization(user.token)).send({workspaceId: String(workspace.id), startDate, endDate, reporter: 'hermes'}).expect(400);
    }
    const job = (await request(app).post('/api/reports/jobs').set(authorization(user.token)).send({workspaceId: String(workspace.id), startDate: '2026-08-18', endDate: '2026-08-24', reporter: 'hermes'}).expect(201)).body;
    await request(app).post(`/api/agents/jobs/${job.id}/claim`).set(authorization(agent.token)).send({}).expect(200);
    await request(app).post(`/api/agents/jobs/${job.id}/complete`).set(authorization(agent.token)).send({markdown: '# Weekly report'}).expect(201);

    const history = (await request(app).get(`/api/workspaces/${workspace.id}/reports`).set(authorization(user.token)).expect(200)).body;
    expect(history[0]).toMatchObject({start_date: '2026-08-18', end_date: '2026-08-24'});
    expect(history[0]).not.toHaveProperty('markdown');
    const detail = (await request(app).get(`/api/reports/${history[0].id}`).set(authorization(user.token)).expect(200)).body;
    expect(detail).toMatchObject({start_date: '2026-08-18', end_date: '2026-08-24'});
    expect(detail.markdown).toBe('# Weekly report');
  });
});
