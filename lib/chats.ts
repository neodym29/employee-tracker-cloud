import type { PoolClient } from 'pg';
import type { SessionUser } from './auth';
import { ApiError } from './api';
import { getPool } from './db';
import { ensureProfilesSchema } from './profiles';

let schemaReady: Promise<void> | null = null;

export async function ensureChatsSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = getPool().query(`
    create table if not exists chat_conversations (
      id bigserial primary key,
      company_id bigint not null references companies(id) on delete cascade,
      kind text not null check(kind in ('group','dm')),
      title text check(title is null or length(title) between 2 and 80),
      dm_key text,
      created_by bigint not null references app_users(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(company_id,dm_key),
      check((kind='dm' and dm_key is not null and title is null) or (kind='group' and dm_key is null and title is not null))
    );
    create unique index if not exists idx_chat_dm_key_global on chat_conversations(dm_key);
    create table if not exists chat_conversation_members (
      conversation_id bigint not null references chat_conversations(id) on delete cascade,
      user_id bigint not null references app_users(id) on delete cascade,
      joined_at timestamptz not null default now(),
      last_read_at timestamptz not null default now(),
      hidden_at timestamptz,
      cleared_at timestamptz,
      is_admin boolean not null default false,
      primary key(conversation_id,user_id)
    );
    create index if not exists idx_chat_members_user on chat_conversation_members(user_id,conversation_id);
    create table if not exists chat_messages (
      id bigserial primary key,
      conversation_id bigint not null references chat_conversations(id) on delete cascade,
      sender_id bigint not null references app_users(id),
      parent_message_id bigint,
      body text not null check(length(body) between 1 and 4000),
      created_at timestamptz not null default now(),
      edited_at timestamptz,
      deleted_at timestamptz,
      unique(conversation_id,id),
      foreign key(conversation_id,parent_message_id) references chat_messages(conversation_id,id)
    );
    create index if not exists idx_chat_messages_conversation on chat_messages(conversation_id,id desc);
    create index if not exists idx_chat_messages_thread on chat_messages(conversation_id,parent_message_id,id);
    alter table chat_conversation_members add column if not exists hidden_at timestamptz;
    alter table chat_conversation_members add column if not exists cleared_at timestamptz;
    alter table chat_conversation_members add column if not exists is_admin boolean not null default false;
    update chat_conversation_members m set is_admin=true
      from chat_conversations c where c.id=m.conversation_id and c.kind='group'
      and c.created_by=m.user_id and not m.is_admin;
    alter table chat_messages add column if not exists edited_at timestamptz;
    alter table chat_messages add column if not exists deleted_at timestamptz;
  `).then(() => undefined).catch((error) => { schemaReady = null; throw error; });
  return schemaReady;
}

function id(value: unknown, label: string) {
  const result = String(value ?? '');
  if (!/^[1-9]\d{0,18}$/.test(result)) throw new ApiError(`Invalid ${label}`, 400, 'invalid_id');
  return result;
}

function chatUser(session: SessionUser) {
  if (!['admin', 'client', 'engineer'].includes(session.account_type)) throw new ApiError('Forbidden', 403, 'forbidden');
}

async function memberConversation(db: PoolClient | ReturnType<typeof getPool>, session: SessionUser, conversationId: string) {
  const result = await db.query(`select c.id,c.company_id,c.kind,c.title,c.created_by,c.created_at,m.is_admin
    from chat_conversations c join chat_conversation_members m on m.conversation_id=c.id
    where c.id=$1 and m.user_id=$2 and c.company_id=$3`, [conversationId, session.id, session.company_id]);
  if (!result.rows[0]) throw new ApiError('Conversation not found', 404, 'not_found');
  return result.rows[0];
}

export async function listChatPeople(session: SessionUser) {
  chatUser(session);
  await ensureChatsSchema();
  await ensureProfilesSchema();
  const result = await getPool().query(`select u.id::text as id,coalesce(nullif(u.display_name,''),split_part(u.email,'@',1)) as name,u.account_type,
    coalesce(p.bio,'') as bio,coalesce(p.status_text,'') as "statusText",
    coalesce(p.avatar_kind,'initials') as "avatarKind",p.avatar_preset as "avatarPreset",p.avatar_updated_at as "avatarUpdatedAt"
    from app_users u left join user_social_profiles p on p.user_id=u.id
    where u.id<>$1 and u.company_id=$2 and u.approval_status='approved'
      and u.account_type in ('admin','client','engineer') order by lower(coalesce(nullif(u.display_name,''),u.email)),u.id`, [session.id, session.company_id]);
  return result.rows;
}

