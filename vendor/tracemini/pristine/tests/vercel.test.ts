import {afterEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {openTestDb} from '../apps/server/src/test-db.js';
import type {DB} from '../apps/server/src/db.js';
import {createVercelHandler} from '../apps/server/src/vercel.js';

let db: DB | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe('Vercel serverless entrypoint', () => {
  it('initializes the database once and serves repeated API requests through Express', async () => {
    db = await openTestDb();
    let opens = 0;
    const handler = createVercelHandler({
      openDb: async () => {
        opens++;
        return db!;
      },
    });

    await request(handler).get('/api/health').expect(200, {ok: true, database: 'ready'});
    await request(handler).get('/api/health').expect(200, {ok: true, database: 'ready'});
    expect(opens).toBe(1);
  });
});
