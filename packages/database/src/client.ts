import { Pool } from "pg";

export function createDatabasePool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

export async function closeDatabasePool(pool: Pool): Promise<void> {
  await pool.end();
}
