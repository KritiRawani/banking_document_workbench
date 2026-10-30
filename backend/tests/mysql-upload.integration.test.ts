import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { syntheticPdf } from './fixtures.js';
import { mockGeminiUnavailable } from './mock-ai-network.js';

// Opt-in: adds two synthetic documents and their files; performs no DDL or deletes.
test('real MySQL upload persists metadata/text/status and concurrent duplicate checks reuse a row', {
  skip: process.env.RUN_MYSQL_UPLOAD_TESTS !== '1',
}, async context => {
  mockGeminiUnavailable(context);
  const { app } = await import('../src/app.js');
  const { pool } = await import('../src/config/db.js');
  const { uploadRoot } = await import('../src/documents/storage.js');
  assert.ok(pool, 'MYSQL_URL must be configured in backend/.env');
  try {
    const marker = randomUUID();
    const txt = Buffer.from(`Synthetic integration applicant ${marker}\nRevenue INR 2500000`);
    const response = await request(app).post('/api/documents/upload')
      .attach('files', txt, 'synthetic-integration.txt')
      .attach('files', syntheticPdf(`Synthetic integration company ${marker}`), 'synthetic-integration.pdf');
    assert.equal(response.status, 201);
    const ids = response.body.results.map((result: { document: { id: string } }) => result.document.id);
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id, original_filename, storage_key, mime_type,
       file_size_bytes, sha256, extracted_text, processing_status, processed_at
       FROM documents WHERE id IN (?, ?) ORDER BY id`, ids,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.sha256, createHash('sha256').update(txt).digest('hex'));
    assert.equal(rows[0]!.extracted_text, txt.toString());
    assert.equal(String(rows[0]!.file_size_bytes), String(txt.length));
    assert.ok(rows.every(row => row.processing_status === 'ready' && row.processed_at));
    assert.equal(await readFile(join(uploadRoot, String(rows[0]!.storage_key)), 'utf8'), txt.toString());
    assert.ok(!JSON.stringify(response.body).includes('storage_key'));
    const duplicates = await Promise.all([1, 2].map(() => request(app).post('/api/documents/upload')
      .attach('files', txt, 'repeated.txt')));
    for (const duplicate of duplicates) {
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.body.results[0].outcome, 'duplicate');
      assert.equal(duplicate.body.results[0].document.id, rows[0]!.id);
    }
    const [counts] = await pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM documents WHERE sha256 = ?', [rows[0]!.sha256],
    );
    assert.equal(String(counts[0]!.total), '1');
  } finally { await pool.end(); }
});
