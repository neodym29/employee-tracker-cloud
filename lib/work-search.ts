import type { SessionUser } from './auth';
import { ApiError } from './api';
import { ensureChatsSchema } from './chats';
import { ensureSchema, getPool } from './db';
import { projectAccessSql } from './projects';

export async function searchWork(session: SessionUser, raw: unknown) {
  if (typeof raw !== 'string' || raw.trim().length < 2 || raw.trim().length > 100) {
    throw new ApiError('Search for 2–100 characters', 400, 'invalid_search');
  }
  const term = raw.trim();
  await Promise.all([ensureSchema(), ensureChatsSchema()]);
  const db = getPool();
  const access = projectAccessSql('$1');
  const [projects, messages, projectChats] = await Promise.all([
    db.query(`select p.id::text as id,p.title,left(p.description,180) as excerpt,p.updated_at
      from projects p ${access.join}
      where ${access.predicate} and p.status<>'archived'
        and (strpos(lower(p.title),lower($2))>0 or strpos(lower(p.description),lower($2))>0)
      order by p.updated_at desc,p.id desc limit 30`, [session.id, term]),
    db.query(`select msg.id::text as id,c.id::text as conversation_id,c.kind,c.title,
        coalesce(nullif(sender.display_name,''),split_part(sender.email,'@',1)) as sender_name,
        coalesce(nullif(peer.display_name,''),split_part(peer.email,'@',1)) as peer_name,
        substring(msg.body from greatest(1,strpos(lower(msg.body),lower($3))-55) for 210) as excerpt,msg.created_at
      from chat_messages msg
      join chat_conversations c on c.id=msg.conversation_id and c.company_id=$2
      join chat_conversation_members mine on mine.conversation_id=c.id and mine.user_id=$1
      join app_users sender on sender.id=msg.sender_id and sender.company_id=$2
      left join chat_conversation_members other on other.conversation_id=c.id and other.user_id<>$1 and c.kind='dm'
      left join app_users peer on peer.id=other.user_id and peer.company_id=$2
      where msg.deleted_at is null and strpos(lower(msg.body),lower($3))>0
        and (mine.cleared_at is null or msg.created_at>mine.cleared_at)
        and (mine.hidden_at is null or c.updated_at>mine.hidden_at)
      order by msg.created_at desc,msg.id desc limit 30`, [session.id, session.company_id, term]),
    db.query(`select msg.id::text as id,p.id::text as project_id,p.title as project_title,msg.role,
        substring(msg.body from greatest(1,strpos(lower(msg.body),lower($2))-55) for 210) as excerpt,msg.created_at
      from project_chat_messages msg join projects p on p.id=msg.project_id ${access.join}
      where ${access.predicate} and p.status<>'archived' and msg.role in ('user','assistant')
        and strpos(lower(msg.body),lower($2))>0
      order by msg.created_at desc,msg.id desc limit 30`, [session.id, term]),
  ]);
  return { projects: projects.rows, messages: messages.rows, projectChats: projectChats.rows };
}
