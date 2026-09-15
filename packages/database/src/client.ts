import { Pool } from "pg";

export function createDatabasePool(databaseUrl: string): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 3000,
  });

  pool.on("error", (error) => {
    console.error(
      JSON.stringify({
        level: "error",
        event: "database.pool.idle_error",
        message: error.message,
      }),
    );
  });

  return pool;
}

export async function closeDatabasePool(pool: Pool): Promise<void> {
  await pool.end();
}