export async function listChats(session: SessionUser) {
  chatUser(session);
  await ensureChatsSchema();
  await ensureProfilesSchema();
  const result = await getPool().query(`select c.id,c.kind,c.title,c.created_by,c.created_at,c.updated_at,mine.is_admin,
    coalesce((select json_agg(json_build_object('id',u.id::text,'name',coalesce(nullif(u.display_name,''),split_part(u.email,'@',1)),'accountType',u.account_type,'isAdmin',cm.is_admin,
      'bio',coalesce(p.bio,''),'statusText',coalesce(p.status_text,''),'avatarKind',coalesce(p.avatar_kind,'initials'),
      'avatarPreset',p.avatar_preset,'avatarUpdatedAt',p.avatar_updated_at) order by lower(coalesce(nullif(u.display_name,''),u.email)))
      from chat_conversation_members cm join app_users u on u.id=cm.user_id
      left join user_social_profiles p on p.user_id=u.id where cm.conversation_id=c.id and u.company_id=$2),'[]'::json) as members,
    (select case when msg.deleted_at is null then msg.body else 'Message deleted' end from chat_messages msg join app_users sender on sender.id=msg.sender_id and sender.company_id=$2 where msg.conversation_id=c.id and (mine.cleared_at is null or msg.created_at>mine.cleared_at) order by msg.id desc limit 1) as last_message,
    (select count(*)::int from chat_messages msg join app_users sender on sender.id=msg.sender_id and sender.company_id=$2 where msg.conversation_id=c.id and msg.created_at>greatest(mine.last_read_at,coalesce(mine.cleared_at,'-infinity'::timestamptz)) and msg.sender_id<>$1 and msg.deleted_at is null) as unread_count
    from chat_conversations c join chat_conversation_members mine on mine.conversation_id=c.id and mine.user_id=$1
    where c.company_id=$2 and (mine.hidden_at is null or c.updated_at>mine.hidden_at)
    order by c.updated_at desc,c.id desc limit 200`, [session.id, session.company_id]);
  return result.rows;
}

export async function chatNotifications(session: SessionUser) {
  chatUser(session);
  await ensureChatsSchema();
  const result = await getPool().query(`select c.id,c.kind,c.title,
    coalesce(nullif(peer.display_name,''),split_part(peer.email,'@',1)) as peer_name,
    count(msg.id)::int as unread_count,
    sum(count(msg.id)) over () as total_unread,
    max(msg.created_at) as latest_at
    from chat_conversations c
    join chat_conversation_members mine on mine.conversation_id=c.id and mine.user_id=$1
    left join chat_conversation_members other on other.conversation_id=c.id and other.user_id<>$1 and c.kind='dm'
    left join app_users peer on peer.id=other.user_id and peer.company_id=$2
    join chat_messages msg on msg.conversation_id=c.id and msg.sender_id<>$1 and msg.deleted_at is null
      and msg.created_at>greatest(mine.last_read_at,coalesce(mine.cleared_at,'-infinity'::timestamptz))
    join app_users sender on sender.id=msg.sender_id and sender.company_id=$2
    where c.company_id=$2 and (mine.hidden_at is null or c.updated_at>mine.hidden_at)
    group by c.id,peer.id order by max(msg.created_at) desc limit 20`, [session.id, session.company_id]);
  return { total: Number(result.rows[0]?.total_unread || 0), conversations: result.rows.map(row => ({
    id: String(row.id), name: row.kind === 'dm' ? row.peer_name || 'Direct message' : row.title || 'Group',
    count: Number(row.unread_count), latestAt: row.latest_at,
  })) };
}

