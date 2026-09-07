import {afterEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import type {DB} from '../apps/server/src/db.js';
import {openTestDb} from '../apps/server/src/test-db.js';
import {createApp} from '../apps/server/src/app.js';
import {nextScheduledRun} from '../apps/server/src/report-schedule.js';

let db: DB;
afterEach(async () => { if (db) await db.close(); db = undefined as unknown as DB; });
const auth = (token: string) => ({authorization: `Bearer ${token}`});

async function register(app: any, name: string) {
  return (await request(app).post('/api/auth/register').send({name, email: `${name}@example.test`, password: 'password123'}).expect(201)).body;
}

describe('workspace invitation inbox', () => {
  it('grants no access before the targeted recipient explicitly accepts', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const manager = await register(app, 'manager');
    const recipient = await register(app, 'recipient');
    const outsider = await register(app, 'outsider');
    const workspaceId = manager.workspaceId;

    const created = (await request(app)
      .post(`/api/workspaces/${workspaceId}/invitations`)
      .set(auth(manager.token))
      .send({email: 'recipient@example.test', role: 'Developer'})
      .expect(201)).body;

    expect((await request(app).get(`/api/workspaces/${workspaceId}/members`).set(auth(manager.token)).expect(200)).body)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({email: 'recipient@example.test'})]));
    expect((await request(app).get('/api/invitations').set(auth(recipient.token)).expect(200)).body)
      .toEqual([expect.objectContaining({id: created.id, status: 'PENDING', role: 'Developer', workspace_name: "manager's workspace"})]);
    await request(app).post(`/api/invitations/${created.id}/accept`).set(auth(outsider.token)).expect(404);

    await request(app).post(`/api/invitations/${created.id}/accept`).set(auth(recipient.token)).expect(200);
    expect((await request(app).get(`/api/workspaces/${workspaceId}/members`).set(auth(manager.token)).expect(200)).body)
      .toEqual(expect.arrayContaining([expect.objectContaining({email: 'recipient@example.test', role: 'Developer'})]));
    await request(app).post(`/api/invitations/${created.id}/accept`).set(auth(recipient.token)).expect(409);
  });
});

