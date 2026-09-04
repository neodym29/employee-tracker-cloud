import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { readFileSync } from 'node:fs';

const { Client } = pg;
const migration = readFileSync(new URL('../migrations/019_embedded_tracemini.sql', import.meta.url), 'utf8');
const compatibility = readFileSync(new URL('../migrations/018_project_git_link_and_tracemini_evidence.sql', import.meta.url), 'utf8');

test('Postgres embedded schema rejects direct evidence UPDATE/DELETE and cascades project data', async (t) => {
  const name = `embedded-tracemini-${process.pid}-${Date.now()}`;
  let id;
  try {
    id = execFileSync('docker', ['run','-d','--rm','-e','POSTGRES_PASSWORD=test','-e','POSTGRES_DB=test','-P','postgres:16-alpine'], { encoding: 'utf8' }).trim();
  } catch (error) { t.skip(`Docker unavailable: ${error.message}`); return; }
  t.after(() => { try { execFileSync('docker', ['rm','-f',id]); } catch {} });
  let port;
  for (let attempt=0; attempt<40; attempt++) { try { port=execFileSync('docker',['port',id,'5432/tcp'],{encoding:'utf8'}).trim().split(':').pop(); const probe=new Client({host:'127.0.0.1',port:Number(port),user:'postgres',password:'test',database:'test'}); await probe.connect(); await probe.end(); break; } catch { await new Promise((resolve)=>setTimeout(resolve,250)); } }
  assert.ok(port, 'Postgres container did not become ready');
  const client = new Client({ host:'127.0.0.1', port:Number(port), user:'postgres', password:'test', database:'test' }); await client.connect();
  try {
    await client.query(`create table projects(id bigint primary key); create table app_users(id bigint primary key); create table files_agent_devices(id bigint primary key); create table project_agent_actions(id bigint primary key); insert into projects values(1); insert into app_users values(1); insert into files_agent_devices values(1); insert into project_agent_actions values(1);`);
    await client.query(compatibility);
    await client.query(migration);
    await client.query(`insert into project_tracemini_evidence(project_id,evidence_key,config_generation,config_revision,repository_id,repository_key,newest_occurred_at,proposed_action_id) values(1,repeat('a',64),1,1,'repo','github.com/acme/repo',now(),1)`);
    await assert.rejects(client.query(`update project_tracemini_evidence set repository_id='other' where project_id=1`), /immutable/);
    await assert.rejects(client.query(`delete from project_tracemini_evidence where project_id=1`), /immutable/);
    await client.query(`insert into project_tracemini_binding_codes(project_id,requested_for_user_id,code_hash,root_label,expires_at,issued_by) values(1,1,repeat('b',64),'repo',now()+interval '5 minutes',1)`);
    await client.query(`delete from projects where id=1`);
    assert.equal((await client.query(`select count(*) from project_tracemini_evidence`)).rows[0].count, '0');
    assert.equal((await client.query(`select count(*) from project_tracemini_binding_codes`)).rows[0].count, '0');
  } finally { await client.end(); }
});

test('Postgres embedded schema supports fresh and legacy upgrade shapes with required constraints', async (t) => {
  const name = `embedded-tracemini-upgrade-${process.pid}-${Date.now()}`;
  let id;
  try { id = execFileSync('docker', ['run','-d','--rm','-e','POSTGRES_PASSWORD=test','-e','POSTGRES_DB=test','-P','postgres:16-alpine'], { encoding: 'utf8' }).trim(); }
  catch (error) { t.skip(`Docker unavailable: ${error.message}`); return; }
  t.after(() => { try { execFileSync('docker', ['rm','-f',id]); } catch {} });
  let port;
  for (let attempt=0; attempt<40; attempt++) { try { port=execFileSync('docker',['port',id,'5432/tcp'],{encoding:'utf8'}).trim().split(':').pop(); const probe=new Client({host:'127.0.0.1',port:Number(port),user:'postgres',password:'test',database:'test'}); await probe.connect(); await probe.end(); break; } catch { await new Promise((resolve)=>setTimeout(resolve,250)); } }
  assert.ok(port);
  const client = new Client({ host:'127.0.0.1', port:Number(port), user:'postgres', password:'test', database:'test' }); await client.connect();
  try {
    await client.query(`create table projects(id bigint primary key); create table app_users(id bigint primary key); create table files_agent_devices(id bigint primary key); create table project_agent_actions(id bigint primary key); insert into projects values(1); insert into app_users values(1); insert into files_agent_devices values(1); insert into project_agent_actions values(1);`);
    await client.query(compatibility);
    await client.query(`create table project_tracemini_binding_codes(id bigserial primary key, project_id bigint not null references projects(id), device_id bigint references files_agent_devices(id), code_hash text not null unique, root_label text not null, expires_at timestamptz not null, used_at timestamptz, issued_by bigint not null references app_users(id), created_at timestamptz not null default now()); create table project_tracemini_reports(id bigserial primary key, project_id bigint not null references projects(id), requested_by bigint not null references app_users(id), scope text not null, reporter text not null, name text not null, format text not null default 'summary', start_date date not null, end_date date not null); create table project_tracemini_schedules(id bigserial primary key, project_id bigint not null references projects(id), configured_by bigint not null references app_users(id), name text not null, frequency text not null, local_time text not null, timezone text not null, selected_days jsonb not null default '[]', reporter text not null, format text not null);`);
    try { await client.query(migration); } catch (error) { console.error('migration debug', error.position, error.message); throw error; }
    const checks = await client.query(`select conname from pg_constraint where conrelid='project_tracemini_reports'::regclass and conname like '%format%'`);
    assert.ok(checks.rows.length, 'report format check must exist');
    await assert.rejects(client.query(`insert into project_tracemini_reports(project_id,requested_by,scope,reporter,name,format,start_date,end_date) values(1,1,'personal','codex','x','summary',current_date,current_date)`), /check|violates/i);
    const cols = await client.query(`select column_name from information_schema.columns where table_name='project_tracemini_binding_codes'`);
    assert.ok(!cols.rows.some((row) => row.column_name === 'device_id'), 'legacy device-bound code column must be removed');
    const triggers = await client.query(`select tgname from pg_trigger where tgrelid='project_tracemini_evidence'::regclass and not tgisinternal`);
    assert.equal(triggers.rows.filter((row) => row.tgname === 'prevent_project_tracemini_evidence_update').length, 1, 'one evidence trigger operation');
  } finally { await client.end(); }
});
