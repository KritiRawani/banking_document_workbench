import { Router } from 'express';
import { checkDatabaseConnection } from '../config/db.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'banking-document-workbench-api' });
});

healthRouter.get('/db', async (_req, res) => {
  const health = await checkDatabaseConnection();
  res.set('Cache-Control', 'no-store');
  res.status(health.status === 'ok' ? 200 : 503).json(health);
});