describe('workspace repository proposals', () => {
  it('lets each Developer select their own repositories while Managers receive redacted metadata', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const manager = await register(app, 'repository-manager');
    const developer = await register(app, 'repository-developer');
    const workspaceId = manager.workspaceId;
    const invitation = (await request(app).post(`/api/workspaces/${workspaceId}/invitations`).set(auth(manager.token)).send({email: developer.user.email, role: 'Developer'}).expect(201)).body;
    await request(app).post(`/api/invitations/${invitation.id}/accept`).set(auth(developer.token)).expect(200);
    const managerAgent = (await request(app).post('/api/agents/register').set(auth(manager.token)).send({machineName: 'manager-box'}).expect(201)).body;
    const agent = (await request(app).post('/api/agents/register').set(auth(developer.token)).send({machineName: 'developer-box'}).expect(201)).body;

    await request(app).post('/api/agents/repository-candidates').set(auth(managerAgent.token)).send({workspaceId, repositories: [{localKey: '/projects/manager', name: 'manager-repo', remoteUrl: 'git@example.test:team/manager.git', branch: 'main', traced: false, identityFingerprint: 'c'.repeat(64)}]}).expect(200);
    await request(app).post('/api/agents/repository-candidates').set(auth(agent.token)).send({workspaceId, repositories: [{localKey: '/projects/shared', name: 'shared', remoteUrl: 'git@example.test:team/shared.git', branch: 'main', traced: false, identityFingerprint: 'a'.repeat(64)}]}).expect(200);
    const managerCandidates = (await request(app).get(`/api/workspaces/${workspaceId}/repository-candidates`).set(auth(manager.token)).expect(200)).body;
    expect(managerCandidates.map((candidate: any) => candidate.name)).toEqual(['manager-repo', 'shared']);
    expect(managerCandidates[1]).toMatchObject({name: 'shared', machine_name: 'developer-box', desired_traced: false, local_key: null});
    expect((await request(app).get(`/api/workspaces/${workspaceId}/repository-candidates`).set(auth(developer.token)).expect(200)).body)
      .toEqual([expect.objectContaining({name: 'shared', local_key: '/projects/shared'})]);
    const candidateId = managerCandidates[1].id;
    await request(app).patch(`/api/workspaces/${workspaceId}/repository-candidates/${candidateId}`).set(auth(manager.token)).send({traced: true}).expect(404);
    await request(app).patch(`/api/workspaces/${workspaceId}/repository-candidates/${candidateId}`).set(auth(developer.token)).send({traced: true}).expect(200);
    await request(app).post('/api/repositories/register').set(auth(agent.token)).send({workspaceId: String(workspaceId), localKey: '/projects/shared', name: 'different', remoteUrl: 'https://example.test/team/different.git', identityFingerprint: 'a'.repeat(64)}).expect(409);
    await request(app).post('/api/agents/repository-candidates').set(auth(agent.token)).send({workspaceId, repositories: [{localKey: '/projects/shared', name: 'different', remoteUrl: 'https://example.test/team/different.git', branch: 'main', traced: false, identityFingerprint: 'a'.repeat(64)}]}).expect(200);
    expect((await request(app).get(`/api/workspaces/${workspaceId}/repository-candidates`).set(auth(manager.token)).expect(200)).body.find((item: any) => item.name === 'different').desired_traced).toBe(false);
    await request(app).post('/api/agents/repository-candidates').set(auth(agent.token)).send({workspaceId, repositories: [{localKey: '/projects/private', name: 'private', remoteUrl: 'local-device-7:/home/repository-developer/private/repo', branch: 'main', traced: false, identityFingerprint: 'b'.repeat(64)}]}).expect(200);
    await db.prepare("UPDATE repository_candidates SET remote_url=?,normalized_remote=?,error=? WHERE workspace_id=? AND name='private'").run('C:\\Users\\repository-developer\\private\\repo', 'c//users/repository-developer/private/repo', 'EACCES: C:\\Users\\repository-developer\\private\\repo', workspaceId);
    const privateForManager = (await request(app).get(`/api/workspaces/${workspaceId}/repository-candidates`).set(auth(manager.token)).expect(200)).body.find((item: any) => item.name === 'private');
    expect(privateForManager).toMatchObject({local_key: null, normalized_remote: null, error: 'Repository update failed on member device'});
    const privateForDeveloper = (await request(app).get(`/api/workspaces/${workspaceId}/repository-candidates`).set(auth(developer.token)).expect(200)).body.find((item: any) => item.name === 'private');
    expect(privateForDeveloper.error).toContain('C:\\Users\\repository-developer');

    const scan = (await request(app).post(`/api/workspaces/${workspaceId}/repository-scans`).set(auth(developer.token)).send({agentId: agent.agentId}).expect(202)).body;
    expect(scan).toMatchObject({status: 'queued', agentId: agent.agentId});
    const queued = (await request(app).get('/api/agents/refresh-requests').set(auth(agent.token)).expect(200)).body;
    expect(queued).toEqual([expect.objectContaining({id: scan.id, workspace_id: workspaceId, status: 'queued'})]);
    await request(app).post(`/api/agents/refresh-requests/${scan.id}/claim`).set(auth(agent.token)).expect(200);
    await request(app).post(`/api/agents/refresh-requests/${scan.id}/complete`).set(auth(agent.token)).send({repositoriesFound: 1}).expect(200);
  });
});

