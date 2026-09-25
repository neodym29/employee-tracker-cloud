import pg from 'pg';
const db=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000});
await db.connect();
try {
 await db.query('begin read only');
 await db.query("set local statement_timeout='10s'");
 const status=(await db.query(`select c.id,c.device_id,c.matched_project_id,c.revision,c.tracking_state,s.desired_tracking,s.completed_at,s.claimed_at,d.last_seen_at,exists(select 1 from tracemini_tracked_repositories t where t.candidate_id=c.id) as tracked_registration from tracemini_repository_candidates c join tracemini_repository_selections s on s.candidate_id=c.id join files_agent_devices d on d.id=c.device_id where c.device_id=4 and c.id in (1,66)`)).rows;
 const registration=(await db.query('select candidate_id,revision,created_at from tracemini_node_registrations where candidate_id in (1,66)')).rows;
 console.log(JSON.stringify({observed_at:new Date().toISOString(),status,registration},null,2));
 await db.query('rollback');
} finally {await db.end();}
