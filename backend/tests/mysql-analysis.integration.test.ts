import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { mockGeminiUnavailable } from './mock-ai-network.js';

test('MySQL analysis stores four memberships, grounded findings and severity without changing schema', {
  skip: process.env.RUN_MYSQL_ANALYSIS_TESTS !== '1',
}, async context => {
  mockGeminiUnavailable(context);
  const { app } = await import('../src/app.js');
  const { pool } = await import('../src/config/db.js');
  assert.ok(pool);
  try {
    const marker = randomUUID();
    let upload = request(app).post('/api/documents/upload');
    for (let i = 1; i <= 4; i++) upload = upload.attach('files', Buffer.from(
      `Synthetic document reference: ${marker}-${i}\nCompany: Synthetic ${marker}\nAnnual revenue: INR ${i === 2 ? '3000000' : '2500000'}\n${i === 4 ? '' : 'Registered address: 12 Sample Road\n'}`,
    ), `synthetic-analysis-${i}.txt`);
    const uploaded = await upload;
    assert.equal(uploaded.status, 201);
    const ids = uploaded.body.results.map((result: { document: { id: string } }) => result.document.id);
    const response = await request(app).post('/api/analysis').send({
      documentIds: ids, instruction: 'Compare company names, revenue and addresses. Identify missing information.',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.documents.length, 4);
    assert.ok(!response.body.findings.some((finding: { type: string }) => finding.type === 'discrepancy'));
    const retrieved = await request(app).get(`/api/analysis/${response.body.id}`);
    assert.equal(retrieved.status, 200);
    assert.deepEqual(retrieved.body, response.body);
    const [members] = await pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM analysis_documents WHERE analysis_session_id = ?', [response.body.id],
    );
    assert.equal(String(members[0]!.total), '4');
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT f.source_evidence, f.structured_value, d.extracted_text FROM findings f
       JOIN documents d ON d.id = f.source_document_id WHERE f.analysis_session_id = ?`, [response.body.id],
    );
    assert.ok(rows.length);
    for (const row of rows) {
      const evidence = typeof row.source_evidence === 'string' ? JSON.parse(row.source_evidence) : row.source_evidence;
      const value = typeof row.structured_value === 'string' ? JSON.parse(row.structured_value) : row.structured_value;
      assert.ok(value.severity);
      for (const source of evidence) assert.equal(row.extracted_text.slice(source.char_start, source.char_end), source.quote);
    }
  } finally { await pool.end(); }
});
