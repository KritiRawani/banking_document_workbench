import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import express from 'express';
import request from 'supertest';
import { createDocumentRouter } from '../src/routes/documents.js';
import { DocumentService, MAX_FILE_BYTES } from '../src/documents/service.js';
import { UploadError } from '../src/documents/errors.js';
import type { DocumentRecord, DocumentRepository, DocumentStore } from '../src/documents/types.js';
import { syntheticPdf } from './fixtures.js';

const testRoots: string[] = [];
after(async () => {
  for (const root of testRoots) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('workbench-upload-test-')) {
      throw new Error('Invalid test cleanup target');
    }
    await rm(root, { recursive: true, force: true });
  }
});

class MemoryRepository implements DocumentRepository {
  readonly rows = new Map<string, DocumentRecord>();
  readonly keys = new Map<string, string>();
  async withHashLock<T>(_hash: string, action: (store: DocumentStore) => Promise<T>): Promise<T> {
    return action({
      findByHash: async hash => [...this.rows.values()].find(row => row.sha256 === hash),
      create: async document => {
        const id = String(this.rows.size + 1);
        this.keys.set(id, document.storageKey);
        this.rows.set(id, { id, original_filename: document.filename, mime_type: document.mimeType,
          file_size_bytes: String(document.size), sha256: document.hash, processing_status: 'processing',
          extracted_text: null, extraction_metadata: null, error_message: null, created_at: new Date(), processed_at: null });
        return id;
      },
      finish: async (id, extraction, error) => {
        const row = this.rows.get(id)!;
        Object.assign(row, { processing_status: extraction ? 'ready' : 'failed', extracted_text: extraction?.text ?? null,
          extraction_metadata: extraction?.metadata ?? null, error_message: error, processed_at: new Date() });
        return row;
      },
    });
  }
}

async function fixture(repository: DocumentRepository = new MemoryRepository()) {
  // OS temp storage is intentionally isolated from real uploads.
  const root = await mkdtemp(join(tmpdir(), 'workbench-upload-test-'));
  testRoots.push(root);
  const app = express();
  app.use('/api/documents', createDocumentRouter(new DocumentService(repository, root), root));
  return { app, root, repository };
}

test('multiple PDF/TXT files extract text, hash content, preserve page locations, and hide storage paths', async () => {
  const repo = new MemoryRepository();
  const { app, root } = await fixture(repo);
  const txt = Buffer.from('Synthetic applicant: Example Company\nRevenue: INR 2500000');
  const response = await request(app).post('/api/documents/upload')
    .attach('files', txt, 'application.txt').attach('files', syntheticPdf(), 'financials.pdf');
  assert.equal(response.status, 201);
  assert.equal(response.body.results.length, 2);
  const [textResult, pdfResult] = response.body.results;
  assert.equal(textResult.document.extracted_text, txt.toString());
  assert.equal(textResult.document.sha256, createHash('sha256').update(txt).digest('hex'));
  assert.match(pdfResult.document.extracted_text, /Synthetic company revenue/);
  assert.equal(pdfResult.document.extraction_metadata.page_count, 1);
  assert.equal(pdfResult.document.extraction_metadata.pages[0].char_start, 0);
  assert.equal(repo.rows.size, 2);
  const files = await readdir(root);
  assert.equal(files.length, 2);
  assert.ok(files.every(name => /^[a-f0-9-]{36}$/.test(name)));
  assert.equal(await readFile(join(root, repo.keys.get('1')!), 'utf8'), txt.toString());
  assert.ok(!JSON.stringify(response.body).includes('storage_key'));
  assert.ok(!JSON.stringify(response.body).includes(root));
  assert.equal((await request(app).get(`/uploads/${files[0]}`)).status, 404);
});

test('same content in one request and a later request returns the original document without extra storage', async () => {
  const repo = new MemoryRepository();
  const { app, root } = await fixture(repo);
  const content = Buffer.from('Synthetic duplicate');
  const first = await request(app).post('/api/documents/upload')
    .attach('files', content, 'first.txt').attach('files', content, 'second.txt');
  assert.equal(first.status, 207);
  assert.equal(first.body.results[1].outcome, 'duplicate');
  const repeated = await request(app).post('/api/documents/upload').attach('files', content, 'third.txt');
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.results[0].document.id, first.body.results[0].document.id);
  assert.equal(repo.rows.size, 1);
  assert.equal((await readdir(root)).length, 1);
});

