import { afterAll, describe, expect, it } from 'vitest';
import {
  checkDatabaseReady,
  closeDatabasePool,
  createDatabasePool
} from '../src/index.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');

const pool = createDatabasePool(databaseUrl);

afterAll(async () => {
  await closeDatabasePool(pool);
});

describe('database health', () => {
  it('executes a real PostgreSQL readiness query', async () => {
    await expect(checkDatabaseReady(pool)).resolves.toBe(true);
  });
});