export async function createChat(session: SessionUser, input: Record<string, unknown>) {
  chatUser(session);
  await ensureChatsSchema();
  const kind = input.kind;
  if (kind !== 'dm' && kind !== 'group') throw new ApiError('Choose a group or direct message', 400, 'invalid_kind');
  const ids = kind === 'dm' ? [id(input.userId, 'person')] : Array.isArray(input.userIds) ? input.userIds.map((value) => id(value, 'person')) : [];
  const participants = [...new Set(ids.filter((value) => value !== session.id))];
  if (kind === 'dm' && participants.length !== 1) throw new ApiError('Choose one person', 400, 'invalid_members');
  if (kind === 'group' && (participants.length < 2 || participants.length > 25)) throw new ApiError('Choose 2 to 25 people for a group', 400, 'invalid_members');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (kind === 'group' && (title.length < 2 || title.length > 80 || /[\u0000-\u001f\u007f]/.test(title))) throw new ApiError('Enter a group name of 2 to 80 characters', 400, 'invalid_title');
  const db = await getPool().connect();
  try {
    await db.query('begin');
    const approved = await db.query(`select id from app_users where id=any($1::bigint[]) and company_id=$2 and approval_status='approved' and account_type in ('admin','client','engineer')`, [participants, session.company_id]);
    if (approved.rows.length !== participants.length) throw new ApiError('One or more people are unavailable', 400, 'invalid_members');
    let conversationId: string;
    if (kind === 'dm') {
      const dmKey = [session.id, participants[0]].sort((a, b) => Number(a) - Number(b)).join(':');
      const inserted = await db.query(`insert into chat_conversations(company_id,kind,dm_key,created_by)
        values($1,'dm',$2,$3) on conflict(dm_key) do nothing returning id`, [session.company_id, dmKey, session.id]);
      conversationId = inserted.rows[0]?.id;
      if (!conversationId) {
        const existing = await db.query(`select id from chat_conversations where dm_key=$1 and company_id=$2`, [dmKey, session.company_id]);
        if (!existing.rows[0]) throw new ApiError('Conversation not available', 404, 'not_found');
        conversationId = existing.rows[0].id;
      }
    } else {
      const inserted = await db.query(`insert into chat_conversations(company_id,kind,title,created_by) values($1,'group',$2,$3) returning id`, [session.company_id, title, session.id]);
      conversationId = inserted.rows[0].id;
    }
    await db.query(`insert into chat_conversation_members(conversation_id,user_id)
      select $1,id from app_users where id=any($2::bigint[]) on conflict do nothing`, [conversationId, [session.id, ...participants]]);
    if (kind === 'group') await db.query(`update chat_conversation_members set is_admin=true where conversation_id=$1 and user_id=$2`, [conversationId, session.id]);
    await db.query(`update chat_conversation_members set hidden_at=null where conversation_id=$1 and user_id=$2`, [conversationId, session.id]);
    await db.query('commit');
    return { id: conversationId };
  } catch (error) {
    await db.query('rollback');
    throw error;
  } finally { db.release(); }
}

export async function listChatMessages(session: SessionUser, value: unknown) {
  chatUser(session);
  await ensureChatsSchema();
  const conversationId = id(value, 'conversation');
  const db = getPool();
  await memberConversation(db, session, conversationId);
  const result = await db.query(`select msg.id,msg.parent_message_id,case when msg.deleted_at is null then msg.body else 'Message deleted' end as body,msg.created_at,msg.edited_at,msg.deleted_at,msg.sender_id,
    case when parent.deleted_at is null then parent.body else 'Message deleted' end as parent_body,
    coalesce(nullif(u.display_name,''),split_part(u.email,'@',1)) as sender_name
    from chat_messages msg join app_users u on u.id=msg.sender_id and u.company_id=$3
    left join chat_messages parent on parent.conversation_id=msg.conversation_id and parent.id=msg.parent_message_id
    join chat_conversation_members mine on mine.conversation_id=msg.conversation_id and mine.user_id=$2
    where msg.conversation_id=$1 and (mine.cleared_at is null or msg.created_at>mine.cleared_at)
    order by msg.id desc limit 150`, [conversationId, session.id, session.company_id]);
  await db.query(`update chat_conversation_members set last_read_at=now() where conversation_id=$1 and user_id=$2`, [conversationId, session.id]);
  return result.rows.reverse();
}

