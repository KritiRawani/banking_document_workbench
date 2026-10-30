import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { UploadError } from './errors.js';
import { extractPdf, extractTxt } from './extract.js';
import { removeFile, retainFile } from './storage.js';
import type { DocumentRepository, UploadResult } from './types.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 5;

function safeFilename(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop()!.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 255) || 'document';
}

function validateType(file: Express.Multer.File): 'application/pdf' | 'text/plain' {
  const extension = extname(file.originalname).toLowerCase();
  if (extension !== '.pdf' && extension !== '.txt') {
    throw new UploadError('UNSUPPORTED_FILE_TYPE', 'Only PDF and TXT documents are supported.', 415);
  }
  const expected = extension === '.pdf' ? 'application/pdf' : 'text/plain';
  if (file.mimetype !== expected && file.mimetype !== 'application/octet-stream') {
    throw new UploadError('FILE_TYPE_MISMATCH', 'File extension and declared content type do not match.', 415);
  }
  return expected;
}

export class DocumentService {
  constructor(private readonly repository: DocumentRepository, private readonly storageRoot: string) {}

  async process(file: Express.Multer.File): Promise<UploadResult> {
    const filename = safeFilename(file.originalname);
    try {
      const mimeType = validateType(file);
      if (file.size === 0) throw new UploadError('EMPTY_FILE', 'Empty files cannot be uploaded.', 400);
      if (file.size > MAX_FILE_BYTES) throw new UploadError('FILE_TOO_LARGE', 'Each file must be at most 10 MiB.', 413);
      const buffer = await readFile(file.path);
      const hash = createHash('sha256').update(buffer).digest('hex');
      return await this.repository.withHashLock(hash, async store => {
        const existing = await store.findByHash(hash);
        if (existing) return { filename, outcome: 'duplicate', document: existing };
        const stored = await retainFile(file.path, this.storageRoot);
        let id: string;
        try { id = await store.create({ filename, storageKey: stored.key, mimeType, size: file.size, hash }); }
        catch (error) { await removeFile(stored.path); throw error; }
        try {
          const extraction = mimeType === 'application/pdf' ? await extractPdf(buffer) : extractTxt(buffer);
          const document = await store.finish(id, extraction, null);
          return { filename, outcome: 'ready', document };
        } catch (error) {
          if (!(error instanceof UploadError) || error.status === 503) throw error;
          const document = await store.finish(id, null, error.message);
          return { filename, outcome: 'failed', document, error: { code: error.code, message: error.message } };
        }
      });
    } catch (error) {
      const safe = error instanceof UploadError ? error : new UploadError('UPLOAD_FAILED', 'Document upload could not be completed.', 503);
      if (safe.status === 503) throw safe;
      return { filename, outcome: 'rejected', error: { code: safe.code, message: safe.message } };
    }
  }
}
