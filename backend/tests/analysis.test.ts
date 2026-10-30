import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import request from 'supertest';
import { createAnalysisRouter } from '../src/routes/analysis.js';
import { AnalysisService, documentChunks, groundFact } from '../src/analysis/service.js';
import { GeminiAnalysisProvider, MockAnalysisProvider } from '../src/analysis/providers.js';
import { AnalysisError, type AnalysisDocument, type AnalysisProvider, type AnalysisRepository, type AnalysisResult } from '../src/analysis/types.js';

export const exampleDocuments: AnalysisDocument[] = [1, 2, 3, 4].map(id => ({
  id: String(id), name: `synthetic-${id}.txt`, status: 'ready', metadata: null,
  text: `Company: Example Trading\nAnnual revenue: INR ${id === 2 ? '3000000' : '2500000'}\n${id === 4 ? '' : 'Registered address: 12 Sample Road\n'}`,
}));

export class MemoryAnalysisRepository implements AnalysisRepository {
  records = new Map<string, AnalysisResult>();
  started = 0;
  failed: string[] = [];
  constructor(public documents: AnalysisDocument[] = exampleDocuments.map(doc => ({ ...doc }))) {}
  async loadDocuments(ids: string[]) { return this.documents.filter(doc => ids.includes(doc.id)); }
  async start() { this.started++; return String(this.started); }
  async complete(result: AnalysisResult) { this.records.set(result.id, result); }
  async fail(id: string) { this.failed.push(id); }
  async get(id: string) { return this.records.get(id); }
}

function fixture(repo = new MemoryAnalysisRepository(), provider: AnalysisProvider = new MockAnalysisProvider()) {
  const app = express();
  app.use(express.json());
  const service = new AnalysisService(repo, provider);
  app.use('/api/analysis', createAnalysisRouter(service));
  return { app, service, repo };
}
const input = { documentIds: ['1', '2', '3', '4'], instruction: 'Compare company names, addresses and revenue. Identify missing information.' };

test('four documents yield individual and collective findings, scoped missing data, severity, and exact source evidence', async () => {
  const { app, repo } = fixture();
  const response = await request(app).post('/api/analysis').send(input);
  assert.equal(response.status, 201);
  const result = response.body as AnalysisResult;
  assert.equal(result.documents.length, 4);
  assert.equal(result.instruction, input.instruction);
  assert.equal(result.mode, 'mock');
  assert.equal(result.findings.filter(finding => finding.type === 'summary').length, 4);
  assert.equal(result.findings.filter(finding => finding.type === 'discrepancy').length, 0);
  assert.ok(result.findings.some(finding => finding.type === 'comparison'));
  assert.ok(result.findings.some(finding => finding.type === 'missing_information' && finding.sources[0]?.documentId === '4'));
  for (const finding of result.findings) {
    assert.ok(finding.severity);
    for (const source of finding.sources) {
      const document = exampleDocuments.find(doc => doc.id === source.documentId)!;
      assert.equal(source.documentName, document.name);
      if (source.quote !== null) assert.equal(document.text.slice(source.charStart!, source.charEnd!), source.quote);
      else assert.equal(finding.type, 'missing_information');
    }
  }
  assert.equal(repo.records.size, 1);
  const stored = await request(app).get(`/api/analysis/${result.id}`);
  assert.equal(stored.status, 200);
  assert.deepEqual(stored.body, result);
});

test('specific instruction only returns requested revenue fields and no unrequested missing reports', async () => {
  const { service } = fixture();
  const result = await service.analyse({ ...input, instruction: 'Compare only annual revenue.' });
  assert.ok(result.findings.every(finding => finding.values.every(value => value.field === 'revenue')));
  assert.ok(!result.findings.some(finding => finding.type === 'missing_information'));
});

test('mock mode honours explicit field exclusions and requests without comparisons', async () => {
  const { service } = fixture();
  const result = await service.analyse({ ...input, instruction: 'Extract revenue. Ignore company names. No comparisons.' });
  assert.ok(result.findings.length > 0);
  assert.ok(result.findings.every(finding => finding.values.every(value => value.field === 'revenue')));
  assert.ok(!result.findings.some(finding => finding.type === 'comparison' || finding.type === 'discrepancy'));
});