export async function sendChatMessage(session: SessionUser, value: unknown, input: Record<string, unknown>) {
  chatUser(session);
  await ensureChatsSchema();
  const conversationId = id(value, 'conversation');
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body || body.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) throw new ApiError('Write a message up to 4,000 characters', 400, 'invalid_message');
  const parent = input.parentMessageId == null ? null : id(input.parentMessageId, 'message');
  const db = getPool();
  await memberConversation(db, session, conversationId);
  if (parent) {
    const quoted = await db.query(`select id from chat_messages where conversation_id=$1 and id=$2 and deleted_at is null`, [conversationId, parent]);
    if (!quoted.rows[0]) throw new ApiError('Message not found', 404, 'not_found');
  }
  const result = await db.query(`insert into chat_messages(conversation_id,sender_id,parent_message_id,body) values($1,$2,$3,$4)
    returning id,parent_message_id,body,created_at,sender_id`, [conversationId, session.id, parent, body]);
  await db.query(`update chat_conversations set updated_at=now() where id=$1`, [conversationId]);
  await db.query(`update chat_conversation_members set last_read_at=now() where conversation_id=$1 and user_id=$2`, [conversationId, session.id]);
  return result.rows[0];
}

export async function editChatMessage(session: SessionUser, conversationValue: unknown, messageValue: unknown, input: Record<string, unknown>) {
  chatUser(session);
  await ensureChatsSchema();
  const conversationId = id(conversationValue, 'conversation');
  const messageId = id(messageValue, 'message');
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body || body.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) throw new ApiError('Write a message up to 4,000 characters', 400, 'invalid_message');
  const db = getPool();
  await memberConversation(db, session, conversationId);
  const result = await db.query(`update chat_messages set body=$4,edited_at=now() where id=$1 and conversation_id=$2 and sender_id=$3 and deleted_at is null
    returning id,body,edited_at`, [messageId, conversationId, session.id, body]);
  if (!result.rows[0]) throw new ApiError('Message not found or not editable', 404, 'not_found');
  return result.rows[0];
}

export async function deleteChatMessage(session: SessionUser, conversationValue: unknown, messageValue: unknown) {
  chatUser(session);
  await ensureChatsSchema();
  const conversationId = id(conversationValue, 'conversation');
  const messageId = id(messageValue, 'message');
  const db = getPool();
  await memberConversation(db, session, conversationId);
  const result = await db.query(`update chat_messages set body='Message deleted',deleted_at=now() where id=$1 and conversation_id=$2 and sender_id=$3 and deleted_at is null returning id`, [messageId, conversationId, session.id]);
  if (!result.rows[0]) throw new ApiError('Message not found or already deleted', 404, 'not_found');
  return { id: String(result.rows[0].id) };
}

export async function promoteGroupAdmin(session: SessionUser, value: unknown, memberValue: unknown) {
  chatUser(session);
  await ensureChatsSchema();
  const conversationId = id(value, 'conversation');
  const memberId = id(memberValue, 'member');
  const db = getPool();
  const conversation = await memberConversation(db, session, conversationId);
  if (conversation.kind !== 'group' || !conversation.is_admin) throw new ApiError('Only a group admin can manage admins', 403, 'forbidden');
  const result = await db.query(`update chat_conversation_members set is_admin=true
    where conversation_id=$1 and user_id=$2 returning user_id`, [conversationId, memberId]);
  if (!result.rows[0]) throw new ApiError('Group member not found', 404, 'not_found');
  return { id: String(result.rows[0].user_id) };
}

export async function deleteChat(session: SessionUser, value: unknown) {
  chatUser(session);
  await ensureChatsSchema();
  const conversationId = id(value, 'conversation');
  const db = getPool();
  const conversation = await memberConversation(db, session, conversationId);
  if (conversation.kind === 'group') {
    if (!conversation.is_admin) throw new ApiError('Only a group admin can delete this group', 403, 'forbidden');
    const result = await db.query(`delete from chat_conversations c where c.id=$1 and c.kind='group'
      and exists (select 1 from chat_conversation_members m where m.conversation_id=c.id and m.user_id=$2 and m.is_admin)
      returning c.id`, [conversationId, session.id]);
    if (!result.rows[0]) throw new ApiError('Group not found or not permitted', 403, 'forbidden');
    return { id: conversationId, deletedForEveryone: true };
  }
  await db.query(`update chat_conversation_members set hidden_at=now(),cleared_at=now(),last_read_at=now() where conversation_id=$1 and user_id=$2`, [conversationId, session.id]);
  return { id: conversationId, deletedForEveryone: false };
}
