import express, {type NextFunction, type Request, type Response} from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {DB} from './db.js';
import {linuxInstallCommand, linuxInstaller, linuxSyncCommand} from './linux-installer.js';
import {activityBucketMinutes, dateKeyInTimezone, dateRangeUtc, hourInTimezone, normalizeTimezone} from './timezone.js';
import {materializeDueReportSchedules, nextScheduledRun, normalizeReportFormat, validateScheduleRule} from './report-schedule.js';
import {sendSlackReport} from './slack.js';
import {decodeReportContext, decodeScheduleDays, encodeReportContext, encodeScheduleDays, validateDocumentContext} from './document-context.js';

const now = () => new Date().toISOString();
const expired = (value: string | Date) => new Date(value).getTime() <= Date.now();
const eventData = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value;
const isoDate = (value: string | Date) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Date(value).toISOString().slice(0, 10);
const defaultReportName = (startDate: string | Date, endDate: string | Date) => `Engineering contributions · ${isoDate(startDate)} — ${isoDate(endDate)}`;
const reportOutput = (row: any) => ({...row, start_date: isoDate(row.start_date), end_date: isoDate(row.end_date)});
const instant = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};
const dateOnly = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 1970 || year > 9998) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(24).toString('base64url');
const uniqueViolationText = (error: any) => `${error?.constraint || ''} ${error?.detail || ''} ${error?.message || ''}`;
const inviteCodeCollision = (error: any) => error?.code === '23505' && /invite_code|workspaces_invite_code_key/i.test(uniqueViolationText(error));
const emailCollision = (error: any) => error?.code === '23505' && /users_email_key|users.*email|email.*users/i.test(uniqueViolationText(error));

export function normalizeRemote(value: string) {
  let normalized = value.trim().replace(/\\/g, '/').replace(/\.git\/?$/i, '').replace(/\/$/, '');
  const scp = normalized.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp && !normalized.includes('://')) normalized = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const url = new URL(normalized);
      normalized = url.protocol === 'file:' ? `file://${url.pathname}` : `${url.hostname}${url.pathname}`;
    } catch {}
  }
  return normalized.replace(/^\/+/, '').toLowerCase();
}

const isPrivateLocalIdentity = (value: unknown) => {
  const normalized = String(value || '').toLowerCase();
  return normalized.startsWith('file:')
    || normalized.startsWith('local/')
    || /^local-device-\d+\//.test(normalized)
    || /^[a-z]\/\//.test(normalized);
};
const isRawLocalRemote = (value: unknown) => /^(?:[\\/]|[a-z]:[\\/]|file:|local(?:-device-\d+)?:)/i.test(String(value || '').trim());