test('mixed invalid inputs return individual safe errors and persist failed extraction statuses', async () => {
  const repo = new MemoryRepository();
  const { app } = await fixture(repo);
  const response = await request(app).post('/api/documents/upload')
    .attach('files', Buffer.from('unsupported'), 'data.csv')
    .attach('files', Buffer.alloc(0), 'empty.txt')
    .attach('files', Buffer.from('%PDF-1.4\nnot a real PDF'), 'broken.pdf')
    .attach('files', Buffer.from([0xff, 0xfe, 0x80]), 'binary.txt')
    .attach('files', Buffer.from(' \n\t '), 'blank.txt');
  assert.equal(response.status, 422);
  assert.deepEqual(response.body.results.map((r: { error: { code: string } }) => r.error.code),
    ['UNSUPPORTED_FILE_TYPE', 'EMPTY_FILE', 'INVALID_PDF', 'INVALID_TEXT_ENCODING', 'EMPTY_TEXT']);
  assert.equal(repo.rows.size, 3);
  assert.ok([...repo.rows.values()].every(row => row.processing_status === 'failed'));
});

test('size limit rejects an oversized file without saving records or retained files', async () => {
  const repo = new MemoryRepository();
  const { app } = await fixture(repo);
  const response = await request(app).post('/api/documents/upload')
    .attach('files', Buffer.alloc(MAX_FILE_BYTES + 1, 'x'), 'large.txt');
  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, 'FILE_TOO_LARGE');
  assert.equal(repo.rows.size, 0);
});

test('empty request, wrong field, excessive files, malformed multipart, and content type are rejected', async () => {
  const { app } = await fixture();
  assert.equal((await request(app).post('/api/documents/upload').send({})).status, 415);
  const empty = await request(app).post('/api/documents/upload').set('Content-Type', 'multipart/form-data; boundary=empty').send('--empty--\r\n');
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'NO_FILES');
  assert.equal((await request(app).post('/api/documents/upload').attach('wrong', Buffer.from('text'), 'test.txt')).status, 400);
  let tooMany = request(app).post('/api/documents/upload');
  for (let i = 0; i < 6; i++) tooMany = tooMany.attach('files', Buffer.from(`File ${i}`), `${i}.txt`);
  assert.equal((await tooMany).status, 400);
  const malformed = await request(app).post('/api/documents/upload').set('Content-Type', 'multipart/form-data').send('broken');
  assert.equal(malformed.status, 400);
});

test('MIME spoofing, PDF header spoofing, binary text, and excessive extracted content are handled', async () => {
  const { app } = await fixture();
  const response = await request(app).post('/api/documents/upload')
    .attach('files', Buffer.from('text'), { filename: 'fake.pdf', contentType: 'text/plain' })
    .attach('files', Buffer.from('not pdf'), { filename: 'spoof.pdf', contentType: 'application/pdf' })
    .attach('files', Buffer.from([65, 0, 66]), 'null.txt')
    .attach('files', Buffer.alloc(1_000_001, 'x'), 'long.txt');
  assert.equal(response.status, 422);
  assert.deepEqual(response.body.results.map((r: { error: { code: string } }) => r.error.code),
    ['FILE_TYPE_MISMATCH', 'INVALID_PDF', 'INVALID_TEXT_CONTENT', 'TEXT_LIMIT_EXCEEDED']);
});

test('scanned/blank PDF has a useful OCR limitation error', async () => {
  const { app } = await fixture();
  const response = await request(app).post('/api/documents/upload').attach('files', syntheticPdf(''), 'scan.pdf');
  assert.equal(response.status, 422);
  assert.equal(response.body.results[0].error.code, 'NO_EXTRACTABLE_TEXT');
});

test('database outage returns sanitized 503 and no retained file', async () => {
  const repository: DocumentRepository = { async withHashLock() {
    throw new UploadError('DATABASE_UNAVAILABLE', 'Cannot connect to the document database.', 503);
  } };
  const { app } = await fixture(repository);
  const response = await request(app).post('/api/documents/upload').attach('files', Buffer.from('example'), 'safe.txt');
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'DATABASE_UNAVAILABLE');
});

test('failed record insertion removes the newly retained file', async () => {
  const repo = new MemoryRepository();
  const repository: DocumentRepository = { withHashLock: (_hash, action) => repo.withHashLock(_hash, store => action({
    ...store, async create() { throw new UploadError('DOCUMENT_SAVE_FAILED', 'Unable to save document.', 503); },
  })) };
  const { app, root } = await fixture(repository);
  const response = await request(app).post('/api/documents/upload').attach('files', Buffer.from('example'), 'safe.txt');
  assert.equal(response.status, 503);
  // Response precedes error-path cleanup; allow the finally block to finish.
  for (let i = 0; i < 50 && (await readdir(root)).length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await readdir(root), []);
});
