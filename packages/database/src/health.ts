import type { Pool } from 'pg';

export async function checkDatabaseReady(pool: Pool): Promise<boolean> {
  try {
    const result = await pool.query<{ ready: number }>('select 1 as ready');
    return result.rows[0]?.ready === 1;
  } catch {
    return false;
  }
}
