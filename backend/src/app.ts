import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { healthRouter } from './routes/health.js';
import { pool } from './config/db.js';
import { MysqlDocumentRepository } from './documents/repository.js';
import { DocumentService } from './documents/service.js';
import { uploadRoot } from './documents/storage.js';
import { UploadError } from './documents/errors.js';
import { createDocumentRouter } from './routes/documents.js';
import { createAnalysisRouter } from './routes/analysis.js';
import { createConfiguredAnalysisService } from './analysis/factory.js';
import { MysqlAnalysisRepository } from './analysis/repository.js';

export const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: env.CLIENT_ORIGIN }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/health', healthRouter);
app.use('/api/documents', createDocumentRouter(new DocumentService(new MysqlDocumentRepository(pool), uploadRoot), uploadRoot));
app.use('/api/analysis', createAnalysisRouter(createConfiguredAnalysisService(new MysqlAnalysisRepository(pool), env)));
app.use((_req, res) => { res.status(404).json({ message: 'Route not found' }); });
const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof UploadError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
  if (status === 400 || status === 413) {
    res.status(status).json({ message: status === 413 ? 'Request body is too large' : 'Invalid JSON request body' });
    return;
  }
  console.error('Unhandled API error');
  res.status(500).json({ message: 'Internal server error' });
};
app.use(errorHandler);
