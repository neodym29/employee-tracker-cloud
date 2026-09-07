import {describe, expect, it} from 'vitest';
import {openPostgresDb} from '../apps/server/src/db.js';

describe('serverless database startup', () => {
  it('can create a lazy pool without running migrations during request initialization', async () => {
    const db = await openPostgresDb('postgresql://postgres:postgres@127.0.0.1:1/postgres', {migrate: false});
    await expect(db.close()).resolves.toBeUndefined();
  });
});