test('malformed input, duplicates, missing and unready documents fail before session creation', async () => {
  const { app, repo } = fixture();
  for (const body of [{ ...input, instruction: ' ' }, { ...input, documentIds: ['1', '1'] }, { ...input, documentIds: ['../../x'] },
    { ...input, instruction: 'x'.repeat(4001) }, { ...input, unexpected: true }]) {
    assert.equal((await request(app).post('/api/analysis').send(body)).status, 400);
  }
  assert.equal((await request(app).post('/api/analysis').send({ ...input, documentIds: ['9'] })).status, 404);
  repo.documents[0]!.status = 'failed';
  assert.equal((await request(app).post('/api/analysis').send(input)).status, 409);
  assert.equal(repo.started, 0);
});

test('oversized content is rejected without silently dropping a document', async () => {
  const repo = new MemoryAnalysisRepository([{ ...exampleDocuments[0]!, text: 'x'.repeat(100001) }]);
  const { app } = fixture(repo);
  const response = await request(app).post('/api/analysis').send({ ...input, documentIds: ['1'] });
  assert.equal(response.status, 413);
  assert.equal(repo.started, 0);
});

test('invented values/quotes reject the entire result and mark the session failed', async () => {
  const provider = new MockAnalysisProvider();
  provider.extract = async () => [{ field: 'revenue', value: 'INR 99999999', quote: 'Annual revenue: INR 2500000' }];
  const { app, repo } = fixture(undefined, provider);
  const response = await request(app).post('/api/analysis').send(input);
  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'UNGROUNDED_AI_OUTPUT');
  assert.equal(repo.records.size, 0);
  assert.equal(repo.failed.length, 1);
});

test('invalid collective citations are rejected and no findings are saved', async () => {
  const provider = new MockAnalysisProvider();
  provider.compare = async () => [{ type: 'discrepancy', title: 'Unsupported', description: 'Unsupported', severity: 'high', factIds: ['made-up', 'fake'] }];
  const { app, repo } = fixture(undefined, provider);
  const response = await request(app).post('/api/analysis').send(input);
  assert.equal(response.status, 502);
  assert.equal(repo.records.size, 0);
});

test('collective interpretation cannot introduce an unsupported numerical value', async () => {
  const provider = new MockAnalysisProvider();
  provider.compare = async facts => [{ type: 'discrepancy', title: 'Unsupported rate', description: 'Default risk is 99%.', severity: 'high', factIds: facts.map(fact => fact.id) }];
  const { app, repo } = fixture(undefined, provider);
  const response = await request(app).post('/api/analysis').send(input);
  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'UNGROUNDED_AI_OUTPUT');
  assert.equal(repo.records.size, 0);
});

test('chunking preserves full lines, order and document content without truncation', () => {
  const text = Array.from({ length: 1000 }, (_, index) => `Annual revenue: INR ${index}\n`).join('');
  const chunks = documentChunks(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => chunk.length <= 12000 && chunk.endsWith('\n')));
  assert.throws(() => documentChunks('x'.repeat(12001)), (error: unknown) => error instanceof AnalysisError && error.code === 'ANALYSIS_SEGMENT_LIMIT');
});

test('PDF evidence gets page and character locators from stored extraction metadata', () => {
  const document = { ...exampleDocuments[0]!, metadata: { pages: [{ page: 1, char_start: 0, char_end: 1000 }] } };
  const fact = groundFact({ field: 'company', value: 'Example Trading', quote: 'Company: Example Trading' }, document);
  assert.equal(fact.evidence.page, 1);
  assert.equal(fact.evidence.charStart, 0);
});

test('unsupported mock instruction returns no invented facts and explains limitations', async () => {
  const { service } = fixture();
  const result = await service.analyse({ ...input, instruction: 'Who are the directors?' });
  assert.equal(result.findings.length, 0);
  assert.match(result.limitations.join(' '), /No relevant explicit facts/);
});

