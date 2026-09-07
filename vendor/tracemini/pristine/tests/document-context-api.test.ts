import {afterEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../apps/server/src/app.js';
import {openTestDb} from '../apps/server/src/test-db.js';
import {decodeReportContext, decodeScheduleDays} from '../apps/server/src/document-context.js';
import {materializeDueReportSchedules} from '../apps/server/src/report-schedule.js';
import type {DB} from '../apps/server/src/db.js';

const auth = (token: string) => ({authorization: `Bearer ${token}`});
let db: DB;
afterEach(async () => { await db?.close(); db = undefined as unknown as DB; });

const documentContext = [{
  displayName: 'Plan.pdf', format: 'pdf', mediaType: 'application/pdf', byteSize: 1200, pageOrSlideCount: 2,
  consentedAt: '2026-09-02T10:00:00.000Z', metadata: {title: 'Plan', shortSummary: 'Release context.', keyPoints: [], decisions: [], actionItems: [], projects: [], people: [], relevantDates: [], warnings: []},
}];

describe('document context API without schema changes', () => {
  it('stores manual metadata in the existing custom_prompt field', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const account = (await request(app).post('/api/auth/register').send({name: 'Docs', email: 'docs@example.test', password: 'password123'}).expect(201)).body;
    const workspace = (await request(app).get('/api/workspaces').set(auth(account.token)).expect(200)).body[0];
    const job = (await request(app).post('/api/reports/jobs').set(auth(account.token)).send({workspaceId: String(workspace.id), startDate: '2026-09-01', endDate: '2026-09-01', reporter: 'codex', documentContext}).expect(201)).body;
    const row: any = await db.prepare('SELECT custom_prompt FROM report_jobs WHERE id=?').get(job.id);
    expect(decodeReportContext(row.custom_prompt).documents).toEqual(documentContext);
    const migrations: any[] = await db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    expect(Math.max(...migrations.map(item => Number(item.version)))).toBe(23);
  });

  it('rejects document bytes, extracted text, and local paths at the hosted API boundary', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const account = (await request(app).post('/api/auth/register').send({name: 'Privacy', email: 'privacy@example.test', password: 'password123'}).expect(201)).body;
    const workspace = (await request(app).get('/api/workspaces').set(auth(account.token)).expect(200)).body[0];
    for (const unsafe of [
      {...documentContext[0], documentBytes: 'JVBERi0='},
      {...documentContext[0], extractedText: 'raw private document text'},
      {...documentContext[0], displayName: '/home/privacy/Plan.pdf'},
    ]) await request(app).post('/api/reports/jobs').set(auth(account.token)).send({workspaceId: String(workspace.id), startDate: '2026-09-01', endDate: '2026-09-01', reporter: 'codex', documentContext: [unsafe]}).expect(422);
    expect(await db.prepare('SELECT COUNT(*) count FROM report_jobs').get()).toMatchObject({count: 0});
  });

  it('stores scheduled metadata in selected_days and copies it into a due job', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const account = (await request(app).post('/api/auth/register').send({name: 'Schedule docs', email: 'schedule-docs@example.test', password: 'password123'}).expect(201)).body;
    const workspace = (await request(app).get('/api/workspaces').set(auth(account.token)).expect(200)).body[0];
    const schedule = (await request(app).put(`/api/workspaces/${workspace.id}/report-schedule`).set(auth(account.token)).send({name: 'Context schedule', enabled: true, frequency: 'DAILY', selectedDays: [], localTime: '09:00', timezone: 'UTC', reporter: 'codex', format: 'summary', includeDiff: false, notifySlack: false, windowDays: 1, documentContext}).expect(200)).body;
    expect(schedule).toMatchObject({selected_days: [], document_context: documentContext});
    const stored: any = await db.prepare('SELECT selected_days FROM report_schedules WHERE id=?').get(schedule.id);
    expect(decodeScheduleDays(stored.selected_days).documents).toEqual(documentContext);
    await db.prepare('UPDATE report_schedules SET next_run_at=? WHERE id=?').run('2026-09-02T09:00:00.000Z', schedule.id);
    await materializeDueReportSchedules(db, account.user.id, new Date('2026-09-02T10:00:00.000Z'));
    const job: any = await db.prepare('SELECT custom_prompt FROM report_jobs WHERE schedule_id=?').get(schedule.id);
    expect(decodeReportContext(job.custom_prompt).documents).toEqual(documentContext);
  });
});
