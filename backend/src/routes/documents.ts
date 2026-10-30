import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { UploadError } from '../documents/errors.js';
import { createStagingDirectory, removeStagingDirectory } from '../documents/storage.js';
import { DocumentService, MAX_FILE_BYTES, MAX_FILES } from '../documents/service.js';
import type { UploadResult } from '../documents/types.js';

export function createDocumentRouter(service: DocumentService, storageRoot: string): Router {
  const router = Router();
  // Bound total simultaneous uploads/parsers per API process.
  let activeRequests = 0;
  router.post('/upload', async (req, res, next) => {
    if (!req.is('multipart/form-data')) {
      res.status(415).json({ error: { code: 'EXPECTED_MULTIPART', message: 'Use multipart/form-data with a files field.' } });
      return;
    }
    if (activeRequests >= 2) {
      res.status(503).json({ error: { code: 'UPLOAD_BUSY', message: 'Upload capacity reached. Retry shortly.' } });
      return;
    }
    activeRequests++;
    let staging: string | undefined;
    try {
      staging = await createStagingDirectory(storageRoot);
      const upload = multer({
        storage: multer.diskStorage({ destination: staging, filename: (_req, _file, callback) => callback(null, randomUUID()) }),
        limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 0, parts: MAX_FILES, fieldNameSize: 64, headerPairs: 100 },
      }).array('files', MAX_FILES);
      try {
        await new Promise<void>((resolve, reject) => upload(req, res, error => error ? reject(error) : resolve()));
      } catch (error) {
        if (error instanceof multer.MulterError) throw error;
        throw new UploadError('INVALID_MULTIPART', 'Upload request is malformed or incomplete.', 400);
      }
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files?.length) throw new UploadError('NO_FILES', 'Upload at least one PDF or TXT file in the files field.', 400);
      const results: UploadResult[] = [];
      for (const file of files) results.push(await service.process(file));
      const allReady = results.every(result => result.outcome === 'ready');
      const allDuplicates = results.every(result => result.outcome === 'duplicate');
      const allInvalid = results.every(result => result.outcome === 'failed' || result.outcome === 'rejected');
      await removeStagingDirectory(staging, storageRoot);
      staging = undefined;
      res.status(allReady ? 201 : allDuplicates ? 200 : allInvalid ? 422 : 207).json({ results });
    } catch (error) {
      if (error instanceof multer.MulterError) {
        const tooLarge = error.code === 'LIMIT_FILE_SIZE';
        res.status(tooLarge ? 413 : 400).json({ error: {
          code: tooLarge ? 'FILE_TOO_LARGE' : 'INVALID_MULTIPART',
          message: tooLarge ? 'Each file must be at most 10 MiB.' : 'Use at most five files in the files field and no other fields.',
        } });
      } else if (error instanceof UploadError) {
        res.status(error.status).json({ error: { code: error.code, message: error.message } });
      } else next(new UploadError('STORAGE_UNAVAILABLE', 'Upload storage is unavailable.', 503));
    } finally {
      if (staging) {
        try { await removeStagingDirectory(staging, storageRoot); }
        catch { console.error('Unable to clean upload staging directory.'); }
      }
      activeRequests--;
    }
  });
  return router;
}
