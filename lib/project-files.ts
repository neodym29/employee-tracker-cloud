import type { SessionUser } from './auth';
import { ensureSchema, getPool } from './db';
import { ProjectServiceError, projectAccessSql } from './projects';

export const PROJECT_FILE_CONTENT_MAX_BYTES = 256 * 1024;
export const PROJECT_FILE_PATH_MAX = 1024;
export const PROJECT_FILE_TOMBSTONE_MEDIA_TYPE = 'application/x.project-tombstone';

function positiveId(value: unknown, field: string) {
  const normalized = String(value ?? '');
  if (!/^[1-9]\d*$/.test(normalized)) throw new ProjectServiceError(`Invalid ${field}`);
  return normalized;
}

function uuid(value: unknown) {
  const normalized = String(value ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new ProjectServiceError('Invalid file id');
  }
  return normalized;
}

export function validateProjectFilePath(value: unknown) {
  if (typeof value !== 'string' || value.length < 1 || value.length > PROJECT_FILE_PATH_MAX || value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProjectServiceError('Invalid project file path');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw new ProjectServiceError('Invalid project file path');
  return value;
}

export function validateProjectFileContent(value: unknown) {
  if (typeof value !== 'string') throw new ProjectServiceError('File content is required');
  if (Buffer.byteLength(value, 'utf8') > PROJECT_FILE_CONTENT_MAX_BYTES) throw new ProjectServiceError('File content exceeds 256KB');
  return value;
}

export function validateProjectFileMediaType(value: unknown) {
  const mediaType = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mediaType) || mediaType.length > 255 || mediaType === PROJECT_FILE_TOMBSTONE_MEDIA_TYPE) {
    throw new ProjectServiceError('Invalid file media type');
  }
  return mediaType;
}

export function projectFileContentDisposition(path: string) {
  const filename = path.split('/').at(-1) || 'project-file';
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_').slice(0, 180) || 'project-file';
  const encoded = [...Buffer.from(filename, 'utf8')].map((byte) => {
    const character = String.fromCharCode(byte);
    return /^[A-Za-z0-9!#$&+.^_`|~-]$/.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function ready() { await ensureSchema(); return getPool(); }

async function assertAccess(db: { query: Function }, session: SessionUser, project: string) {
  const access = projectAccessSql('$2');
  const result = await db.query(`select 1 from projects p ${access.join} where p.id=$1 and ${access.predicate} limit 1`, [project, session.id]);
  if (!result.rows[0]) throw new ProjectServiceError('Project not found', 404, 'not_found');
}

const liveFilesSql = `select h.file_id,h.current_version as version,h.path,h.media_type,v.content,h.byte_size,h.sha256,v.created_by,v.created_at
  from project_file_heads h join project_files v on v.project_id=h.project_id and v.file_id=h.file_id and v.version=h.current_version
  where h.project_id=$1 and h.deleted_at is null`;

export async function listProjectFiles(session: SessionUser, projectId: unknown) {
  const project = positiveId(projectId, 'project id');
  const db = await ready();
  await assertAccess(db, session, project);
  const result = await db.query(liveFilesSql, [project]);
  return result.rows
    .map(({ content: _content, ...manifest }: Record<string, unknown>) => manifest)
    .sort((left: Record<string, unknown>, right: Record<string, unknown>) => String(left.path).localeCompare(String(right.path)));
}

export async function getProjectFile(session: SessionUser, projectId: unknown, fileId: unknown) {
  const project = positiveId(projectId, 'project id');
  const file = uuid(fileId);
  const db = await ready();
  await assertAccess(db, session, project);
  const result = await db.query(`select * from (${liveFilesSql}) live where file_id=$2`, [project, file]);
  const latest = result.rows[0];
  if (!latest) throw new ProjectServiceError('File not found', 404, 'not_found');
  return latest;
}