describe('workspace report schedules', () => {
  it('calculates the next selected weekday at local wall-clock time', () => {
    expect(nextScheduledRun({frequency: 'SELECTED_DAYS', selectedDays: [1, 5], localTime: '09:30', timezone: 'UTC'}, new Date('2026-08-27T12:00:00.000Z')).toISOString())
      .toBe('2026-08-28T09:30:00.000Z');
    expect(nextScheduledRun({frequency: 'DAILY', selectedDays: [], localTime: '09:30', timezone: 'UTC+01:00'}, new Date('2026-08-27T12:00:00.000Z')).toISOString())
      .toBe('2026-08-28T08:30:00.000Z');
  });

  it('moves a schedule on a skipped local calendar day to the first valid instant', () => {
    expect(nextScheduledRun({frequency: 'DAILY', selectedDays: [], localTime: '00:00', timezone: 'Pacific/Apia'}, new Date('2011-12-29T12:00:00.000Z')).toISOString()).toBe('2011-12-30T10:00:00.000Z');
  });

  it('lets Managers configure a schedule and materializes one idempotent workspace report job', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const manager = await register(app, 'scheduler');
    const workspaceId = manager.workspaceId;

    const rule = {enabled: true, frequency: 'DAILY', selectedDays: [], localTime: '00:00', timezone: 'UTC', reporter: 'hermes', format: 'summary', includeDiff: false, notifySlack: true, windowDays: 7};
    const schedule = (await request(app)
      .put(`/api/workspaces/${workspaceId}/report-schedule`)
      .set(auth(manager.token))
      .send({...rule, name: 'Daily delivery'})
      .expect(200)).body;
    expect(schedule).toMatchObject({workspace_id: workspaceId, name: 'Daily delivery', format: 'summary', frequency: 'DAILY', local_time: '00:00', notify_slack: true});
    const firstMissedDate = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const dueAt = `${firstMissedDate}T00:00:00.000Z`;
    await db.prepare('UPDATE report_schedules SET next_run_at=? WHERE id=?').run(dueAt, schedule.id);
    const renamedSchedule = (await request(app)
      .put(`/api/workspaces/${workspaceId}/report-schedule`)
      .set(auth(manager.token))
      .send({...rule, name: 'Leadership delivery brief'})
      .expect(200)).body;
    expect(renamedSchedule).toMatchObject({id: schedule.id, name: 'Leadership delivery brief', next_run_at: dueAt});

    const agent = (await request(app).post('/api/agents/register').set(auth(manager.token)).send({machineName: 'manager-box'}).expect(201)).body;
    const firstList = (await request(app).get('/api/agents/jobs').set(auth(agent.token)).expect(200)).body;
    const repeatedList = (await request(app).get('/api/agents/jobs').set(auth(agent.token)).expect(200)).body;
    expect(firstList).toHaveLength(1);
    expect(repeatedList[0].id).toBe(firstList[0].id);
    await request(app).post(`/api/agents/jobs/${firstList[0].id}/claim`).set(auth(agent.token)).expect(200);
    const jobs = await db.prepare('SELECT * FROM report_jobs WHERE schedule_id=? ORDER BY id').all(schedule.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({report_name: expect.stringContaining('Leadership delivery brief'), format: 'summary', report_scope: 'workspace', status: 'running', notify_slack: true, coalesced_runs: 3});
    expect(jobs[0].end_date.toISOString().slice(0, 10)).toBe(new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
    expect(firstList[0].id).toBe(jobs[0].id);

    const backup = await register(app, 'schedule-backup');
    const invitation = (await request(app).post(`/api/workspaces/${workspaceId}/invitations`).set(auth(manager.token)).send({email: backup.user.email, role: 'Manager'}).expect(201)).body;
    await request(app).post(`/api/invitations/${invitation.id}/accept`).set(auth(backup.token)).expect(200);
    await request(app).patch(`/api/workspaces/${workspaceId}/members/${manager.user.id}`).set(auth(backup.token)).send({role: 'Developer'}).expect(200);
    expect(await db.prepare('SELECT status,error FROM report_jobs WHERE id=?').get(firstList[0].id)).toMatchObject({status: 'failed', error: 'Manager authorization revoked'});
    await request(app).get(`/api/agents/jobs/${firstList[0].id}/context`).set(auth(agent.token)).expect(404);
    await request(app).post(`/api/agents/jobs/${firstList[0].id}/complete`).set(auth(agent.token)).send({markdown: '# stale'}).expect(409);
    await db.prepare('UPDATE report_schedules SET enabled=TRUE,next_run_at=? WHERE id=?').run(`${firstMissedDate}T00:00:00.000Z`, schedule.id);
    expect((await request(app).get('/api/agents/jobs').set(auth(agent.token)).expect(200)).body).toEqual([]);
    await request(app).delete(`/api/workspaces/${workspaceId}/report-schedule`).set(auth(backup.token)).expect(200);
    expect((await request(app).get(`/api/workspaces/${workspaceId}/report-schedule`).set(auth(backup.token)).expect(200)).body).toBeNull();
    expect(await db.prepare('SELECT schedule_id FROM report_jobs WHERE id=?').get(firstList[0].id)).toMatchObject({schedule_id: null});
  });
});