const redactLocalPathsInString = (value: string) => value
  .replace(/(?:file:\/\/\/|local(?:-device-\d+)?:\/+|local-device-\d+\/\/)[^\s"'<>]+/gi, '[private local path]')
  .replace(/\\\\[^\s"'<>]+/g, '[private local path]')
  .replace(/(^|[\s"'(=:])\/[^\s"'<>]+/g, '$1[private local path]')
  .replace(/(^|[\s"'(=:])[a-z]:[\\/][^\s"'<>]+/gi, '$1[private local path]');

const safeRepositoryName = (value: unknown) => {
  const parts = String(value || 'repository').trim().split(/[\\/]+/).filter(Boolean);
  return (parts.at(-1) || 'repository').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) || 'repository';
};
const crossMemberEvidenceKeys = new Set(['commitSha', 'message', 'filesChanged', 'insertions', 'deletions', 'branch', 'headSha', 'remoteHeadSha', 'headAction', 'stagedFiles', 'files', 'remote', 'remoteUrl', 'ref', 'expectedSha', 'observedSha', 'confirmation']);

const redactCrossMemberEvidence = (value: any): any => {
  if (Array.isArray(value)) return value.slice(0, 500).map(redactCrossMemberEvidence);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => crossMemberEvidenceKeys.has(key))
    .map(([key, entry]) => {
      if (/^remoteUrl$/i.test(key) && typeof entry === 'string' && (isPrivateLocalIdentity(normalizeRemote(entry)) || isRawLocalRemote(entry))) return [key, null];
      return [key, redactCrossMemberEvidence(entry)];
    }));
  return typeof value === 'string' ? redactLocalPathsInString(value).slice(0, 2_000) : value;
};

type Authed = Request & {user?: any; agent?: any};
const required = (keys: string[]) => (req: Request, res: Response, next: NextFunction) => {
  for (const key of keys) {
    if (typeof req.body?.[key] !== 'string' || !req.body[key].trim()) {
      return res.status(400).json({error: `${key} is required`});
    }
  }
  next();
};

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultCliDir = path.resolve(moduleDirectory, '../../../packages/cli/dist');

export function requestOrigin(req: Request, hosted = Boolean(process.env.VERCEL)) {
  return `${hosted ? 'https' : req.protocol}://${req.get('host')}`;
}

export function createApp(db: DB, webDir?: string, cliDir = defaultCliDir, slackNotifier = sendSlackReport) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({limit: '512kb'}));

  const userAuth = async (req: Authed, res: Response, next: NextFunction) => {
    const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const row = raw && await db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id AND u.auth_version=s.auth_version WHERE s.token_hash=?').get(hash(raw));
    if (!row) return res.status(401).json({error: 'unauthorized'});
    req.user = row;
    next();
  };
  const agentAuth = async (req: Authed, res: Response, next: NextFunction) => {
    const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const row: any = raw && await db.prepare("SELECT a.*,u.name user_name FROM agents a JOIN users u ON u.id=a.user_id WHERE a.token_hash=? AND a.revoked_at IS NULL").get(hash(raw));
    if (!row) return res.status(401).json({error: 'unauthorized device'});
    req.agent = row;
    await db.prepare('UPDATE agents SET last_seen=? WHERE id=?').run(now(), row.id);
    next();
  };
  const membership = async (userId: number, workspaceId: number) => await db.prepare('SELECT * FROM workspace_members WHERE user_id=? AND workspace_id=?').get(userId, workspaceId) as any;
  const agentWorkspaceIds = async (userId: number) => (await db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id=? ORDER BY workspace_id').all(userId)).map((row: any) => Number(row.workspace_id));
  const agentStatus = async (agent: any) => ({id: agent.id, userId: agent.user_id, workspaceId: agent.workspace_id, workspaceIds: await agentWorkspaceIds(agent.user_id), machineName: agent.machine_name, lastSeen: agent.last_seen});
  const repositoriesForObservation = (agentId: number, localKey: string, fingerprint: string) => db.prepare(`SELECT DISTINCT r.id,r.workspace_id FROM repository_candidates c
    JOIN repositories r ON r.id=c.repository_id JOIN workspace_members wm ON wm.workspace_id=c.workspace_id
    JOIN agents a ON a.id=c.agent_id AND a.user_id=wm.user_id
    WHERE c.agent_id=? AND c.local_key=? AND c.repository_fingerprint=? AND c.desired_traced=TRUE AND a.revoked_at IS NULL`).all(agentId, localKey, fingerprint);
  const associateEvent = async (eventId: number, repositories: any[]) => {
    for (const repository of repositories) await db.prepare('INSERT INTO activity_event_repositories(event_id,repository_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(eventId, repository.id);
  };
  const requireMember = async (req: Authed, res: Response, next: NextFunction) => {
    const workspaceId = Number(req.params.id || req.params.workspaceId || req.body?.workspaceId);
    if (!(await membership(req.user.id, workspaceId))) return res.status(403).json({error: 'forbidden'});
    next();
  };
  const requireManager = async (req: Authed, res: Response, next: NextFunction) => {
    const workspaceId = Number(req.params.id || req.params.workspaceId);
    if ((await membership(req.user.id, workspaceId))?.role !== 'Manager') return res.status(403).json({error: 'Manager required'});
    next();
  };
  const managerCount = async (workspaceId: number) => (await db.prepare("SELECT COUNT(*)::INTEGER count FROM workspace_members WHERE workspace_id=? AND role='Manager'").get(workspaceId) as any).count as number;
  const hasLockedManagerAuthority = async (workspaceId: number, userId: number) => Boolean(await db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='Manager'").get(workspaceId, userId));
  const revokeDeviceWork = async (agentId: number, reason = 'device revoked') => {
    await db.prepare('UPDATE agents SET revoked_at=?,installation_id=NULL WHERE id=? AND revoked_at IS NULL').run(now(), agentId);
    await db.prepare("UPDATE pending_pushes SET status='unconfirmed',completed_at=? WHERE agent_id=? AND status='pending'").run(now(), agentId);
    await db.prepare("UPDATE report_jobs SET status='failed',error=?,completed_at=? WHERE agent_id=? AND status='running'").run(reason, now(), agentId);
  };
  const freshInviteCode = async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = crypto.randomBytes(5).toString('hex').toUpperCase();
      if (!(await db.prepare('SELECT 1 FROM workspaces WHERE invite_code=?').get(code))) return code;
    }
    throw new Error('could not allocate workspace invite code');
  };
  const workspacesForUser = (userId: number) => db.prepare('SELECT w.id,w.name,w.owner_id,w.created_at,wm.role FROM workspaces w JOIN workspace_members wm ON wm.workspace_id=w.id WHERE wm.user_id=? ORDER BY w.id').all(userId);
  const repositoriesForWorkspace = async (workspaceId: unknown, includeArchived = false) => {
    const archived = includeArchived ? '' : ' AND r.archived=FALSE';
    const rows = await db.prepare(`SELECT r.* FROM repositories r WHERE r.workspace_id=?${archived} ORDER BY r.name`).all(workspaceId);
    return Promise.all(rows.map(async (row: any) => ({
      ...row,
      name: safeRepositoryName(row.name),
      ...((isPrivateLocalIdentity(row.normalized_remote) || isRawLocalRemote(row.remote_url)) ? {remote_url: null, normalized_remote: null} : {}),
      archived: row.archived ? 1 : 0,
      clone_count: (await db.prepare('SELECT COUNT(*)::INTEGER count FROM local_clones WHERE repository_id=?').get(row.id)).count,
    })));
  };
  const membersForWorkspace = (workspaceId: unknown) => db.prepare('SELECT u.id,u.name,u.email,wm.role FROM workspace_members wm JOIN users u ON u.id=wm.user_id WHERE wm.workspace_id=? ORDER BY u.name').all(workspaceId);
  const candidatesForWorkspace = async (workspaceId: unknown, userId: number) => {
    const rows = await db.prepare(`SELECT c.id,c.local_key,c.name,c.remote_url raw_remote_url,c.normalized_remote,c.branch,c.traced,c.desired_traced,c.revision,c.last_seen,c.error,c.repository_id,a.id agent_id,a.user_id owner_user_id,a.machine_name,u.name owner_name
      FROM repository_candidates c JOIN agents a ON a.id=c.agent_id JOIN users u ON u.id=a.user_id JOIN workspace_members owner ON owner.workspace_id=c.workspace_id AND owner.user_id=a.user_id JOIN workspace_members viewer ON viewer.workspace_id=c.workspace_id AND viewer.user_id=?
      WHERE c.workspace_id=? AND (viewer.role='Manager' OR a.user_id=?) AND a.revoked_at IS NULL
      ORDER BY CASE WHEN a.user_id=? THEN 0 ELSE 1 END,u.name,a.machine_name,c.name,c.local_key`).all(userId, workspaceId, userId, userId);
    return rows.map((row: any) => {
      const {raw_remote_url: rawRemoteUrl, ...candidate} = row;
      return {
        ...candidate,
        name: Number(row.owner_user_id) === Number(userId) ? row.name : safeRepositoryName(row.name),
        local_key: Number(row.owner_user_id) === Number(userId) ? row.local_key : null,
        normalized_remote: isPrivateLocalIdentity(row.normalized_remote) || isRawLocalRemote(rawRemoteUrl) ? null : row.normalized_remote,
        error: Number(row.owner_user_id) === Number(userId) ? row.error : row.error ? 'Repository update failed on member device' : null,
      };
    });
  };
  const agentsForWorkspace = (workspaceId: unknown) => {
    const cutoff = new Date(Date.now() - 2 * 60_000).toISOString();
    return db.prepare("SELECT a.id,a.user_id,a.machine_name,a.last_seen,a.revoked_at,u.name user_name,CASE WHEN a.revoked_at IS NOT NULL THEN 'revoked' WHEN a.last_seen>=? THEN 'online' ELSE 'offline' END status FROM agents a JOIN users u ON u.id=a.user_id JOIN workspace_members wm ON wm.user_id=a.user_id AND wm.workspace_id=? WHERE a.removed_at IS NULL ORDER BY a.id").all(cutoff, workspaceId);
  };

  app.get('/api/health', async (_req, res, next) => {
    try {
      await db.query('SELECT 1');
      res.json({ok: true, database: 'ready'});
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/auth/register', required(['name', 'email', 'password']), async (req, res, next) => {
    try {
      const email = req.body.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error: 'valid email required'});
      if (req.body.password.length < 8) return res.status(400).json({error: 'password must be at least 8 characters'});
      const raw = token();
      const name = req.body.name.trim();
      if (!name) return res.status(400).json({error: 'name required'});
      const passwordHash = await bcrypt.hash(req.body.password, 10);
      let created: {userId: number; workspaceId: number} | undefined;
      for (let attempt = 0; attempt < 3 && !created; attempt++) {
        const personalInviteCode = await freshInviteCode();
        try {
          created = await db.transaction(async () => {
            const result = await db.prepare('INSERT INTO users(name,email,password_hash,created_at) VALUES(?,?,?,?) RETURNING id').run(name, email, passwordHash, now());
            const userId = Number(result.lastInsertRowid);
            await db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,auth_version) VALUES(?,?,?,0)').run(hash(raw), userId, now());
            const workspace = await db.prepare('INSERT INTO workspaces(name,owner_id,invite_code,invite_enabled,created_at) VALUES(?,?,?,FALSE,?) RETURNING id').run(`${name}'s workspace`, userId, personalInviteCode, now());
            const workspaceId = Number(workspace.lastInsertRowid);
            await db.prepare("INSERT INTO workspace_members VALUES(?,?,'Manager')").run(workspaceId, userId);
            return {userId, workspaceId};
          });
        } catch (error: any) {
          if (!inviteCodeCollision(error) || attempt === 2) throw error;
        }
      }
      if (!created) throw new Error('could not allocate workspace invite code');
      res.status(201).json({token: raw, user: {id: created.userId, name, email}, workspaceId: created.workspaceId});
    } catch (error: any) {
      if (emailCollision(error)) return res.status(409).json({error: 'email already registered'});
      next(error);
    }
  });
  app.post('/api/auth/login', required(['email', 'password']), async (req, res) => {
    const user: any = await db.prepare('SELECT * FROM users WHERE email=?').get(req.body.email.trim().toLowerCase());
    if (!user || !await bcrypt.compare(req.body.password, user.password_hash)) return res.status(401).json({error: 'invalid credentials'});
    const raw = token();
    await db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,auth_version) VALUES(?,?,?,?)').run(hash(raw), user.id, now(), user.auth_version);
    res.json({token: raw, user: {id: user.id, name: user.name, email: user.email}});
  });
  app.post('/api/auth/logout', userAuth, async (req: Authed, res) => {
    await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(req.headers.authorization!.replace(/^Bearer\s+/i, '')));
    res.status(204).end();
  });
  app.get('/api/auth/me', userAuth, async (req: Authed, res) => res.json({id: req.user.id, name: req.user.name, email: req.user.email}));
  app.get('/api/bootstrap', userAuth, async (req: Authed, res) => res.json({
    user: {id: req.user.id, name: req.user.name, email: req.user.email},
    workspaces: await workspacesForUser(req.user.id),
  }));


  app.post('/api/workspaces', userAuth, required(['name']), async (req: Authed, res) => {
    const inviteCode = crypto.randomBytes(5).toString('hex').toUpperCase();
    const id = Number(await db.transaction(async () => {
      const result = await db.prepare('INSERT INTO workspaces(name,owner_id,invite_code,invite_enabled,created_at) VALUES(?,?,?,FALSE,?) RETURNING id').run(req.body.name.trim(), req.user.id, inviteCode, now());
      await db.prepare("INSERT INTO workspace_members VALUES(?,?,'Manager')").run(result.lastInsertRowid, req.user.id);
      return result.lastInsertRowid;
    }));
    res.status(201).json({id, name: req.body.name.trim()});
  });
  app.post('/api/workspaces/join', userAuth, async (_req, res) => res.status(410).json({error: 'invite codes are retired; accept a targeted invitation from your inbox'}));
  app.get('/api/workspaces', userAuth, async (req: Authed, res) => res.json(await workspacesForUser(req.user.id)));
  app.patch('/api/workspaces/:id', userAuth, requireManager, async (req: Authed, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({error: 'workspace name is required'});
    if (name.length > 120) return res.status(400).json({error: 'workspace name must be 120 characters or fewer'});
    const renamed = await db.transaction(async () => {
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!(await hasLockedManagerAuthority(+req.params.id, req.user.id))) return false;
      await db.prepare('UPDATE workspaces SET name=? WHERE id=?').run(name, req.params.id);
      return true;
    });
    if (!renamed) return res.status(403).json({error: 'Manager required'});
    res.json({id: +req.params.id, name});
  });
  app.get('/api/workspaces/:id/members', userAuth, requireMember, async (req, res) => res.json(await membersForWorkspace(req.params.id)));

  app.post('/api/workspaces/:id/invitations', userAuth, requireManager, async (req: Authed, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const role = req.body.role;
    if (!email) return res.status(400).json({error: 'email is required'});
    if (!['Manager', 'Developer'].includes(role)) return res.status(400).json({error: 'role must be Manager or Developer'});
    const outcome: any = await db.transaction(async () => {
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!(await hasLockedManagerAuthority(+req.params.id, req.user.id))) return {status: 'forbidden'};
      const recipient: any = await db.prepare('SELECT id,name,email FROM users WHERE email=?').get(email);
      if (!recipient) return {status: 'missing'};
      if (await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(req.params.id, recipient.id)) return {status: 'member'};
      await db.prepare("UPDATE workspace_invitations SET status='EXPIRED',responded_at=? WHERE workspace_id=? AND invited_user_id=? AND status='PENDING' AND expires_at<=?").run(now(), req.params.id, recipient.id, now());
      if (await db.prepare("SELECT 1 FROM workspace_invitations WHERE workspace_id=? AND invited_user_id=? AND status='PENDING'").get(req.params.id, recipient.id)) return {status: 'pending'};
      const createdAt = now();
      const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
      const inserted = await db.prepare("INSERT INTO workspace_invitations(workspace_id,invited_user_id,invited_by_id,role,status,expires_at,created_at) VALUES(?,?,?,?,'PENDING',?,?) RETURNING id").run(req.params.id, recipient.id, req.user.id, role, expiresAt, createdAt);
      return {status: 'created', invitation: {id: inserted.lastInsertRowid, workspace_id: +req.params.id, recipient_name: recipient.name, recipient_email: recipient.email, role, status: 'PENDING', expires_at: expiresAt, created_at: createdAt}};
    });
    if (outcome.status === 'forbidden') return res.status(403).json({error: 'Manager required'});
    if (outcome.status === 'missing') return res.status(404).json({error: 'recipient account not found'});
    if (outcome.status === 'member') return res.status(409).json({error: 'recipient is already a workspace member'});
    if (outcome.status === 'pending') return res.status(409).json({error: 'recipient already has a pending invitation'});
    res.status(201).json(outcome.invitation);
  });
  app.get('/api/workspaces/:id/invitations', userAuth, requireManager, async (req: Authed, res) => {
    const rows = await db.transaction(async () => {
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!(await hasLockedManagerAuthority(+req.params.id, req.user.id))) return undefined;
      await db.prepare("UPDATE workspace_invitations SET status='EXPIRED',responded_at=? WHERE workspace_id=? AND status='PENDING' AND expires_at<=?").run(now(), req.params.id, now());
      return await db.prepare('SELECT i.*,u.name recipient_name,u.email recipient_email FROM workspace_invitations i JOIN users u ON u.id=i.invited_user_id WHERE i.workspace_id=? ORDER BY i.created_at DESC LIMIT 100').all(req.params.id);
    });
    if (!rows) return res.status(403).json({error: 'Manager required'});
    res.json(rows);
  });
  app.delete('/api/workspaces/:id/invitations/:invitationId', userAuth, requireManager, async (req: Authed, res) => {
    const outcome = await db.transaction(async () => {
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!(await hasLockedManagerAuthority(+req.params.id, req.user.id))) return 'forbidden';
      const invitation: any = await db.prepare('SELECT * FROM workspace_invitations WHERE id=? AND workspace_id=? FOR UPDATE').get(req.params.invitationId, req.params.id);
      if (!invitation) return 'missing';
      if (invitation.status !== 'PENDING') return 'terminal';
      await db.prepare("UPDATE workspace_invitations SET status='REVOKED',responded_at=? WHERE id=?").run(now(), invitation.id);
      return 'revoked';
    });
    if (outcome === 'forbidden') return res.status(403).json({error: 'Manager required'});
    if (outcome === 'missing') return res.status(404).json({error: 'invitation not found'});
    if (outcome === 'terminal') return res.status(409).json({error: 'invitation is no longer pending'});
    res.status(204).end();
  });
  app.get('/api/invitations', userAuth, async (req: Authed, res) => {
    await db.prepare("UPDATE workspace_invitations SET status='EXPIRED',responded_at=? WHERE invited_user_id=? AND status='PENDING' AND expires_at<=?").run(now(), req.user.id, now());
    const rows = await db.prepare('SELECT i.*,w.name workspace_name,u.name invited_by_name FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id JOIN users u ON u.id=i.invited_by_id WHERE i.invited_user_id=? ORDER BY i.created_at DESC LIMIT 100').all(req.user.id);
    res.json(rows);
  });
  app.post('/api/invitations/:invitationId/accept', userAuth, async (req: Authed, res) => {
    const scope: any = await db.prepare('SELECT workspace_id FROM workspace_invitations WHERE id=? AND invited_user_id=?').get(req.params.invitationId, req.user.id);
    if (!scope) return res.status(404).json({error: 'invitation not found'});
    const outcome = await db.transaction(async () => {
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(scope.workspace_id);
      const invitation: any = await db.prepare('SELECT * FROM workspace_invitations WHERE id=? AND invited_user_id=? FOR UPDATE').get(req.params.invitationId, req.user.id);
      if (!invitation) return 'missing';
      if (invitation.status !== 'PENDING') return 'terminal';
      if (expired(invitation.expires_at)) {
        await db.prepare("UPDATE workspace_invitations SET status='EXPIRED',responded_at=? WHERE id=?").run(now(), invitation.id);
        return 'expired';
      }
      if (await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(invitation.workspace_id, req.user.id)) return 'member';
      await db.prepare('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(?,?,?)').run(invitation.workspace_id, req.user.id, invitation.role);
      await db.prepare("UPDATE workspace_invitations SET status='ACCEPTED',responded_at=? WHERE id=?").run(now(), invitation.id);
      return 'accepted';
    });
    if (outcome === 'missing') return res.status(404).json({error: 'invitation not found'});
    if (outcome === 'terminal' || outcome === 'member') return res.status(409).json({error: 'invitation is no longer pending'});
    if (outcome === 'expired') return res.status(410).json({error: 'invitation expired'});
    res.json({ok: true, workspaceId: Number(scope.workspace_id)});
  });
  app.post('/api/invitations/:invitationId/decline', userAuth, async (req: Authed, res) => {
    const scope: any = await db.prepare('SELECT workspace_id FROM workspace_invitations WHERE id=? AND invited_user_id=?').get(req.params.invitationId, req.user.id);
    if (!scope) return res.status(404).json({error: 'invitation not found'});
    const outcome = await db.transaction(async () => {
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(scope.workspace_id);
      const invitation: any = await db.prepare('SELECT * FROM workspace_invitations WHERE id=? AND invited_user_id=? FOR UPDATE').get(req.params.invitationId, req.user.id);
      if (!invitation) return 'missing';
      if (invitation.status !== 'PENDING') return 'terminal';
      const status = expired(invitation.expires_at) ? 'EXPIRED' : 'DECLINED';
      await db.prepare('UPDATE workspace_invitations SET status=?,responded_at=? WHERE id=?').run(status, now(), invitation.id);
      return status;
    });
    if (outcome === 'missing') return res.status(404).json({error: 'invitation not found'});
    if (outcome === 'terminal') return res.status(409).json({error: 'invitation is no longer pending'});
    if (outcome === 'EXPIRED') return res.status(410).json({error: 'invitation expired'});
    res.json({ok: true});
  });
  app.patch('/api/workspaces/:id/members/:userId', userAuth, requireManager, async (req: Authed, res) => {
    if (!['Manager', 'Developer'].includes(req.body.role)) return res.status(400).json({error: 'role must be Manager or Developer'});
    const outcome = await db.transaction(async () => {
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!(await hasLockedManagerAuthority(+req.params.id, req.user.id))) return 'forbidden';
      const current: any = await db.prepare('SELECT * FROM workspace_members WHERE workspace_id=? AND user_id=?').get(req.params.id, req.params.userId);
      if (!current) return 'missing';
      if (current.role === 'Manager' && req.body.role === 'Developer' && await managerCount(+req.params.id) === 1) return 'last-manager';
      await db.prepare('UPDATE workspace_members SET role=? WHERE workspace_id=? AND user_id=?').run(req.body.role, req.params.id, req.params.userId);
      if (req.body.role === 'Developer') {
        const revokedAt = now();
        await db.prepare('UPDATE report_schedules SET enabled=FALSE,next_run_at=NULL,updated_at=? WHERE workspace_id=? AND configured_by=?').run(revokedAt, req.params.id, req.params.userId);
        await db.prepare("UPDATE report_jobs SET status='failed',error='Manager authorization revoked',completed_at=? WHERE workspace_id=? AND user_id=? AND report_scope='workspace' AND status IN ('pending','running')").run(revokedAt, req.params.id, req.params.userId);
      }
      return 'updated';
    });
    if (outcome === 'forbidden') return res.status(403).json({error: 'Manager required'});
    if (outcome === 'missing') return res.status(404).json({error: 'member not found'});
    if (outcome === 'last-manager') return res.status(409).json({error: 'workspace must retain a Manager'});
    res.json({ok: true, role: req.body.role});
  });
  app.delete('/api/workspaces/:id/members/:userId', userAuth, requireManager, async (req: Authed, res) => {
    const outcome = await db.transaction(async () => {
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!(await hasLockedManagerAuthority(+req.params.id, req.user.id))) return 'forbidden';
      const current: any = await db.prepare('SELECT * FROM workspace_members WHERE workspace_id=? AND user_id=?').get(req.params.id, req.params.userId);
      if (!current) return 'missing';
      if (current.role === 'Manager' && await managerCount(+req.params.id) === 1) return 'last-manager';
      const agentIds = (await db.prepare('SELECT id FROM agents WHERE user_id=?').all(req.params.userId)).map((row: any) => row.id);
      for (const agentId of agentIds) {
        await db.prepare("UPDATE pending_pushes SET status='unconfirmed',completed_at=? WHERE agent_id=? AND repository_id IN (SELECT id FROM repositories WHERE workspace_id=?) AND status='pending'").run(now(), agentId, req.params.id);
        await db.prepare('DELETE FROM local_clones WHERE agent_id=? AND repository_id IN (SELECT id FROM repositories WHERE workspace_id=?)').run(agentId, req.params.id);
        await db.prepare('DELETE FROM repository_candidates WHERE agent_id=? AND workspace_id=?').run(agentId, req.params.id);
      }
      await db.prepare('UPDATE agents SET workspace_id=(SELECT workspace_id FROM workspace_members WHERE user_id=? AND workspace_id<>? ORDER BY workspace_id LIMIT 1) WHERE user_id=? AND workspace_id=?').run(req.params.userId, req.params.id, req.params.userId, req.params.id);
      await db.prepare("UPDATE report_jobs SET status='failed',error='workspace membership removed',completed_at=? WHERE workspace_id=? AND user_id=? AND status IN ('pending','running')").run(now(), req.params.id, req.params.userId);
      await db.prepare('UPDATE report_schedules SET enabled=FALSE,next_run_at=NULL,updated_at=? WHERE workspace_id=? AND configured_by=?').run(now(), req.params.id, req.params.userId);
      await db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(req.params.id, req.params.userId);
      return 'deleted';
    });
    if (outcome === 'forbidden') return res.status(403).json({error: 'Manager required'});
    if (outcome === 'missing') return res.status(404).json({error: 'member not found'});
    if (outcome === 'last-manager') return res.status(409).json({error: 'workspace must retain a Manager'});
    res.status(204).end();
  });
  app.post('/api/workspaces/:id/invite/regenerate', userAuth, async (_req, res) => res.status(410).json({error: 'invite codes are retired; invite a registered account by email'}));
  app.post('/api/workspaces/:id/invite/disable', userAuth, async (_req, res) => res.status(410).json({error: 'invite codes are retired'}));
  app.delete('/api/workspaces/:id', userAuth, requireManager, async (req: Authed, res) => {
    const deleted = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!workspace || !(await hasLockedManagerAuthority(+req.params.id, req.user.id))) return false;
      await db.prepare('DELETE FROM pending_pushes WHERE repository_id IN (SELECT id FROM repositories WHERE workspace_id=?)').run(req.params.id);
      const sharedEvents = await db.prepare(`SELECT e.id,MIN(aer.repository_id)::INTEGER repository_id FROM activity_events e
        JOIN activity_event_repositories aer ON aer.event_id=e.id JOIN repositories retained ON retained.id=aer.repository_id AND retained.workspace_id<>?
        WHERE e.repository_id IN (SELECT id FROM repositories WHERE workspace_id=?) GROUP BY e.id`).all(req.params.id, req.params.id);
      for (const event of sharedEvents as any[]) await db.prepare('UPDATE activity_events SET repository_id=? WHERE id=?').run(event.repository_id, event.id);
      await db.prepare('DELETE FROM activity_events WHERE repository_id IN (SELECT id FROM repositories WHERE workspace_id=?)').run(req.params.id);
      await db.prepare('DELETE FROM local_clones WHERE repository_id IN (SELECT id FROM repositories WHERE workspace_id=?)').run(req.params.id);
      await db.prepare('DELETE FROM reports WHERE workspace_id=?').run(req.params.id);
      await db.prepare('DELETE FROM report_jobs WHERE workspace_id=?').run(req.params.id);
      await db.prepare('DELETE FROM repositories WHERE workspace_id=?').run(req.params.id);
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(req.params.id);
      return true;
    });
    if (!deleted) return res.status(403).json({error: 'Manager required'});
    res.status(204).end();
  });

  app.post('/api/agents/installations', userAuth, async (req: Authed, res) => {
    const workspaceId = Number(req.body.workspaceId);
    if (!(await membership(req.user.id, workspaceId))) return res.status(403).json({error: 'forbidden'});
    const raw = token();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await db.prepare('INSERT INTO setup_codes(code_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)').run(hash(raw), req.user.id, workspaceId, expiresAt, now());
    const origin = requestOrigin(req);
    res.status(201).json({installCommand: linuxInstallCommand(origin, raw), syncCommand: linuxSyncCommand(origin, raw), expiresAt});
  });
  app.get('/api/installers/linux/:installToken', async (req, res) => {
    const setup: any = await db.prepare('SELECT * FROM setup_codes WHERE code_hash=?').get(hash(req.params.installToken));
    if (!setup || setup.used_at || expired(setup.expires_at)) return res.status(410).type('text/plain').send('Install token invalid, expired, or already used.\n');
    try {
      res.type('text/x-shellscript').set('content-disposition', 'attachment; filename="tracemini-install.sh"').send(linuxInstaller(cliDir, requestOrigin(req), req.params.installToken));
    } catch (error: any) {
      res.status(503).json({error: error.message});
    }
  });
  app.post('/api/agents/install/exchange', required(['installToken', 'machineName']), async (req, res) => {
    const installationId = req.body.installationId == null ? null : String(req.body.installationId);
    if (installationId && !/^[a-f0-9]{64}$/.test(installationId)) return res.status(400).json({error: 'invalid installation identity'});
    const agentToken = token();
    const previousAgentToken = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const candidate: any = await db.prepare('SELECT workspace_id FROM setup_codes WHERE code_hash=?').get(hash(req.body.installToken));
    if (!candidate) return res.status(409).json({error: 'install token invalid, expired, or already used'});
    const exchanged = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(candidate.workspace_id);
      if (!workspace) return undefined;
      const setup: any = await db.prepare('SELECT * FROM setup_codes WHERE code_hash=? FOR UPDATE').get(hash(req.body.installToken));
      if (!setup || setup.workspace_id !== candidate.workspace_id || setup.used_at || expired(setup.expires_at)) return undefined;
      const member = await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(setup.workspace_id, setup.user_id);
      if (!member) return undefined;
      await db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(setup.user_id);
      await db.prepare('UPDATE setup_codes SET used_at=? WHERE code_hash=?').run(now(), setup.code_hash);
      let previous: any;
      if (previousAgentToken) previous = await db.prepare('SELECT id,user_id FROM agents WHERE token_hash=? AND revoked_at IS NULL AND removed_at IS NULL FOR UPDATE').get(hash(previousAgentToken));
      if (previous && previous.user_id !== setup.user_id) {
        await revokeDeviceWork(previous.id, 'device synced to another account');
        previous = undefined;
      }
      let reusable: any = installationId ? await db.prepare('SELECT id,user_id FROM agents WHERE user_id=? AND installation_id=? AND revoked_at IS NULL AND removed_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE').get(setup.user_id, installationId) : undefined;
      if (reusable && previous && previous.id !== reusable.id) {
        await revokeDeviceWork(reusable.id, 'duplicate installation consolidated');
        await db.prepare('DELETE FROM local_clones WHERE agent_id=?').run(reusable.id);
        await db.prepare('DELETE FROM repository_candidates WHERE agent_id=?').run(reusable.id);
        await db.prepare('UPDATE agents SET removed_at=? WHERE id=?').run(now(), reusable.id);
        reusable = previous;
      }
      if (!reusable && previous?.user_id === setup.user_id) reusable = previous;
      if (reusable) {
        await db.prepare('UPDATE agents SET workspace_id=?,machine_name=?,installation_id=COALESCE(?,installation_id),token_hash=?,last_seen=? WHERE id=?').run(setup.workspace_id, req.body.machineName.trim(), installationId, hash(agentToken), now(), reusable.id);
        return {agentId: Number(reusable.id), workspaceId: setup.workspace_id, created: false};
      }
      const result = installationId
        ? await db.prepare('INSERT INTO agents(user_id,workspace_id,machine_name,installation_id,token_hash,last_seen,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT (user_id,installation_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,machine_name=EXCLUDED.machine_name,token_hash=EXCLUDED.token_hash,last_seen=EXCLUDED.last_seen RETURNING id').run(setup.user_id, setup.workspace_id, req.body.machineName.trim(), installationId, hash(agentToken), now(), now())
        : await db.prepare('INSERT INTO agents(user_id,workspace_id,machine_name,installation_id,token_hash,last_seen,created_at) VALUES(?,?,?,?,?,?,?) RETURNING id').run(setup.user_id, setup.workspace_id, req.body.machineName.trim(), installationId, hash(agentToken), now(), now());
      return {agentId: Number(result.lastInsertRowid), workspaceId: setup.workspace_id, created: true};
    });
    if (!exchanged) return res.status(409).json({error: 'install token invalid, expired, or already used'});
    res.status(201).json({...exchanged, agentToken});
  });
  app.post('/api/agents/install/abort', agentAuth, async (req: Authed, res) => {
    await db.transaction(async () => {
      const agent: any = await db.prepare('SELECT id FROM agents WHERE id=? AND token_hash=? AND revoked_at IS NULL AND removed_at IS NULL FOR UPDATE').get(req.agent.id, hash(req.headers.authorization!.replace(/^Bearer\s+/i, '')));
      if (!agent) return;
      await revokeDeviceWork(agent.id, 'fresh installation rolled back');
      await db.prepare('DELETE FROM local_clones WHERE agent_id=?').run(agent.id);
      await db.prepare('DELETE FROM repository_candidates WHERE agent_id=?').run(agent.id);
      await db.prepare('UPDATE agents SET removed_at=? WHERE id=?').run(now(), agent.id);
    });
    res.status(204).end();
  });
  app.post('/api/agents/register', userAuth, required(['machineName']), async (req: Authed, res) => {
    const installationId = req.body.installationId == null ? null : String(req.body.installationId);
    if (installationId && !/^[a-f0-9]{64}$/.test(installationId)) return res.status(400).json({error: 'invalid installation identity'});
    const raw = token();
    const agentId = await db.transaction(async () => {
      await db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(req.user.id);
      const existing: any = installationId ? await db.prepare('SELECT id FROM agents WHERE user_id=? AND installation_id=? AND revoked_at IS NULL AND removed_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE').get(req.user.id, installationId) : undefined;
      if (existing) {
        await db.prepare('UPDATE agents SET machine_name=?,token_hash=?,last_seen=? WHERE id=?').run(req.body.machineName, hash(raw), now(), existing.id);
        return Number(existing.id);
      }
      const result = installationId
        ? await db.prepare('INSERT INTO agents(user_id,machine_name,installation_id,token_hash,last_seen,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT (user_id,installation_id) DO UPDATE SET machine_name=EXCLUDED.machine_name,token_hash=EXCLUDED.token_hash,last_seen=EXCLUDED.last_seen RETURNING id').run(req.user.id, req.body.machineName, installationId, hash(raw), now(), now())
        : await db.prepare('INSERT INTO agents(user_id,machine_name,installation_id,token_hash,last_seen,created_at) VALUES(?,?,?,?,?,?) RETURNING id').run(req.user.id, req.body.machineName, installationId, hash(raw), now(), now());
      return Number(result.lastInsertRowid);
    });
    res.status(201).json({agentId, token: raw});
  });
  app.post('/api/agents/workspace', agentAuth, required(['workspaceId']), async (req: Authed, res) => {
    const workspaceId = Number(req.body.workspaceId);
    const outcome = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(workspaceId);
      if (!workspace || !(await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspaceId, req.agent.user_id))) return 'forbidden';
      const agent: any = await db.prepare('SELECT * FROM agents WHERE id=? FOR UPDATE').get(req.agent.id);
      if (!agent || agent.revoked_at) return 'forbidden';
      await db.prepare('UPDATE agents SET workspace_id=? WHERE id=?').run(workspaceId, agent.id);
      return 'updated';
    });
    if (outcome === 'forbidden') return res.status(403).json({error: 'forbidden'});
    res.json({ok: true, workspaceId});
  });
  app.get('/api/agents/status', agentAuth, async (req: Authed, res) => res.json(await agentStatus(req.agent)));
  app.post('/api/agents/heartbeat', agentAuth, async (req: Authed, res) => res.json({ok: true, at: now(), workspaceIds: await agentWorkspaceIds(req.agent.user_id)}));
  app.get('/api/agents/sync', agentAuth, async (req: Authed, res) => {
    await materializeDueReportSchedules(db, req.agent.user_id);
    const [workspaceIds, jobs, refreshRequests, repositorySelections, pushes] = await Promise.all([
      agentWorkspaceIds(req.agent.user_id),
      db.prepare("SELECT j.* FROM report_jobs j JOIN workspace_members wm ON wm.workspace_id=j.workspace_id AND wm.user_id=? WHERE j.user_id=? AND j.status='pending' AND (j.report_scope<>'workspace' OR wm.role='Manager') ORDER BY j.id LIMIT 1").all(req.agent.user_id, req.agent.user_id),
      db.prepare("SELECT id,workspace_id,status,created_at FROM refresh_requests WHERE agent_id=? AND status='queued' AND workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=?) ORDER BY id LIMIT 1").all(req.agent.id, req.agent.user_id),
      db.prepare('SELECT c.id,c.workspace_id,c.local_key,c.name,c.remote_url,c.normalized_remote,c.branch,c.traced,c.desired_traced,c.revision,c.repository_fingerprint FROM repository_candidates c JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=? WHERE c.agent_id=? AND c.desired_traced<>c.traced ORDER BY c.id').all(req.agent.user_id, req.agent.id),
      db.prepare("SELECT * FROM pending_pushes WHERE agent_id=? AND status='pending' AND (next_check_at IS NULL OR next_check_at<=?) ORDER BY id LIMIT 10").all(req.agent.id, now()),
    ]);
    res.json({workspaceIds, jobs, refreshRequests, repositorySelections, pushes});
  });
  app.post('/api/agents/repository-candidates', agentAuth, async (req: Authed, res) => {
    const repositories = req.body?.repositories;
    if (!Array.isArray(repositories) || repositories.length > 500) return res.status(400).json({error: 'repositories array required (maximum 500)'});
    const workspaceId = Number(req.body.workspaceId || req.agent.workspace_id);
    if (!Number.isInteger(workspaceId) || !(await membership(req.agent.user_id, workspaceId))) return res.status(403).json({error: 'workspace unavailable'});
    for (const candidate of repositories) {
      if (!candidate || typeof candidate.localKey !== 'string' || !candidate.localKey.startsWith('/') || candidate.localKey.length > 4096 || typeof candidate.name !== 'string' || !candidate.name.trim() || candidate.name.length > 200 || typeof candidate.remoteUrl !== 'string' || candidate.remoteUrl.length > 4096 || typeof candidate.traced !== 'boolean' || (candidate.branch != null && (typeof candidate.branch !== 'string' || candidate.branch.length > 500)) || (candidate.repositoryId != null && !Number.isInteger(Number(candidate.repositoryId))) || (candidate.identityFingerprint != null && (typeof candidate.identityFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.identityFingerprint))) || (candidate.identityChanged != null && typeof candidate.identityChanged !== 'boolean')) {
        return res.status(400).json({error: 'invalid repository candidate'});
      }
    }
    try {
      await db.transaction(async () => {
        await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(workspaceId);
        if (!(await membership(req.agent.user_id, workspaceId))) throw Object.assign(new Error('workspace unavailable'), {status: 403});
        for (const candidate of repositories) {
        const normalized = normalizeRemote(candidate.remoteUrl) || `local/${req.agent.id}/${candidate.name}`;
        const existing: any = await db.prepare('SELECT * FROM repository_candidates WHERE agent_id=? AND workspace_id=? AND local_key=? FOR UPDATE').get(req.agent.id, workspaceId, candidate.localKey);
        const incomingFingerprint = candidate.identityFingerprint || null;
        const identityChanged = candidate.identityChanged === true || Boolean(existing?.repository_fingerprint && existing.repository_fingerprint !== incomingFingerprint);
        if (existing && identityChanged) {
          await db.prepare(`UPDATE repository_candidates SET name=?,remote_url=?,normalized_remote=?,branch=?,traced=FALSE,desired_traced=FALSE,last_seen=?,error='repository identity changed; select again to resume',repository_id=NULL,repository_fingerprint=?,revision=revision+1 WHERE id=?`).run(candidate.name.trim(), candidate.remoteUrl, normalized, candidate.branch || null, now(), incomingFingerprint, existing.id);
          await db.prepare('DELETE FROM local_clones WHERE agent_id=? AND local_key=? AND repository_id IN (SELECT id FROM repositories WHERE workspace_id=?)').run(req.agent.id, candidate.localKey, workspaceId);
          await db.prepare("UPDATE pending_pushes SET status='unconfirmed',completed_at=? WHERE agent_id=? AND local_key=? AND repository_id IN (SELECT id FROM repositories WHERE workspace_id=?) AND status='pending'").run(now(), req.agent.id, candidate.localKey, workspaceId);
          continue;
        }
        const clone: any = candidate.repositoryId == null ? undefined : await db.prepare(`SELECT lc.repository_id FROM local_clones lc JOIN repositories r ON r.id=lc.repository_id WHERE lc.agent_id=? AND lc.local_key=? AND lc.repository_id=? AND r.workspace_id=?`).get(req.agent.id, candidate.localKey, Number(candidate.repositoryId), workspaceId);
        const traced = Boolean(candidate.traced);
        const desiredTraced = Boolean(candidate.traced && clone?.repository_id);
        await db.prepare(`INSERT INTO repository_candidates(agent_id,workspace_id,local_key,name,remote_url,normalized_remote,branch,traced,desired_traced,last_seen,error,repository_id,repository_fingerprint)
          VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?)
          ON CONFLICT(agent_id,workspace_id,local_key) DO UPDATE SET
            desired_traced=CASE WHEN repository_candidates.normalized_remote=excluded.normalized_remote AND repository_candidates.repository_fingerprint=excluded.repository_fingerprint THEN repository_candidates.desired_traced ELSE FALSE END,
            revision=CASE WHEN repository_candidates.normalized_remote=excluded.normalized_remote AND repository_candidates.repository_fingerprint=excluded.repository_fingerprint THEN repository_candidates.revision ELSE repository_candidates.revision+1 END,
            repository_id=CASE WHEN repository_candidates.normalized_remote=excluded.normalized_remote AND repository_candidates.repository_fingerprint=excluded.repository_fingerprint THEN COALESCE(excluded.repository_id,repository_candidates.repository_id) ELSE NULL END,
            name=excluded.name,remote_url=excluded.remote_url,normalized_remote=excluded.normalized_remote,branch=excluded.branch,traced=excluded.traced,last_seen=excluded.last_seen,error=NULL,repository_fingerprint=excluded.repository_fingerprint`).run(
          req.agent.id, workspaceId, candidate.localKey, candidate.name.trim(), candidate.remoteUrl, normalized, candidate.branch || null, traced, desiredTraced, now(), clone?.repository_id || null, incomingFingerprint,
        );
        }
      });
    } catch (error: any) {
      if (error?.status === 403 || error?.status === 409) return res.status(error.status).json({error: error.message});
      throw error;
    }
    res.json({ok: true, count: repositories.length});
  });
  app.get('/api/workspaces/:id/repository-candidates', userAuth, requireMember, async (req: Authed, res) => {
    res.json(await candidatesForWorkspace(req.params.id, req.user.id));
  });
  app.patch('/api/workspaces/:id/repository-candidates/:candidateId', userAuth, requireMember, async (req: Authed, res) => {
    if (typeof req.body.traced !== 'boolean') return res.status(400).json({error: 'traced boolean required'});
    const revision = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!workspace) return undefined;
      const candidate: any = await db.prepare(`SELECT c.* FROM repository_candidates c JOIN agents a ON a.id=c.agent_id JOIN workspace_members owner ON owner.workspace_id=c.workspace_id AND owner.user_id=a.user_id WHERE c.id=? AND c.workspace_id=? AND a.user_id=? AND a.revoked_at IS NULL FOR UPDATE`).get(req.params.candidateId, req.params.id, req.user.id);
      if (!candidate) return undefined;
      const nextRevision = Number(candidate.revision) + 1;
      await db.prepare('UPDATE repository_candidates SET desired_traced=?,revision=?,error=NULL WHERE id=?').run(req.body.traced, nextRevision, candidate.id);
      if (!req.body.traced && candidate.repository_id) await db.prepare("UPDATE pending_pushes SET status='unconfirmed',completed_at=? WHERE agent_id=? AND repository_id=? AND local_key=? AND status='pending'").run(now(), candidate.agent_id, candidate.repository_id, candidate.local_key);
      return nextRevision;
    });

    if (revision == null) return res.status(404).json({error: 'repository candidate not found'});
    res.json({ok: true, revision});
  });
  app.post('/api/workspaces/:id/repository-scans', userAuth, requireMember, async (req: Authed, res) => {
    const agentId = Number(req.body.agentId);
    if (!Number.isInteger(agentId)) return res.status(400).json({error: 'agentId required'});
    const scan: any = await db.transaction(async () => {
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      const agent: any = await db.prepare('SELECT id FROM agents WHERE id=? AND user_id=? AND revoked_at IS NULL AND removed_at IS NULL FOR UPDATE').get(agentId, req.user.id);
      if (!agent || !(await membership(req.user.id, Number(req.params.id)))) return undefined;
      const active: any = await db.prepare("SELECT id,status FROM refresh_requests WHERE workspace_id=? AND agent_id=? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1").get(req.params.id, agentId);
      if (active) return {...active, agent_id: agentId};
      const created = await db.prepare("INSERT INTO refresh_requests(workspace_id,requested_by,agent_id,status,created_at) VALUES(?,?,?,'queued',?) RETURNING id").run(req.params.id, req.user.id, agentId, now());
      return {id: Number(created.lastInsertRowid), agent_id: agentId, status: 'queued'};
    });
    if (!scan) return res.status(404).json({error: 'active device not found'});
    res.status(202).json({id: Number(scan.id), agentId: Number(scan.agent_id), status: scan.status});
  });
  app.get('/api/workspaces/:id/repository-scans/:requestId', userAuth, requireMember, async (req: Authed, res) => {
    const scan: any = await db.prepare(`SELECT r.id,r.agent_id,r.status,r.repositories_found,r.error,r.created_at,r.claimed_at,r.completed_at
      FROM refresh_requests r JOIN agents a ON a.id=r.agent_id
      WHERE r.id=? AND r.workspace_id=? AND r.requested_by=? AND a.user_id=?`).get(req.params.requestId, req.params.id, req.user.id, req.user.id);
    if (!scan) return res.status(404).json({error: 'repository scan request not found'});
    res.json({...scan, id: Number(scan.id), agent_id: Number(scan.agent_id), repositories_found: scan.repositories_found == null ? null : Number(scan.repositories_found)});
  });
  app.get('/api/agents/refresh-requests', agentAuth, async (req: Authed, res) => {
    res.json(await db.prepare("SELECT id,workspace_id,status,created_at FROM refresh_requests WHERE agent_id=? AND status='queued' AND workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=?) ORDER BY id LIMIT 1").all(req.agent.id, req.agent.user_id));
  });
  app.post('/api/agents/refresh-requests/:requestId/claim', agentAuth, async (req: Authed, res) => {
    const result = await db.prepare("UPDATE refresh_requests SET status='running',claimed_at=? WHERE id=? AND agent_id=? AND status='queued' AND workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=?)").run(now(), req.params.requestId, req.agent.id, req.agent.user_id);
    if (!result.changes) return res.status(409).json({error: 'repository scan request unavailable'});
    res.json({ok: true});
  });
  app.post('/api/agents/refresh-requests/:requestId/complete', agentAuth, async (req: Authed, res) => {
    const repositoriesFound = Number(req.body.repositoriesFound);
    const error = typeof req.body.error === 'string' ? req.body.error.slice(0, 2000) : null;
    if (!error && (!Number.isInteger(repositoriesFound) || repositoriesFound < 0)) return res.status(400).json({error: 'repositoriesFound required'});
    const result = await db.prepare("UPDATE refresh_requests SET status=?,repositories_found=?,error=?,completed_at=? WHERE id=? AND agent_id=? AND status='running'").run(error ? 'error' : 'completed', error ? null : repositoriesFound, error, now(), req.params.requestId, req.agent.id);
    if (!result.changes) return res.status(409).json({error: 'repository scan request unavailable'});
    res.json({ok: true});
  });
  app.get('/api/agents/repository-selections', agentAuth, async (req: Authed, res) => {
    const rows = await db.prepare('SELECT c.id,c.workspace_id,c.local_key,c.name,c.remote_url,c.normalized_remote,c.branch,c.traced,c.desired_traced,c.revision,c.repository_fingerprint FROM repository_candidates c JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=? WHERE c.agent_id=? AND c.desired_traced<>c.traced ORDER BY c.id').all(req.agent.user_id, req.agent.id);
    res.json(rows);
  });
  app.post('/api/agents/repository-selections/:candidateId/claim', agentAuth, async (req: Authed, res) => {
    const revision = Number(req.body.revision);
    if (!Number.isInteger(revision) || typeof req.body.desiredTraced !== 'boolean') return res.status(400).json({error: 'revision and desiredTraced required'});
    const candidate = await db.prepare('SELECT 1 FROM repository_candidates c JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=? WHERE c.id=? AND c.agent_id=? AND c.revision=? AND c.desired_traced=?').get(req.agent.user_id, req.params.candidateId, req.agent.id, revision, req.body.desiredTraced);
    if (!candidate) return res.status(409).json({error: 'repository selection changed'});
    res.json({ok: true});
  });
  app.post('/api/agents/repository-selections/:candidateId/complete', agentAuth, async (req: Authed, res) => {
    const revision = Number(req.body.revision);
    if (typeof req.body.traced !== 'boolean' || typeof req.body.desiredTraced !== 'boolean' || !Number.isInteger(revision)) return res.status(400).json({error: 'traced, desiredTraced, and revision required'});
    const updated = await db.prepare('UPDATE repository_candidates SET traced=?,last_seen=?,error=? WHERE id=? AND agent_id=? AND revision=? AND desired_traced=? AND workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=?)').run(req.body.traced, now(), req.body.error ? String(req.body.error).slice(0, 2000) : null, req.params.candidateId, req.agent.id, revision, req.body.desiredTraced, req.agent.user_id);
    if (!updated.changes && req.body.traced === false) await db.prepare('UPDATE repository_candidates SET traced=FALSE,last_seen=? WHERE id=? AND agent_id=? AND workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=?)').run(now(), req.params.candidateId, req.agent.id, req.agent.user_id);
    if (!updated.changes) return res.status(409).json({error: 'repository selection changed'});
    res.json({ok: true});
  });
  app.get('/api/workspaces/:id/agents', userAuth, requireMember, async (req, res) => {
    res.json(await agentsForWorkspace(req.params.id));
  });
  app.post('/api/workspaces/:id/agents/:agentId/revoke', userAuth, requireMember, async (req: Authed, res) => {
    const outcome = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!workspace || !(await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(req.params.id, req.user.id))) return 'forbidden';
      const agent: any = await db.prepare('SELECT id FROM agents WHERE id=? AND user_id=? FOR UPDATE').get(req.params.agentId, req.user.id);
      if (!agent) return 'missing';
      await revokeDeviceWork(agent.id);
      return 'revoked';
    });
    if (outcome === 'forbidden') return res.status(403).json({error: 'membership required'});
    if (outcome === 'missing') return res.status(404).json({error: 'device not found'});
    res.json({ok: true});
  });
  app.delete('/api/workspaces/:id/agents/:agentId', userAuth, requireMember, async (req: Authed, res) => {
    const outcome = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!workspace || !(await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(req.params.id, req.user.id))) return 'forbidden';
      const agent: any = await db.prepare('SELECT id,revoked_at,removed_at FROM agents WHERE id=? AND user_id=? FOR UPDATE').get(req.params.agentId, req.user.id);
      if (!agent || agent.removed_at) return 'missing';
      if (!agent.revoked_at) return 'active';
      await db.prepare('UPDATE agents SET removed_at=? WHERE id=? AND removed_at IS NULL').run(now(), agent.id);
      return 'removed';
    });
    if (outcome === 'forbidden') return res.status(403).json({error: 'membership required'});
    if (outcome === 'missing') return res.status(404).json({error: 'device not found'});
    if (outcome === 'active') return res.status(409).json({error: 'revoke the device before removing it'});
    res.status(204).end();
  });

  app.post('/api/repositories/register', agentAuth, required(['workspaceId', 'name', 'remoteUrl', 'localKey']), async (req: Authed, res) => {
    const workspaceId = Number(req.body.workspaceId);
    if (!(await membership(req.agent.user_id, workspaceId))) return res.status(403).json({error: 'workspace unavailable'});
    const normalized = normalizeRemote(req.body.remoteUrl);
    if (!normalized) return res.status(400).json({error: 'remote URL required'});
    const fingerprint = typeof req.body.identityFingerprint === 'string' && /^[a-f0-9]{64}$/.test(req.body.identityFingerprint) ? req.body.identityFingerprint : null;
    if (!fingerprint) return res.status(409).json({error: 'repository fingerprint required'});
    const repository: any = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(workspaceId);
      if (!workspace) return undefined;
      const agent: any = await db.prepare('SELECT * FROM agents WHERE id=? FOR UPDATE').get(req.agent.id);
      if (!agent || agent.revoked_at || !(await membership(agent.user_id, workspaceId))) return undefined;
      const candidate: any = await db.prepare(`SELECT c.id FROM repository_candidates c JOIN agents a ON a.id=c.agent_id JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=a.user_id
        WHERE c.agent_id=? AND c.workspace_id=? AND c.local_key=? AND c.desired_traced=TRUE AND c.repository_fingerprint=? AND c.normalized_remote=? AND a.revoked_at IS NULL FOR UPDATE`).get(req.agent.id, workspaceId, req.body.localKey, fingerprint, normalized);
      if (!candidate) return undefined;
      await db.prepare('INSERT INTO repositories(workspace_id,name,remote_url,normalized_remote,created_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,normalized_remote) DO UPDATE SET name=excluded.name,remote_url=excluded.remote_url').run(workspaceId, req.body.name, req.body.remoteUrl, normalized, now());
      const selected: any = await db.prepare('SELECT * FROM repositories WHERE workspace_id=? AND normalized_remote=?').get(workspaceId, normalized);
      await db.prepare('INSERT INTO local_clones(agent_id,repository_id,local_key,branch,last_seen,head_sha,remote_head_sha) VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent_id,repository_id,local_key) DO UPDATE SET branch=excluded.branch,last_seen=excluded.last_seen,head_sha=excluded.head_sha,remote_head_sha=excluded.remote_head_sha').run(req.agent.id, selected.id, req.body.localKey, req.body.branch || null, now(), req.body.headSha || null, req.body.remoteHeadSha || null);
      await db.prepare('UPDATE repository_candidates SET workspace_id=?,repository_id=?,repository_fingerprint=?,last_seen=?,error=NULL WHERE id=?').run(workspaceId, selected.id, fingerprint, now(), candidate.id);
      const observed = await db.prepare(`SELECT DISTINCT e.id,e.agent_id,e.type,e.occurred_at,e.data FROM activity_events e
        JOIN activity_event_repositories aer ON aer.event_id=e.id JOIN repository_candidates c ON c.repository_id=aer.repository_id
        WHERE c.agent_id=? AND c.local_key=? AND c.repository_fingerprint=? AND c.desired_traced=TRUE`).all(req.agent.id, req.body.localKey, fingerprint);
      for (const event of observed as any[]) {
        const duplicate = await db.prepare(`SELECT 1 FROM activity_event_repositories aer JOIN activity_events e ON e.id=aer.event_id
          WHERE aer.repository_id=? AND e.agent_id=? AND e.type=? AND e.occurred_at=? AND e.data=CAST(? AS JSONB)`).get(selected.id, event.agent_id, event.type, event.occurred_at, JSON.stringify(eventData(event.data)));
        if (!duplicate) await db.prepare('INSERT INTO activity_event_repositories(event_id,repository_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(event.id, selected.id);
      }
      return selected;
    });
    if (!repository) return res.status(409).json({error: 'repository must be selected before registration'});
    res.json(repository);
  });
  app.get('/api/workspaces/:id/repositories', userAuth, requireMember, async (req, res) => {
    res.json(await repositoriesForWorkspace(req.params.id, req.query.includeArchived === 'true'));
  });
  app.patch('/api/workspaces/:id/repositories/:repositoryId', userAuth, requireManager, async (req, res) => {
    if (typeof req.body.archived !== 'boolean') return res.status(400).json({error: 'archived boolean required'});
    const result = await db.prepare('UPDATE repositories SET archived=? WHERE id=? AND workspace_id=?').run(req.body.archived, req.params.repositoryId, req.params.id);
    if (!result.changes) return res.status(404).json({error: 'repository not found'});
    res.json({ok: true});
  });

  app.post('/api/pushes/pending', agentAuth, required(['eventKey', 'localKey', 'remoteName', 'remoteUrl', 'ref', 'expectedSha', 'occurredAt']), async (req: Authed, res) => {
    const occurredAt = instant(req.body.occurredAt);
    if (!occurredAt) return res.status(400).json({error: 'occurredAt must be an ISO timestamp'});
    const fingerprint = typeof req.body.identityFingerprint === 'string' && /^[a-f0-9]{64}$/.test(req.body.identityFingerprint) ? req.body.identityFingerprint : null;
    if (!fingerprint) return res.status(403).json({error: 'repository fingerprint required'});
    const outcome = await db.transaction(async () => {
      const repository: any = await db.prepare('SELECT r.* FROM repositories r JOIN repository_candidates c ON c.repository_id=r.id AND c.agent_id=? AND c.local_key=? AND c.desired_traced=TRUE AND c.repository_fingerprint=? JOIN agents a ON a.id=c.agent_id AND a.revoked_at IS NULL JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=a.user_id WHERE r.id=? FOR UPDATE').get(req.agent.id, req.body.localKey, fingerprint, req.body.repositoryId);
      if (!repository) return undefined;
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(repository.workspace_id);
      if (!(await membership(req.agent.user_id, repository.workspace_id))) return undefined;
      const result = await db.prepare("INSERT INTO pending_pushes(event_key,user_id,agent_id,repository_id,local_key,repository_fingerprint,remote_name,remote_url,ref,expected_sha,status,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?, 'pending',?) ON CONFLICT DO NOTHING").run(req.body.eventKey, req.agent.user_id, req.agent.id, repository.id, req.body.localKey, fingerprint, req.body.remoteName, req.body.remoteUrl, req.body.ref, req.body.expectedSha, occurredAt);
      const push = await db.prepare('SELECT * FROM pending_pushes WHERE event_key=?').get(req.body.eventKey);
      return {created: Boolean(result.changes), push};
    });
    if (!outcome) return res.status(403).json({error: 'repository not available'});
    res.status(outcome.created ? 201 : 200).json(outcome.push);
  });
  app.get('/api/agents/pushes', agentAuth, async (req: Authed, res) => res.json(await db.prepare("SELECT * FROM pending_pushes WHERE agent_id=? AND status='pending' AND (next_check_at IS NULL OR next_check_at<=?) ORDER BY id LIMIT 10").all(req.agent.id, now())));
  app.post('/api/agents/pushes/:pushId/complete', agentAuth, async (req: Authed, res) => {
    if (!['confirmed', 'unconfirmed'].includes(req.body.status)) return res.status(400).json({error: 'invalid status'});
    const fingerprint = typeof req.body.identityFingerprint === 'string' && /^[a-f0-9]{64}$/.test(req.body.identityFingerprint) ? req.body.identityFingerprint : null;
    if (!fingerprint) return res.status(409).json({error: 'repository fingerprint required'});
    const outcome = await db.transaction(async () => {
      const push: any = await db.prepare("SELECT p.*,r.workspace_id FROM pending_pushes p JOIN repositories r ON r.id=p.repository_id WHERE p.id=? AND p.agent_id=? AND p.status='pending' FOR UPDATE").get(req.params.pushId, req.agent.id);
      if (!push) return {kind: 'unavailable'} as const;
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(push.workspace_id);
      if (!(await membership(req.agent.user_id, push.workspace_id))) return {kind: 'unavailable'} as const;
      if (push.repository_fingerprint !== fingerprint) return {kind: 'unavailable'} as const;
      const active = await db.prepare('SELECT 1 FROM repository_candidates c JOIN agents a ON a.id=c.agent_id AND a.revoked_at IS NULL JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=a.user_id WHERE c.agent_id=? AND c.workspace_id=? AND c.repository_id=? AND c.local_key=? AND c.repository_fingerprint=? AND c.desired_traced=TRUE').get(push.agent_id, push.workspace_id, push.repository_id, push.local_key, fingerprint);
      if (!active) return {kind: 'unavailable'} as const;
      if (req.body.status === 'unconfirmed' && push.attempts < 2) {
        const nextCheckAt = new Date(Date.now() + 10_000).toISOString();
        await db.prepare("UPDATE pending_pushes SET attempts=attempts+1,next_check_at=? WHERE id=? AND status='pending'").run(nextCheckAt, push.id);
        return {kind: 'retrying', nextCheckAt} as const;
      }
      const observedSha = req.body.observedSha || null;
      await db.prepare("UPDATE pending_pushes SET status=?,observed_sha=?,completed_at=? WHERE id=? AND status='pending'").run(req.body.status, observedSha, now(), push.id);
      await db.prepare('INSERT INTO activity_events(event_key,user_id,agent_id,repository_id,type,occurred_at,data,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(push.event_key, push.user_id, push.agent_id, push.repository_id, 'push', push.occurred_at, JSON.stringify({remote: push.remote_name, remoteUrl: push.remote_url, ref: push.ref, expectedSha: push.expected_sha, observedSha, confirmation: req.body.status}), now());
      const event: any = await db.prepare('SELECT id FROM activity_events WHERE event_key=?').get(push.event_key);
      await associateEvent(event.id, await repositoriesForObservation(push.agent_id, push.local_key, fingerprint));
      return {kind: 'completed'} as const;
    });
    if (outcome.kind === 'unavailable') return res.status(409).json({error: 'push unavailable'});
    if (outcome.kind === 'retrying') return res.json({ok: true, retrying: true, nextCheckAt: outcome.nextCheckAt});
    res.json({ok: true});
  });

  app.post('/api/activity', agentAuth, required(['eventKey', 'localKey', 'type', 'occurredAt']), async (req: Authed, res) => {
    const occurredAt = instant(req.body.occurredAt);
    if (!occurredAt) return res.status(400).json({error: 'occurredAt must be an ISO timestamp'});
    const repositoryId = Number(req.body.repositoryId);
    const fingerprint = typeof req.body.identityFingerprint === 'string' && /^[a-f0-9]{64}$/.test(req.body.identityFingerprint) ? req.body.identityFingerprint : null;
    if (!fingerprint) return res.status(403).json({error: 'repository fingerprint required'});
    const accepted = await db.transaction(async () => {
      const repositories = await repositoriesForObservation(req.agent.id, req.body.localKey, fingerprint);
      const repository: any = repositories.find((item: any) => Number(item.id) === repositoryId);
      if (!repository) return undefined;
      const data = JSON.stringify(req.body.data || {});
      const commitSha = req.body.type === 'commit' && typeof req.body.data?.commitSha === 'string' ? req.body.data.commitSha : null;
      let event: any = commitSha ? await db.prepare(`SELECT e.id FROM activity_events e JOIN activity_event_repositories aer ON aer.event_id=e.id
        JOIN repository_candidates c ON c.repository_id=aer.repository_id
        WHERE c.agent_id=? AND c.local_key=? AND c.repository_fingerprint=? AND e.agent_id=? AND e.type='commit' AND e.data::JSONB->>'commitSha'=? LIMIT 1`).get(req.agent.id, req.body.localKey, fingerprint, req.agent.id, commitSha) : undefined;
      event ||= await db.prepare(`SELECT e.id FROM activity_events e JOIN activity_event_repositories aer ON aer.event_id=e.id
        JOIN repository_candidates c ON c.repository_id=aer.repository_id
        WHERE c.agent_id=? AND c.local_key=? AND c.repository_fingerprint=? AND e.agent_id=? AND e.type=? AND e.occurred_at=? AND e.data=CAST(? AS JSONB) LIMIT 1`).get(req.agent.id, req.body.localKey, fingerprint, req.agent.id, req.body.type, occurredAt, data);
      const result = event ? {changes: 0} : await db.prepare('INSERT INTO activity_events(event_key,user_id,agent_id,repository_id,type,occurred_at,data,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(req.body.eventKey, req.agent.user_id, req.agent.id, repository.id, req.body.type, occurredAt, data, now());
      event ||= await db.prepare('SELECT id FROM activity_events WHERE event_key=?').get(req.body.eventKey);
      await associateEvent(event.id, repositories);
      return Boolean(result.changes);
    });
    if (accepted == null) return res.status(403).json({error: 'repository not available'});
    res.status(accepted ? 201 : 200).json({accepted});
  });
  const repositoryIdsFromQuery = (query: Request['query']): number[] | undefined => {
    if (!Object.prototype.hasOwnProperty.call(query, 'repositoryIds')) return undefined;
    if (typeof query.repositoryIds !== 'string' || !query.repositoryIds) return [];
    if (!/^\d+(,\d+)*$/.test(query.repositoryIds)) return [];
    return [...new Set(query.repositoryIds.split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  };
  const addRepositorySelection = (filters: string[], values: any[], query: Request['query']) => {
    const repositoryIds = repositoryIdsFromQuery(query);
    if (repositoryIds === undefined) return;
    if (!repositoryIds.length) { filters.push('FALSE'); return; }
    filters.push(`r.id IN (${repositoryIds.map(() => '?').join(',')})`);
    values.push(...repositoryIds);
  };
  const activityForWorkspace = async (workspaceId: number, query: Request['query'], extra = '', args: any[] = []) => {
    let sql = 'SELECT e.*,r.id repository_id,u.name user_name,r.name repository_name FROM activity_events e JOIN activity_event_repositories aer ON aer.event_id=e.id JOIN users u ON u.id=e.user_id JOIN repositories r ON r.id=aer.repository_id WHERE r.workspace_id=?' + extra;
    const values: any[] = [workspaceId, ...args];
    const repositoryFilters: string[] = [];
    addRepositorySelection(repositoryFilters, values, query);
    if (repositoryFilters.length) sql += ` AND ${repositoryFilters.join(' AND ')}`;
    const timezone = normalizeTimezone(query.timezone);
    if (query.from) { sql += ' AND e.occurred_at>=?'; values.push(dateRangeUtc(String(query.from), String(query.from), timezone).from); }
    if (query.to) { sql += ' AND e.occurred_at<=?'; values.push(dateRangeUtc(String(query.to), String(query.to), timezone).to); }
    sql += ' ORDER BY e.occurred_at DESC LIMIT 500';
    return (await db.prepare(sql).all(...values)).map((row: any) => ({...row, repository_name: safeRepositoryName(row.repository_name), local_key: null, data: redactCrossMemberEvidence(eventData(row.data))}));
  };
  const statsForWorkspace = async (workspaceId: unknown, query: Request['query']) => {
    const timezone = normalizeTimezone(query.timezone);
    const filters: string[] = ["r.workspace_id=?", "e.type='commit'"];
    const values: any[] = [workspaceId];
    if (query.userId) { filters.push('e.user_id=?'); values.push(query.userId); }
    if (query.repositoryId) { filters.push('r.id=?'); values.push(query.repositoryId); }
    addRepositorySelection(filters, values, query);
    if (query.from) { filters.push('e.occurred_at>=?'); values.push(dateRangeUtc(String(query.from), String(query.from), timezone).from); }
    if (query.to) { filters.push('e.occurred_at<=?'); values.push(dateRangeUtc(String(query.to), String(query.to), timezone).to); }
    const where = filters.join(' AND ');
    const bucketMinutes = activityBucketMinutes(timezone);
    const totals: any = await db.prepare(`SELECT COUNT(*)::INTEGER commits,COALESCE(SUM(CAST(e.data::JSONB->>'filesChanged' AS INTEGER)),0)::INTEGER "filesChanged",COALESCE(SUM(CAST(e.data::JSONB->>'insertions' AS INTEGER)),0)::INTEGER insertions,COALESCE(SUM(CAST(e.data::JSONB->>'deletions' AS INTEGER)),0)::INTEGER deletions FROM activity_events e JOIN activity_event_repositories aer ON aer.event_id=e.id JOIN repositories r ON r.id=aer.repository_id WHERE ${where}`).get(...values);
    const dailyBuckets = await db.prepare(`SELECT date_bin('${bucketMinutes} minutes',source.occurred_at,TIMESTAMPTZ '1970-01-01 00:00:00+00') occurred_hour,COUNT(*)::INTEGER commits,COALESCE(SUM(CAST(source.data::JSONB->>'filesChanged' AS INTEGER)),0)::INTEGER "filesChanged",COALESCE(SUM(CAST(source.data::JSONB->>'insertions' AS INTEGER)),0)::INTEGER insertions,COALESCE(SUM(CAST(source.data::JSONB->>'deletions' AS INTEGER)),0)::INTEGER deletions FROM (SELECT DISTINCT e.id,e.occurred_at,e.data FROM activity_events e JOIN activity_event_repositories aer ON aer.event_id=e.id JOIN repositories r ON r.id=aer.repository_id WHERE ${where}) source GROUP BY date_bin('${bucketMinutes} minutes',source.occurred_at,TIMESTAMPTZ '1970-01-01 00:00:00+00') ORDER BY occurred_hour`).all(...values);
    const dailyByDate = new Map<string, any>();
    for (const bucket of dailyBuckets) {
      const date = dateKeyInTimezone(bucket.occurred_hour, timezone);
      const current = dailyByDate.get(date) || {date, commits: 0, filesChanged: 0, insertions: 0, deletions: 0};
      current.commits += Number(bucket.commits || 0);
      current.filesChanged += Number(bucket.filesChanged || 0);
      current.insertions += Number(bucket.insertions || 0);
      current.deletions += Number(bucket.deletions || 0);
      dailyByDate.set(date, current);
    }
    const daily = [...dailyByDate.values()];
    return {totals, daily};
  };
  const timelineForWorkspace = async (workspaceId: unknown, query: Request['query']) => {
    const timezone = normalizeTimezone(query.timezone);
    const defaultDate = dateKeyInTimezone(now(), timezone);
    const from = String(query.from || defaultDate);
    const to = String(query.to || defaultDate);
    const bounds = dateRangeUtc(from, to, timezone);
    const span = Math.floor((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000) + 1;
    const granularity = span === 1 ? 'hour' : 'day';
    const filters = ["r.workspace_id=?", "e.occurred_at>=?", "e.occurred_at<=?", "e.type IN ('commit','push','pull','stage','branch','merge','rewrite')"];
    const values: any[] = [workspaceId, bounds.from, bounds.to];
    if (query.userId) { filters.push('e.user_id=?'); values.push(Number(query.userId)); }
    if (query.repositoryId) { filters.push('r.id=?'); values.push(Number(query.repositoryId)); }
    addRepositorySelection(filters, values, query);
    const bucketMinutes = activityBucketMinutes(timezone);
    const [workspaceMembers, events] = await Promise.all([
      membersForWorkspace(workspaceId),
      db.prepare(`SELECT source.user_id,source.type,date_bin('${bucketMinutes} minutes',source.occurred_at,TIMESTAMPTZ '1970-01-01 00:00:00+00') occurred_hour,COUNT(*)::INTEGER event_count FROM (SELECT DISTINCT e.id,e.user_id,e.type,e.occurred_at FROM activity_events e JOIN activity_event_repositories aer ON aer.event_id=e.id JOIN repositories r ON r.id=aer.repository_id WHERE ${filters.join(' AND ')}) source GROUP BY source.user_id,source.type,date_bin('${bucketMinutes} minutes',source.occurred_at,TIMESTAMPTZ '1970-01-01 00:00:00+00') ORDER BY occurred_hour`).all(...values),
    ]);
    const members = query.userId ? workspaceMembers.filter((member: any) => Number(member.id) === Number(query.userId)) : workspaceMembers;
    const emptyCounts = () => ({commit: 0, push: 0, pull: 0, stage: 0, branch: 0, merge: 0, rewrite: 0});
    const labels = granularity === 'hour'
      ? Array.from({length: 24}, (_, hour) => `${String(hour).padStart(2, '0')}:00`)
      : Array.from({length: span}, (_, offset) => new Date(Date.parse(`${from}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10));
    const users = members.map((member: any) => ({
      userId: Number(member.id), name: member.name,
      totals: emptyCounts(),
      points: labels.map((label, index) => ({label, ...(granularity === 'hour' ? {hour: index} : {date: label}), ...emptyCounts(), total: 0})),
    }));
    const labelIndexes = new Map(labels.map((label, index) => [label, index]));
    const byUser = new Map(users.map((user: any) => [user.userId, user]));
    for (const event of events as any[]) {
      const user: any = byUser.get(Number(event.user_id));
      if (!user || !(event.type in user.totals)) continue;
      const occurredHour = event.occurred_hour;
      const index = granularity === 'hour' ? hourInTimezone(occurredHour, timezone) : labelIndexes.get(dateKeyInTimezone(occurredHour, timezone));
      if (index === undefined || index < 0) continue;
      const count = Number(event.event_count || 0);
      user.totals[event.type] += count;
      user.points[index][event.type] += count;
      user.points[index].total += count;
    }
    for (const user of users as any[]) if (granularity === 'hour') user.hourly = user.points;
    return {from, to, ...(span === 1 ? {date: from} : {}), timezone, granularity, users};
  };
  const scopedActivity = (query: Request['query']) => query.userId
    ? {extra: ' AND e.user_id=?', args: [Number(query.userId)]}
    : query.repositoryId
      ? {extra: ' AND r.id=?', args: [Number(query.repositoryId)]}
      : {extra: '', args: []};
  const queryActivity = async (req: Authed, res: Response, extra: string, args: any[]) => {
    const workspaceId = Number(req.params.workspaceId || req.query.workspaceId || 0);
    if (!workspaceId || !(await membership(req.user.id, workspaceId))) return res.status(403).json({error: 'forbidden'});
    res.json(await activityForWorkspace(workspaceId, req.query, extra, args));
  };
  app.get('/api/workspaces/:workspaceId/activity', userAuth, async (req: Authed, res) => await queryActivity(req, res, '', []));
  app.get('/api/repositories/:id/activity', userAuth, async (req: Authed, res) => await queryActivity(req, res, ' AND r.id=?', [+req.params.id]));
  app.get('/api/users/:id/activity', userAuth, async (req: Authed, res) => await queryActivity(req, res, ' AND e.user_id=?', [+req.params.id]));
  app.get('/api/workspaces/:id/stats', userAuth, requireMember, async (req, res) => {
    res.json(await statsForWorkspace(req.params.id, req.query));
  });
  app.get('/api/workspaces/:id/timeline', userAuth, requireMember, async (req, res) => {
    const from = req.query.from === undefined ? undefined : String(req.query.from);
    const to = req.query.to === undefined ? undefined : String(req.query.to);
    if (Boolean(from) !== Boolean(to) || (from && !dateOnly(from)) || (to && !dateOnly(to)) || (from && to && (from > to || (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 >= 90))) {
      return res.status(400).json({error: 'activity timeline must be a valid range of 90 days or fewer'});
    }
    res.json(await timelineForWorkspace(req.params.id, req.query));
  });
  app.get('/api/workspaces/:id/dashboard', userAuth, requireMember, async (req, res) => {
    const from = req.query.from === undefined ? undefined : String(req.query.from);
    const to = req.query.to === undefined ? undefined : String(req.query.to);
    if (Boolean(from) !== Boolean(to) || (from && !dateOnly(from)) || (to && !dateOnly(to)) || (from && to && (from > to || (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 >= 90))) {
      return res.status(400).json({error: 'activity timeline must be a valid range of 90 days or fewer'});
    }
    const scope = scopedActivity(req.query);
    const [events, repositories, stats, timeline] = await Promise.all([
      activityForWorkspace(Number(req.params.id), req.query, scope.extra, scope.args),
      repositoriesForWorkspace(req.params.id, true),
      statsForWorkspace(req.params.id, req.query),
      timelineForWorkspace(req.params.id, req.query),
    ]);
    res.json({events, repositories, stats, timeline, today: timeline});
  });
  app.get('/api/workspaces/:id/settings', userAuth, requireMember, async (req: Authed, res) => {
    const [members, repositories, repositoryCandidates, agents] = await Promise.all([
      membersForWorkspace(req.params.id),
      repositoriesForWorkspace(req.params.id, true),
      candidatesForWorkspace(req.params.id, req.user.id),
      agentsForWorkspace(req.params.id),
    ]);
    res.json({members, repositories, repositoryCandidates, agents});
  });

  app.get('/api/workspaces/:id/report-schedule', userAuth, requireManager, async (req: Authed, res) => {
    const result: any = await db.transaction(async () => {
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!(await hasLockedManagerAuthority(+req.params.id, req.user.id))) return {forbidden: true};
      return {row: await db.prepare('SELECT * FROM report_schedules WHERE workspace_id=?').get(req.params.id)};
    });
    if (result.forbidden) return res.status(403).json({error: 'Manager required'});
    const row = result.row;
    if (!row) return res.json(null);
    const state = decodeScheduleDays(eventData(row.selected_days));
    res.json({...row, selected_days: state.days, document_context: state.documents});
  });
  app.put('/api/workspaces/:id/report-schedule', userAuth, requireManager, async (req: Authed, res) => {
    let rule;
    let documentContext;
    try { rule = validateScheduleRule({frequency: req.body.frequency, selectedDays: req.body.selectedDays, localTime: req.body.localTime, timezone: req.body.timezone}); }
    catch (error: any) { return res.status(422).json({error: error.message}); }
    try { documentContext = validateDocumentContext(req.body.documentContext); }
    catch (error: any) { return res.status(422).json({error: error.message}); }
    if (!['codex', 'hermes'].includes(req.body.reporter)) return res.status(400).json({error: 'invalid reporter'});
    if (req.body.format !== undefined && !['summary', 'detailed'].includes(req.body.format)) return res.status(400).json({error: 'invalid report format'});
    if (req.body.name !== undefined && typeof req.body.name !== 'string') return res.status(400).json({error: 'invalid schedule name'});
    const scheduleName = req.body.name?.trim() || 'Scheduled workspace report';
    if (scheduleName.length > 120) return res.status(400).json({error: 'schedule name must be 120 characters or fewer'});
    const windowDays = Number(req.body.windowDays);
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 90) return res.status(400).json({error: 'windowDays must be between 1 and 90'});
    const configuredAt = new Date();
    const enabled = req.body.enabled !== false;
    const outcome: any = await db.transaction(async () => {
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!(await hasLockedManagerAuthority(+req.params.id, req.user.id))) return undefined;
      const existing: any = await db.prepare('SELECT * FROM report_schedules WHERE workspace_id=? FOR UPDATE').get(req.params.id);
      let nextRunAt = enabled ? nextScheduledRun(rule, configuredAt).toISOString() : null;
      if (enabled && existing?.enabled && existing.next_run_at) {
        const existingNextRun = existing.next_run_at instanceof Date ? existing.next_run_at.toISOString() : String(existing.next_run_at);
        const existingDays = decodeScheduleDays(eventData(existing.selected_days)).days;
        const sameTiming = existing.frequency === rule.frequency
          && existing.local_time === rule.localTime
          && existing.timezone === rule.timezone
          && JSON.stringify(existingDays) === JSON.stringify(rule.selectedDays);
        if (sameTiming || new Date(existingNextRun) <= configuredAt) nextRunAt = existingNextRun;
      }
      return await db.prepare(`INSERT INTO report_schedules(workspace_id,configured_by,name,enabled,frequency,selected_days,local_time,timezone,reporter,format,include_diff,notify_slack,window_days,next_run_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET configured_by=EXCLUDED.configured_by,name=EXCLUDED.name,enabled=EXCLUDED.enabled,frequency=EXCLUDED.frequency,selected_days=EXCLUDED.selected_days,local_time=EXCLUDED.local_time,timezone=EXCLUDED.timezone,reporter=EXCLUDED.reporter,format=EXCLUDED.format,include_diff=EXCLUDED.include_diff,notify_slack=EXCLUDED.notify_slack,window_days=EXCLUDED.window_days,next_run_at=EXCLUDED.next_run_at,updated_at=EXCLUDED.updated_at RETURNING *`)
        .get(req.params.id, req.user.id, scheduleName, enabled, rule.frequency, JSON.stringify(encodeScheduleDays(rule.selectedDays, documentContext)), rule.localTime, rule.timezone, req.body.reporter, normalizeReportFormat(req.body.format), req.body.includeDiff === true, req.body.notifySlack === true, windowDays, nextRunAt, configuredAt.toISOString(), configuredAt.toISOString());
    });
    if (!outcome) return res.status(403).json({error: 'Manager required'});
    const state = decodeScheduleDays(eventData(outcome.selected_days));
    res.json({...outcome, selected_days: state.days, document_context: state.documents});
  });
  app.delete('/api/workspaces/:id/report-schedule', userAuth, requireManager, async (req: Authed, res) => {
    const outcome: any = await db.transaction(async () => {
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!(await hasLockedManagerAuthority(+req.params.id, req.user.id))) return undefined;
      return await db.prepare('DELETE FROM report_schedules WHERE workspace_id=? RETURNING *').get(req.params.id);
    });
    if (!outcome) return res.status(404).json({error: 'report schedule not found'});
    const state = decodeScheduleDays(eventData(outcome.selected_days));
    res.json({...outcome, selected_days: state.days, document_context: state.documents});
  });

  app.post('/api/reports/jobs', userAuth, required(['workspaceId', 'startDate', 'endDate', 'reporter']), async (req: Authed, res) => {
    if (!['codex', 'hermes'].includes(req.body.reporter)) return res.status(400).json({error: 'invalid reporter'});
    if (req.body.format !== undefined && !['summary', 'detailed'].includes(req.body.format)) return res.status(400).json({error: 'invalid report format'});
    if (!dateOnly(req.body.startDate) || !dateOnly(req.body.endDate) || req.body.startDate > req.body.endDate) return res.status(400).json({error: 'invalid report date range'});
    if (req.body.name !== undefined && typeof req.body.name !== 'string') return res.status(400).json({error: 'invalid report name'});
    const reportScope = req.body.reportScope === undefined ? 'personal' : req.body.reportScope;
    if (!['personal', 'workspace'].includes(reportScope)) return res.status(400).json({error: 'invalid report scope'});
    const reportName = req.body.name?.trim() || defaultReportName(req.body.startDate, req.body.endDate);
    if (reportName.length > 120) return res.status(400).json({error: 'report name must be 120 characters or fewer'});
    let documentContext;
    try { documentContext = validateDocumentContext(req.body.documentContext); }
    catch (error: any) { return res.status(422).json({error: error.message}); }
    const outcome = await db.transaction(async () => {
      const workspaceId = +req.body.workspaceId;
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(workspaceId);
      const member: any = workspace && await db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspaceId, req.user.id);
      if (!workspace || !member || (reportScope === 'workspace' && member.role !== 'Manager')) return undefined;
      const active: any = await db.prepare("SELECT * FROM report_jobs WHERE workspace_id=? AND user_id=? AND status IN ('pending','running') ORDER BY id DESC LIMIT 1 FOR UPDATE").get(workspaceId, req.user.id);
      if (active) return {job: active, created: false};
      const timezone = normalizeTimezone(req.body.timezone);
      const includeDiff = req.body.includeDiff === true;
      const result = await db.prepare("INSERT INTO report_jobs(workspace_id,user_id,reporter,start_date,end_date,timezone,include_diff,notify_slack,status,report_name,format,report_scope,custom_prompt,created_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?,?,?) RETURNING id").run(workspaceId, req.user.id, req.body.reporter, req.body.startDate, req.body.endDate, timezone, includeDiff, req.body.notifySlack === true, reportName, normalizeReportFormat(req.body.format), reportScope, encodeReportContext(null, documentContext), now());
      return {job: {id: Number(result.lastInsertRowid), status: 'pending'}, created: true};
    });
    if (!outcome) return res.status(403).json({error: 'forbidden'});
    res.status(outcome.created ? 201 : 200).json(outcome.job);
  });
  app.get('/api/workspaces/:id/report-jobs/active', userAuth, requireMember, async (req: Authed, res) => {
    const row = await db.prepare("SELECT * FROM report_jobs WHERE workspace_id=? AND user_id=? AND status IN ('pending','running') ORDER BY id DESC LIMIT 1").get(req.params.id, req.user.id);
    res.json(row || null);
  });
  app.post('/api/reports/:id/regenerate', userAuth, required(['reporter', 'prompt']), async (req: Authed, res) => {
    if (!['codex', 'hermes'].includes(req.body.reporter)) return res.status(400).json({error: 'invalid reporter'});
    if (req.body.format !== undefined && !['summary', 'detailed'].includes(req.body.format)) return res.status(400).json({error: 'invalid report format'});
    const prompt = typeof req.body.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt || prompt.length > 4000) return res.status(400).json({error: 'prompt must be between 1 and 4000 characters'});
    const scope: any = await db.prepare('SELECT workspace_id FROM reports WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!scope) return res.status(404).json({error: 'not found'});
    const result = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(scope.workspace_id);
      if (!workspace) return {status: 'not_found'};
      const report: any = await db.prepare('SELECT r.*,j.custom_prompt source_custom_prompt FROM reports r LEFT JOIN report_jobs j ON j.id=r.job_id WHERE r.id=? AND r.user_id=? AND r.workspace_id=? FOR UPDATE').get(req.params.id, req.user.id, scope.workspace_id);
      if (!report) return {status: 'not_found'};
      const member = await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(report.workspace_id, req.user.id);
      if (!member) return {status: 'forbidden'};
      const active = await db.prepare("SELECT id FROM report_jobs WHERE target_report_id=? AND status IN ('pending','running')").get(report.id);
      if (active) return {status: 'conflict'};
      const documents = decodeReportContext(report.source_custom_prompt).documents;
      const inserted = await db.prepare("INSERT INTO report_jobs(workspace_id,user_id,reporter,start_date,end_date,timezone,include_diff,status,custom_prompt,target_report_id,format,report_scope,created_at) VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?,?) RETURNING id").run(report.workspace_id, report.user_id, req.body.reporter, report.start_date, report.end_date, normalizeTimezone(report.timezone), Boolean(report.include_diff), encodeReportContext(prompt, documents), report.id, normalizeReportFormat(req.body.format ?? report.format), report.report_scope || 'personal', now());
      return {status: 'created', id: Number(inserted.lastInsertRowid)};
    });
    if (result.status === 'not_found') return res.status(404).json({error: 'not found'});
    if (result.status === 'forbidden') return res.status(403).json({error: 'forbidden'});
    if (result.status === 'conflict') return res.status(409).json({error: 'report regeneration already queued'});
    res.status(201).json({id: result.id, status: 'pending'});
  });
  app.patch('/api/reports/:id', userAuth, required(['name']), async (req: Authed, res) => {
    const name = req.body.name.trim();
    if (name.length > 120) return res.status(400).json({error: 'report name must be 120 characters or fewer'});
    const scope: any = await db.prepare('SELECT workspace_id FROM reports WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!scope) return res.status(404).json({error: 'not found'});
    const result = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(scope.workspace_id);
      if (!workspace) return {status: 'not_found'};
      const report: any = await db.prepare('SELECT id,workspace_id FROM reports WHERE id=? AND user_id=? AND workspace_id=? FOR UPDATE').get(req.params.id, req.user.id, scope.workspace_id);
      if (!report) return {status: 'not_found'};
      const member = await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(report.workspace_id, req.user.id);
      if (!member) return {status: 'forbidden'};
      return {status: 'updated', report: await db.prepare('UPDATE reports SET name=? WHERE id=? RETURNING *').get(name, report.id)};
    });
    if (result.status === 'not_found') return res.status(404).json({error: 'not found'});
    if (result.status === 'forbidden') return res.status(403).json({error: 'forbidden'});
    res.json(reportOutput(result.report));
  });
  app.get('/api/reports/jobs/:id', userAuth, async (req: Authed, res) => { const row = await db.prepare('SELECT j.* FROM report_jobs j JOIN workspace_members wm ON wm.workspace_id=j.workspace_id AND wm.user_id=? WHERE j.id=? AND j.user_id=?').get(req.user.id, req.params.id, req.user.id); row ? res.json(row) : res.status(404).json({error: 'not found'}); });
  app.get('/api/agents/jobs', agentAuth, async (req: Authed, res) => {
    await materializeDueReportSchedules(db, req.agent.user_id);
    res.json(await db.prepare("SELECT j.* FROM report_jobs j JOIN workspace_members wm ON wm.workspace_id=j.workspace_id AND wm.user_id=? WHERE j.user_id=? AND j.status='pending' AND (j.report_scope<>'workspace' OR wm.role='Manager') ORDER BY j.id LIMIT 1").all(req.agent.user_id, req.agent.user_id));
  });
  app.post('/api/agents/jobs/:id/claim', agentAuth, async (req: Authed, res) => { const result = await db.prepare("UPDATE report_jobs SET status='running',agent_id=?,claimed_at=? WHERE id=? AND user_id=? AND status='pending' AND workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=?) AND (report_scope<>'workspace' OR workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=? AND role='Manager'))").run(req.agent.id, now(), req.params.id, req.agent.user_id, req.agent.user_id, req.agent.user_id); result.changes ? res.json(await db.prepare('SELECT * FROM report_jobs WHERE id=?').get(req.params.id)) : res.status(409).json({error: 'job unavailable'}); });
  app.get('/api/agents/jobs/:id/context', agentAuth, async (req: Authed, res) => {
    const job: any = await db.prepare("SELECT j.* FROM report_jobs j JOIN workspace_members wm ON wm.workspace_id=j.workspace_id AND wm.user_id=? WHERE j.id=? AND j.user_id=? AND j.agent_id=? AND j.status='running' AND (j.report_scope<>'workspace' OR wm.role='Manager')").get(req.agent.user_id, req.params.id, req.agent.user_id, req.agent.id);
    if (!job) return res.status(404).json({error: 'not found'});
    const bounds = dateRangeUtc(isoDate(job.start_date), isoDate(job.end_date), normalizeTimezone(job.timezone));
    const events = (await db.prepare(`SELECT e.*,u.name user_name,r.name repository_name,r.remote_url repository_remote_url,r.normalized_remote
      FROM report_jobs j JOIN workspace_members wm ON wm.workspace_id=j.workspace_id AND wm.user_id=j.user_id
      JOIN repositories r ON r.workspace_id=j.workspace_id JOIN activity_event_repositories aer ON aer.repository_id=r.id JOIN activity_events e ON e.id=aer.event_id JOIN users u ON u.id=e.user_id
      WHERE j.id=? AND j.user_id=? AND j.agent_id=? AND j.status='running' AND (j.report_scope<>'workspace' OR wm.role='Manager')
        AND (j.report_scope='workspace' OR e.user_id=j.user_id) AND e.occurred_at>=? AND e.occurred_at<=? ORDER BY e.occurred_at`).all(job.id, req.agent.user_id, req.agent.id, bounds.from, bounds.to)).map((row: any) => {
          const {repository_remote_url: repositoryRemoteUrl, ...event} = row;
          const crossMember = Number(row.user_id) !== Number(job.user_id);
          return {
            ...event,
            repository_name: crossMember ? safeRepositoryName(row.repository_name) : row.repository_name,
            local_key: crossMember ? null : row.local_key,
            normalized_remote: crossMember && (isPrivateLocalIdentity(row.normalized_remote) || isRawLocalRemote(repositoryRemoteUrl)) ? null : row.normalized_remote,
            data: crossMember ? redactCrossMemberEvidence(eventData(row.data)) : eventData(row.data),
          };
        });
    res.json({job, events});
  });
  app.post('/api/agents/jobs/:id/complete', agentAuth, required(['markdown']), async (req: Authed, res) => {
    if (typeof req.body.markdown !== 'string' || !req.body.markdown.trim()) return res.status(422).json({error: 'report output was empty'});
    const markdown = req.body.markdown.trim();
    const completed = await db.transaction(async () => {
      const job: any = await db.prepare("SELECT j.*,w.name workspace_name FROM report_jobs j JOIN workspaces w ON w.id=j.workspace_id JOIN workspace_members wm ON wm.workspace_id=j.workspace_id AND wm.user_id=? WHERE j.id=? AND j.user_id=? AND j.status='running' AND j.agent_id=? AND (j.report_scope<>'workspace' OR wm.role='Manager') FOR UPDATE").get(req.agent.user_id, req.params.id, req.agent.user_id, req.agent.id);
      if (!job) return undefined;
      let reportId = job.target_report_id;
      if (job.target_report_id) {
        const updated = await db.prepare('UPDATE reports SET job_id=?,markdown=?,format=?,report_scope=?,created_at=? WHERE id=? AND workspace_id=? AND user_id=?').run(job.id, markdown, job.format, job.report_scope, now(), job.target_report_id, job.workspace_id, job.user_id);
        if (updated.changes !== 1) return undefined;
      } else {
        const inserted = await db.prepare('INSERT INTO reports(job_id,workspace_id,user_id,start_date,end_date,timezone,include_diff,name,format,report_scope,schedule_id,scheduled_for,coalesced_runs,markdown,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id').run(job.id, job.workspace_id, job.user_id, job.start_date, job.end_date, job.timezone, job.include_diff, job.report_name || defaultReportName(job.start_date, job.end_date), job.format, job.report_scope, job.schedule_id, job.scheduled_for, job.coalesced_runs, markdown, now());
        reportId = inserted.lastInsertRowid;
      }
      await db.prepare("UPDATE report_jobs SET status='completed',completed_at=? WHERE id=?").run(now(), job.id);
      return {id: Number(reportId), workspaceId: Number(job.workspace_id), workspaceName: job.workspace_name, name: job.report_name || defaultReportName(job.start_date, job.end_date), startDate: isoDate(job.start_date), endDate: isoDate(job.end_date), scope: job.report_scope, markdown, notifySlack: Boolean(job.notify_slack)};
    });
    if (!completed) return res.status(409).json({error: 'job not claimed'});
    if (completed.notifySlack) {
      const webhookUrl = process.env.SLACK_REPORT_WEBHOOK_URL;
      if (!webhookUrl) console.error('Slack report notification skipped: SLACK_REPORT_WEBHOOK_URL is not configured');
      else try { await slackNotifier(webhookUrl, completed); }
      catch (error) { console.error('Slack report notification failed:', error); }
    }
    res.status(201).json({ok: true});
  });
  app.post('/api/agents/jobs/:id/fail', agentAuth, required(['error']), async (req: Authed, res) => { const result = await db.prepare("UPDATE report_jobs SET status='failed',error=?,completed_at=? WHERE id=? AND user_id=? AND agent_id=? AND status='running' AND workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=?) AND (report_scope<>'workspace' OR workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=? AND role='Manager'))").run(req.body.error, now(), req.params.id, req.agent.user_id, req.agent.id, req.agent.user_id, req.agent.user_id); res.status(result.changes ? 200 : 409).json({ok: Boolean(result.changes)}); });
  app.get('/api/workspaces/:id/reports', userAuth, requireMember, async (req, res) => {
    const rows = await db.prepare('SELECT r.id,r.job_id,r.workspace_id,r.user_id,r.start_date,r.end_date,r.timezone,r.include_diff,r.name,r.format,r.report_scope,r.schedule_id,r.scheduled_for,r.coalesced_runs,r.created_at,u.name user_name FROM reports r JOIN users u ON u.id=r.user_id WHERE r.workspace_id=? ORDER BY r.created_at DESC').all(req.params.id);
    res.json(rows.map(reportOutput));
  });
  app.get('/api/reports/:id', userAuth, async (req: Authed, res) => {
    const row = await db.prepare('SELECT r.*,u.name user_name FROM reports r JOIN users u ON u.id=r.user_id JOIN workspace_members wm ON wm.workspace_id=r.workspace_id WHERE r.id=? AND wm.user_id=?').get(req.params.id, req.user.id);
    row ? res.json(reportOutput(row)) : res.status(404).json({error: 'not found'});
  });

  if (webDir && fs.existsSync(webDir)) {
    app.use(express.static(webDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      if (req.path.startsWith('/api/')) return res.status(404).json({error: 'not found'});
      res.sendFile(path.join(webDir, 'index.html'));
    });
  }
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error(error);
    const databaseBusy = error?.code === 'EMAXCONNSESSION' || /max clients reached in session mode/i.test(error?.message || '');
    if (databaseBusy) return res.status(503).set('retry-after', '5').json({error: 'TraceMini database is temporarily busy. Please retry in a few seconds.'});
    res.status(500).json({error: 'internal error'});
  });
  return app;
}
