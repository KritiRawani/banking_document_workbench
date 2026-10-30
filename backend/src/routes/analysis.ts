import { Router } from 'express';
import { AnalysisError } from '../analysis/types.js';
import type { AnalysisService } from '../analysis/service.js';

export function createAnalysisRouter(service: AnalysisService): Router {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  let active = 0;
  router.post('/', async (req, res) => {
    if (active >= 1) {
      res.status(503).json({ error: { code: 'ANALYSIS_BUSY', message: 'Another analysis is running. Please retry shortly.' } });
      return;
    }
    active++;
    try { res.status(201).json(await service.analyse(req.body)); }
    catch (error) { sendError(res, error); }
    finally { active--; }
  });
  router.get('/:id', async (req, res) => {
    try { res.json(await service.get(req.params.id as string)); }
    catch (error) { sendError(res, error); }
  });
  return router;
}

function sendError(res: import('express').Response, error: unknown) {
  const safe = error instanceof AnalysisError ? error : new AnalysisError('ANALYSIS_FAILED', 'Analysis could not be completed.', 500);
  res.set('Cache-Control', 'no-store').status(safe.status).json({ error: { code: safe.code, message: safe.message } });
}