test('blank loan fields do not consume the next line and unrelated business fields are not reported missing', async () => {
  const repo = new MemoryAnalysisRepository([{ ...exampleDocuments[0]!,
    text: 'Company: Example Trading\nAnnual income:\nRegistered address: 12 Sample Road\nRequested loan amount: Not provided\nLicence number: Not provided\n' }]);
  const { service } = fixture(repo);
  const result = await service.analyse({ documentIds: ['1'], instruction: 'Extract income, addresses and requested loan amounts; identify missing information.' });
  assert.equal(result.findings.filter(finding => finding.type === 'key_value').length, 1);
  assert.equal(result.findings.find(finding => finding.type === 'key_value')!.values[0]!.field, 'address');
  const missing = result.findings.filter(finding => finding.type === 'missing_information');
  assert.ok(missing.some(finding => finding.title.startsWith('Annual income value not provided')));
  assert.ok(missing.some(finding => finding.sources[0]?.quote === 'Requested loan amount: Not provided'));
  assert.ok(!missing.some(finding => /licen[cs]e|revenue|profit/i.test(finding.title)));
  for (const finding of missing) {
    for (const source of finding.sources) if (source.quote !== null) assert.equal(repo.documents[0]!.text.slice(source.charStart!, source.charEnd!), source.quote);
  }
});

test('banking PDF table spacing and bulleted credit notes preserve exact values and detect income differences', async () => {
  const repo = new MemoryAnalysisRepository([
    { ...exampleDocuments[0]!, text: 'Loan Application\nField   Value\nApplicant   Example Person\nRequested loan amount   INR 1,500,000\nAnnual income   INR 1,200,000\nDeclared monthly obligations   INR 18,000\n' },
    { ...exampleDocuments[1]!, text: 'Income Verification\nApplicant   Example Person\nVerified annual income   INR 1,100,000\n' },
    { ...exampleDocuments[2]!, text: 'Credit notes\n- Verified annual income: INR 1,100,000\n' },
  ]);
  const { service } = fixture(repo);
  const result = await service.analyse({ documentIds: ['1', '2', '3'], instruction: 'Compare income and requested loan amounts and obligations.' });
  assert.ok(result.findings.some(finding => finding.type === 'key_value' && finding.values[0]?.field === 'loan' && finding.values[0]?.value === 'INR 1,500,000'));
  assert.ok(!result.findings.some(finding => finding.type === 'discrepancy'));
  assert.ok(result.findings.some(finding => finding.sources.some(source => source.quote === '- Verified annual income: INR 1,100,000')));
  for (const finding of result.findings) for (const source of finding.sources) if (source.quote !== null) {
    assert.equal(repo.documents.find(doc => doc.id === source.documentId)!.text.slice(source.charStart!, source.charEnd!), source.quote);
  }
});

test('Gemini adapter uses structured output, exact instruction and per-document boundaries without leaking keys', async () => {
  let calls = 0;
  const transport: typeof fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.ok(body.contents[0].parts[0].text.includes('Only revenue'));
    assert.equal(JSON.parse(body.contents[0].parts[1].text).documentId, '1');
    return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ facts: [
      { field: 'revenue', value: 'INR 2500000', quote: 'Annual revenue: INR 2500000' },
    ] }) }] } }] }), { status: 200 });
  };
  const provider = new GeminiAnalysisProvider('synthetic-test-key', 'test-model', transport);
  const result = await provider.extract(exampleDocuments[0]!, 'Only revenue', new AbortController().signal);
  assert.equal(result[0]!.value, 'INR 2500000');
  assert.equal(calls, 1);
  const missingKey = new GeminiAnalysisProvider('', 'test-model', transport);
  await assert.rejects(() => missingKey.extract(exampleDocuments[0]!, 'Only revenue', new AbortController().signal),
    (error: unknown) => error instanceof AnalysisError && error.code === 'AI_NOT_CONFIGURED');
  const badOutput = new GeminiAnalysisProvider('synthetic-test-key', 'test-model', async () => new Response(JSON.stringify({ candidates: [] })));
  await assert.rejects(() => badOutput.extract(exampleDocuments[0]!, 'Only revenue', new AbortController().signal),
    (error: unknown) => error instanceof AnalysisError && error.code === 'INVALID_AI_OUTPUT');
});

