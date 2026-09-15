import { Router } from 'express';
import type { AppDependencies } from '../app.js';

export function createHealthRouter(deps: AppDependencies): Router {
  const router = Router();

  router.get('/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res, next) => {
    try {
      const ready = await deps.databaseReady();
      if (!ready) {
        res.status(503).json({
          status: 'not_ready',
          checks: { database: 'error' }
        });
        return;
      }

      res.status(200).json({
        status: 'ready',
        checks: { database: 'ok' }
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
