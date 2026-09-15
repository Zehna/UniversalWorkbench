import { checkDatabaseReady, closeDatabasePool, createDatabasePool } from '@uw/database';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);

if (config.appMode === 'worker') {
  console.log('Phase 0 worker mode validated; no worker jobs are registered yet.');
} else {
  const pool = createDatabasePool(config.databaseUrl);
  const app = createApp({ databaseReady: () => checkDatabaseReady(pool) });
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`Universal Workbench API listening on port ${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(async () => {
      await closeDatabasePool(pool);
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