test('analysis errors are sanitized and retrieval validates IDs', async () => {
  const { app } = fixture();
  assert.equal((await request(app).get('/api/analysis/not-an-id')).status, 400);
  assert.equal((await request(app).get('/api/analysis/999')).status, 404);
  const repo = new MemoryAnalysisRepository();
  repo.loadDocuments = async () => { throw new Error('private connection information'); };
  const failing = fixture(repo);
  const response = await request(failing.app).post('/api/analysis').send(input);
  assert.equal(response.status, 500);
  assert.ok(!JSON.stringify(response.body).includes('private'));
});

test('provider output outside the current employment-type instruction is excluded before comparison', async () => {
  const repo = new MemoryAnalysisRepository([
    { id: '1', name: '01_loan_application.pdf', status: 'ready', metadata: null, text: 'Employment type: Salaried\nAnnual income: INR 1200000' },
    { id: '2', name: '02_income_verification.pdf', status: 'ready', metadata: null, text: 'Employment type: Salaried\nAnnual income: INR 1080000' },
  ]);
  const provider: AnalysisProvider = {
    mode: 'gemini', model: 'test-provider',
    async extract(document) {
      const value = document.id === '1' ? 'INR 1200000' : 'INR 1080000';
      return [{ field: 'employment_type', value: 'Salaried', quote: 'Employment type: Salaried' },
        { field: 'annual_income', value, quote: `Annual income: ${value}` }];
    },
    async compare(facts) {
      assert.equal(facts.length, 2);
      assert.ok(facts.every(fact => fact.field === 'employment_type'));
      return [];
    },
  };
  const { service } = fixture(repo, provider);
  const result = await service.analyse({ documentIds: ['1', '2'], instruction: 'Compare employment type across all uploaded documents.' });
  assert.ok(result.findings.some(finding => finding.type === 'comparison'));
  assert.ok(result.findings.every(finding => finding.values.every(value => value.field === 'employment_type' && value.value === 'Salaried')));
  assert.equal(result.findings.filter(finding => finding.type === 'discrepancy').length, 0);
});

test('sequential income and employment analyses use separate instructions, findings and saved sessions', async () => {
  const repo = new MemoryAnalysisRepository([
    { id: '1', name: '01_loan_application.pdf', status: 'ready', metadata: null, text: 'Annual income: INR 1200000\nEmployment type: Salaried' },
    { id: '2', name: '02_income_verification.pdf', status: 'ready', metadata: null, text: 'Verified annual income: INR 1080000\nEmployment type: Salaried' },
  ]);
  const { app } = fixture(repo);
  const first = await request(app).post('/api/analysis').send({ documentIds: ['1', '2'], instruction: 'Compare annual income.' });
  assert.equal(first.status, 201);
  assert.equal(first.body.findings.filter((finding: { type: string }) => finding.type === 'discrepancy').length, 1);
  for (const instruction of ['Compare employment type.', 'Compare employment types across all uploaded documents.', 'Compare type of employment.',
    'Compare employment type in the loan application and income verification documents. Identify whether the values match and provide source evidence.',
    'compare employment type in laon application and in income verification show the result',
    'Compare employment-type between 01_loan_application.pdf and 02_income_verification.pdf.']) {
    const response = await request(app).post('/api/analysis').send({ documentIds: ['1', '2'], instruction });
    assert.equal(response.status, 201);
    const result = response.body as AnalysisResult;
    assert.notEqual(result.id, first.body.id);
    assert.equal(result.instruction, instruction);
    assert.equal(result.findings.filter(finding => finding.type === 'discrepancy').length, 0);
    assert.match(result.summary, /0 potential difference/);
    const comparison = result.findings.find(finding => finding.type === 'comparison')!;
    assert.ok(comparison);
    assert.deepEqual(comparison.values.map(value => value.value), ['Salaried', 'Salaried']);
    assert.ok(result.findings.every(finding => finding.values.every(value => value.field === 'employment_type')));
    assert.ok(!JSON.stringify(result.findings).includes('120,000'));
    const stored = await request(app).get(`/api/analysis/${result.id}`);
    assert.deepEqual(stored.body, result);
  }
  const storedFirst = await request(app).get(`/api/analysis/${first.body.id}`);
  assert.deepEqual(storedFirst.body, first.body);
});
