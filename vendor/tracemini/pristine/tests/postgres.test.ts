import {describe, expect, it} from 'vitest';

// PostgreSQL is the server's only application database. This test deliberately
// exercises the same schema migration entrypoint against an in-memory Postgres
// implementation so unit tests never mutate the hosted Supabase project.
describe('PostgreSQL database', () => {
  it('converts parameters without rewriting SQL literals or comments', async () => {
    const {postgresSql} = await import('../apps/server/src/db.js');
    expect(postgresSql("SELECT '?' literal, ? value -- ? comment\n/* ? */"))
      .toBe("SELECT '?' literal, $1 value -- ? comment\n/* ? */");
    expect(postgresSql('SELECT $$?$$ literal, ? value')).toBe('SELECT $$?$$ literal, $1 value');
  });

  it('uses the bundled Supabase CA with certificate and hostname verification', async () => {
    const {normalizePostgresConnectionString, postgresPoolConfig} = await import('../apps/server/src/db.js');
    const connectionString =
      'postgresql://postgres.example:***@pooler.supabase.com:5432/postgres?sslmode=require';
    const normalized = new URL(normalizePostgresConnectionString(connectionString));
    const config = postgresPoolConfig(connectionString);
    expect(normalized.searchParams.has('sslmode')).toBe(false);
    expect(config.ssl).toMatchObject({rejectUnauthorized: true});
    expect(config.max).toBe(3);
    const previousVercel = process.env.VERCEL;
    process.env.VERCEL = '1';
    try {
      const serverlessConfig = postgresPoolConfig(connectionString);
      expect(serverlessConfig.max).toBe(2);
      expect(new URL(serverlessConfig.connectionString!).port).toBe('6543');
      expect(serverlessConfig.options).toBeUndefined();
      expect(serverlessConfig.idleTimeoutMillis).toBe(30_000);
    } finally {
      if (previousVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previousVercel;
    }
    expect((config.ssl as {ca: string}).ca).toContain('BEGIN CERTIFICATE');
  });

  it('opens a migrated Postgres database with the TraceMini schema', async () => {
    const {openTestDb} = await import('../apps/server/src/test-db.js');
    const db = await openTestDb();
    try {
      const migrations = await db.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version');
      expect(migrations.rows.map((row: any) => row.version)).toEqual([1, 3, 4, 5, 6, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
      for (const migration of migrations.rows) expect(migration.checksum).toMatch(/^[a-f0-9]{64}$/);
      const reportJobColumns = await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='report_jobs'");
      expect(reportJobColumns.rows.map((row: any) => row.column_name)).toEqual(expect.arrayContaining(['custom_prompt', 'target_report_id', 'report_name', 'format', 'report_scope', 'schedule_id', 'scheduled_for', 'coalesced_runs', 'notify_slack']));
      const reportColumns = await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='reports'");
      expect(reportColumns.rows.map((row: any) => row.column_name)).toEqual(expect.arrayContaining(['name', 'format', 'report_scope', 'schedule_id', 'scheduled_for', 'coalesced_runs']));
      const scheduleColumns = await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='report_schedules'");
      expect(scheduleColumns.rows.map((row: any) => row.column_name)).toContain('name');
      const agentColumns = await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='agents'");
      expect(agentColumns.rows.map((row: any) => row.column_name)).toEqual(expect.arrayContaining(['removed_at', 'installation_id']));
      const candidateWorkspace = await db.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='repository_candidates' AND column_name='workspace_id'");
      expect(candidateWorkspace.rows).toEqual([{is_nullable: 'NO'}]);
      const tables = await db.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
      );
      expect(tables.rows.map((row: any) => row.table_name)).toEqual(expect.arrayContaining([
        'users',
        'workspaces',
        'workspace_members',
        'workspace_invitations',
        'agents',
        'repositories',
        'activity_events',
        'activity_event_repositories',
        'report_jobs',
        'reports',
        'report_schedules',
        'repository_candidates',
      ]));
    } finally {
      await db.close();
    }
  });

  it('replaces legacy account aliases in profiles, default workspaces, and stored reports', async () => {
    const {DataType, newDb} = await import('pg-mem');
    const {canonicalEngineerNamesMigrationSql} = await import('../apps/server/src/db.js');
    const memory = newDb();
    memory.public.registerFunction({
      name: 'replace',
      args: [DataType.text, DataType.text, DataType.text],
      returns: DataType.text,
      implementation: (value: string, search: string, replacement: string) => value.split(search).join(replacement),
    });
    memory.public.none(`
      CREATE TABLE users(id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE workspaces(id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE reports(id BIGSERIAL PRIMARY KEY,markdown TEXT NOT NULL);
      INSERT INTO users(name) VALUES('UwU'),('Jerry');
      INSERT INTO workspaces(name) VALUES('UwU''s workspace'),('Jerry''s workspace'),('Jerry project');
      INSERT INTO reports(markdown) VALUES('# UwU\n\nWorked with Jerry.');
    `);
    memory.public.none(canonicalEngineerNamesMigrationSql);
    expect(memory.public.many('SELECT name FROM users ORDER BY id')).toEqual([{name: 'Ashar'}, {name: 'Ibrahim'}]);
    expect(memory.public.many('SELECT name FROM workspaces ORDER BY id')).toEqual([
      {name: "Ashar's workspace"}, {name: "Ibrahim's workspace"}, {name: 'Jerry project'},
    ]);
    expect(memory.public.one('SELECT markdown FROM reports')).toEqual({markdown: '# Ashar\n\nWorked with Ibrahim.'});
  });

  it('upgrades legacy Member rows to Developer without losing workspace access', async () => {
    const {newDb} = await import('pg-mem');
    const {invitationInboxMigrationSql} = await import('../apps/server/src/db.js');
    const memory = newDb();
    memory.public.none(`
      CREATE TABLE users(id BIGSERIAL PRIMARY KEY,name TEXT,email TEXT,password_hash TEXT,created_at TIMESTAMPTZ);
      CREATE TABLE workspaces(id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,owner_id BIGINT REFERENCES users(id),invite_enabled BOOLEAN NOT NULL DEFAULT TRUE);
      CREATE TABLE workspace_members(workspace_id BIGINT REFERENCES workspaces(id),user_id BIGINT REFERENCES users(id),role TEXT CONSTRAINT workspace_members_role_check CHECK(role IN ('Manager','Member')),PRIMARY KEY(workspace_id,user_id));
      INSERT INTO users(id,name,email,password_hash,created_at) VALUES(1,'Legacy','legacy@example.test','hash',NOW());
      INSERT INTO workspaces(id,name,owner_id) VALUES(1,'Legacy workspace',1);
      INSERT INTO workspace_members VALUES(1,1,'Member');
    `);
    memory.public.none(invitationInboxMigrationSql);
    expect(memory.public.one('SELECT role FROM workspace_members WHERE workspace_id=1 AND user_id=1')).toEqual({role: 'Developer'});
    expect(() => memory.public.none("UPDATE workspace_members SET role='Member' WHERE workspace_id=1 AND user_id=1")).toThrow();
  });

  it('makes legacy candidate workspace scope mandatory in migration 16', async () => {
    const {accountDeviceMigrationSql} = await import('../apps/server/src/db.js');
    expect(accountDeviceMigrationSql).toContain('DELETE FROM repository_candidates WHERE workspace_id IS NULL');
    expect(accountDeviceMigrationSql).toContain('ALTER COLUMN workspace_id SET NOT NULL');
  });


});
