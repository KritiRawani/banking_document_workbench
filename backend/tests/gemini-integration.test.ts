import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import request from 'supertest';
import { createAnalysisRouter } from '../src/routes/analysis.js';
import { GeminiAnalysisProvider, MockAnalysisProvider } from '../src/analysis/providers.js';
import { ResilientAnalysisService } from '../src/analysis/resilient-service.js';
import { createConfiguredAnalysisService } from '../src/analysis/factory.js';
import { AnalysisError, type AnalysisDocument, type AnalysisProvider, type AnalysisRepository, type AnalysisResult } from '../src/analysis/types.js';

const documents: AnalysisDocument[] = [
  { id: '1', name: '01_loan_application.pdf', status: 'ready',
    text: 'Applicant: Synthetic Person\nEmployment type: Salaried\nAnnual income: INR 1200000\nRequested loan amount: Not provided',
    metadata: { pages: [{ page: 2, char_start: 0, char_end: 1000 }] } },
  { id: '2', name: '02_income_verification.pdf', status: 'ready',
    text: 'Applicant: Synthetic Person\nEmployment type: Salaried\nVerified annual income: INR 1080000', metadata: null },
];
const input = { documentIds: ['1', '2'], instruction: 'Compare annual income and employment type; identify missing loan amounts and addresses.' };
const employmentInput = { ...input, instruction: 'Compare employment type in the loan application and income verification documents.' };

class Repository implements AnalysisRepository {
  started: { id: string; instruction: string; mode: string }[] = [];
  failed: string[] = [];
  completed = new Map<string, AnalysisResult>();
  async loadDocuments(ids: string[]) { return documents.filter(doc => ids.includes(doc.id)); }
  async start(_docs: AnalysisDocument[], instruction: string, provider: AnalysisProvider) {
    const id = String(this.started.length + 1);
    this.started.push({ id, instruction, mode: provider.mode });
    return id;
  }
  async complete(result: AnalysisResult) { this.completed.set(result.id, structuredClone(result)); }
  async fail(id: string) { this.failed.push(id); }
  async get(id: string) { return this.completed.get(id); }
}

function output(value: unknown, finishReason = 'STOP'): Response {
  return new Response(JSON.stringify({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(value) }] } }] }), { status: 200 });
}

function validFacts(documentId: string) {
  return [
    { field: 'employment_type', value: 'Salaried', quote: 'Employment type: Salaried' },
    { field: 'annual_income', value: documentId === '1' ? 'INR 1200000' : 'INR 1080000',
      quote: documentId === '1' ? 'Annual income: INR 1200000' : 'Verified annual income: INR 1080000' },
  ];
}

// Every Gemini provider below has an injected transport. No real fetch is used.
test('mocked Gemini returns the existing structured result, current scope and exact server-derived evidence', async () => {
  const repo = new Repository();
  const calls: { instruction: string; input: Record<string, unknown> }[] = [];
  const transport: typeof fetch = async (url, init) => {
    assert.equal(new URL(String(url)).hostname, 'generativelanguage.googleapis.com');
    assert.ok(!String(url).includes('synthetic-test-key'));
    assert.equal((init!.headers as Record<string, string>)['x-goog-api-key'], 'synthetic-test-key');
    const body = JSON.parse(String(init!.body));
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.ok(body.generationConfig.responseJsonSchema);
    const instruction = body.contents[0].parts[0].text;
    const data = JSON.parse(body.contents[0].parts[1].text);
    calls.push({ instruction, input: data });
    assert.ok(instruction.includes(input.instruction));
    if (data.documentId) {
      assert.equal(data.text, documents.find(doc => doc.id === data.documentId)!.text);
      assert.ok(!data.text.includes(documents.find(doc => doc.id !== data.documentId)!.name));
      return output({ facts: validFacts(data.documentId) });
    }
    assert.ok(Array.isArray(data.facts));
    return output({ findings: [{ type: 'comparison', title: 'Employment type matches', description: 'The quoted employment values match.',
      severity: 'info', factIds: data.facts.filter((fact: { field: string }) => fact.field === 'employment_type').map((fact: { id: string }) => fact.id) }] });
  };
  const service = new ResilientAnalysisService(repo, new GeminiAnalysisProvider('synthetic-test-key', 'test-model', transport));
  const result = await service.analyse(input);
  assert.equal(result.mode, 'gemini');
  assert.equal(result.model, 'test-model');
  assert.equal(repo.started.length, 1);
  assert.equal(repo.failed.length, 0);
  assert.equal(calls.length, 3);
  for (const type of ['summary', 'comparison', 'discrepancy', 'missing_information', 'key_value']) {
    assert.ok(result.findings.some(finding => finding.type === type), type);
  }
  for (const finding of result.findings) for (const source of finding.sources) {
    const document = documents.find(doc => doc.id === source.documentId)!;
    assert.equal(source.documentName, document.name);
    assert.equal(typeof source.quote, 'string');
    assert.equal(document.text.slice(source.charStart!, source.charEnd!), source.quote);
    if (source.page !== undefined) assert.equal(source.page, 2);
    if (document.id === '2') assert.equal(source.page, undefined);
  }
  assert.ok(result.findings.some(finding => finding.type === 'missing_information' && finding.description.includes('context only')));
  assert.deepEqual(await service.get(result.id), result);
});

test('Gemini unavailable/error responses fall back for the complete request, with a persisted label and safe reason', async t => {
  const cases: { name: string; key?: string; transport: typeof fetch; code: string }[] = [
    { name: 'missing key', key: '', transport: async () => { throw new Error('Transport must not be called'); }, code: 'AI_NOT_CONFIGURED' },
    { name: 'example placeholder', key: 'replace_with_your_gemini_api_key', transport: async () => { throw new Error('Transport must not be called'); }, code: 'AI_NOT_CONFIGURED' },
    { name: 'network failure', transport: async () => { throw new Error('private-provider-detail'); }, code: 'AI_UNAVAILABLE' },
    { name: 'authentication failure', transport: async () => new Response('private-provider-detail', { status: 401 }), code: 'AI_PROVIDER_ERROR' },
    { name: 'rate limit', transport: async () => new Response('private-provider-detail', { status: 429 }), code: 'AI_RATE_LIMITED' },
    { name: 'upstream outage', transport: async () => new Response('private-provider-detail', { status: 503 }), code: 'AI_PROVIDER_ERROR' },
    { name: 'retired/unavailable model', transport: async () => new Response('private-provider-detail', { status: 404 }), code: 'AI_MODEL_UNAVAILABLE' },
    { name: 'invalid envelope', transport: async () => new Response(JSON.stringify({ candidates: [] })), code: 'INVALID_AI_OUTPUT' },
    { name: 'blocked response', transport: async () => output({ facts: [] }, 'SAFETY'), code: 'INVALID_AI_OUTPUT' },
    { name: 'malformed JSON', transport: async () => new Response('{not json'), code: 'INVALID_AI_OUTPUT' },
    { name: 'invalid model shape', transport: async () => output({ facts: [{ field: 'employment_type' }] }), code: 'INVALID_AI_OUTPUT' },
    { name: 'invented quote', transport: async () => output({ facts: [{ field: 'employment_type', value: 'Salaried', quote: 'Invented evidence: Salaried' }] }), code: 'UNGROUNDED_AI_OUTPUT' },
    { name: 'invented page/filename', transport: async () => output({ facts: [{ field: 'employment_type', value: 'Salaried', quote: 'Employment type: Salaried', page: 99, filename: 'invented.pdf' }] }), code: 'INVALID_AI_OUTPUT' },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const repo = new Repository();
    const provider = new GeminiAnalysisProvider(item.key ?? 'synthetic-test-key', 'test-model', item.transport);
    const result = await new ResilientAnalysisService(repo, provider).analyse(employmentInput);
    assert.equal(result.mode, 'mock');
    assert.equal(result.model, null);
    assert.match(result.summary, /Rule-based fallback/);
    assert.ok(result.summary.includes(item.code));
    assert.ok(result.limitations.some(note => note.includes(item.code) && note.includes('no partial Gemini findings')));
    assert.deepEqual(repo.started.map(run => run.mode), ['gemini', 'mock']);
    assert.deepEqual(repo.failed, ['1']);
    assert.equal(repo.completed.size, 1);
    assert.equal(result.id, '2');
    assert.equal(result.instruction, employmentInput.instruction);
    assert.equal(result.findings.filter(finding => finding.type === 'discrepancy').length, 0);
    assert.deepEqual(result.findings.find(finding => finding.type === 'comparison')!.values.map(value => value.value), ['Salaried', 'Salaried']);
    assert.deepEqual(await repo.get(result.id), result);
    assert.ok(!JSON.stringify(result).includes('private-provider-detail'));
    assert.ok(!JSON.stringify(result).includes('synthetic-test-key'));
  });
});

test('Gemini per-call timeout triggers rule-based fallback using mocked abort-aware transport', async () => {
  const transport: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('Mock timeout guard')), 1000);
    init!.signal!.addEventListener('abort', () => { clearTimeout(keepAlive); reject(new Error('Mock request aborted')); }, { once: true });
  });
  const repo = new Repository();
  const provider = new GeminiAnalysisProvider('synthetic-test-key', 'test-model', transport, 10);
  const result = await new ResilientAnalysisService(repo, provider).analyse(employmentInput);
  assert.equal(result.mode, 'mock');
  assert.ok(result.summary.includes('AI_UNAVAILABLE'));
});

test('partial Gemini extraction is discarded when a later document fails', async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    if (calls === 1) return output({ facts: validFacts('1') });
    return new Response('private-provider-detail', { status: 503 });
  };
  const repo = new Repository();
  const result = await new ResilientAnalysisService(repo, new GeminiAnalysisProvider('synthetic-test-key', 'test-model', transport)).analyse(employmentInput);
  assert.equal(calls, 2);
  assert.equal(repo.completed.size, 1);
  assert.equal(result.mode, 'mock');
  assert.ok(result.documents.every(doc => doc.factCount === 1));
  assert.deepEqual(result.findings.find(finding => finding.type === 'comparison')!.sources.map(source => source.documentId), ['1', '2']);
});

test('invalid collective citations trigger fallback instead of persisting untraceable Gemini findings', async () => {
  const transport: typeof fetch = async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init!.body)).contents[0].parts[1].text);
    return data.documentId ? output({ facts: validFacts(data.documentId) })
      : output({ findings: [{ type: 'comparison', title: 'Unsupported comparison', description: 'Unsupported', severity: 'info', factIds: ['fake-1', 'fake-2'] }] });
  };
  const repo = new Repository();
  const result = await new ResilientAnalysisService(repo, new GeminiAnalysisProvider('synthetic-test-key', 'test-model', transport)).analyse(employmentInput);
  assert.equal(result.mode, 'mock');
  assert.ok(result.summary.includes('UNGROUNDED_AI_OUTPUT'));
  assert.ok(!result.findings.some(finding => finding.title === 'Unsupported comparison'));
});

test('fallback does not stick across requests; a recovered Gemini provider is used on the next request', async () => {
  let available = false;
  const transport: typeof fetch = async (_url, init) => {
    if (!available) return new Response('', { status: 503 });
    const data = JSON.parse(JSON.parse(String(init!.body)).contents[0].parts[1].text);
    return data.documentId ? output({ facts: validFacts(data.documentId) }) : output({ findings: [] });
  };
  const repo = new Repository();
  const service = new ResilientAnalysisService(repo, new GeminiAnalysisProvider('synthetic-test-key', 'test-model', transport));
  const first = await service.analyse(employmentInput);
  assert.equal(first.mode, 'mock');
  available = true;
  const second = await service.analyse(employmentInput);
  assert.equal(second.mode, 'gemini');
  assert.ok(!second.summary.includes('fallback'));
  assert.ok(!second.limitations.some(note => note.includes('AI_PROVIDER_ERROR')));
  assert.notEqual(first.id, second.id);
});

test('invalid requests, unready documents and database failures retain their existing errors without fallback', async () => {
  const unused: typeof fetch = async () => { throw new Error('Provider must not be called'); };
  const repo = new Repository();
  const service = new ResilientAnalysisService(repo, new GeminiAnalysisProvider('synthetic-test-key', 'test-model', unused));
  await assert.rejects(() => service.analyse({ ...input, instruction: '' }), (error: unknown) => error instanceof AnalysisError && error.code === 'INVALID_ANALYSIS_REQUEST');
  assert.equal(repo.started.length, 0);
  repo.loadDocuments = async () => [{ ...documents[0]!, status: 'failed' }];
  await assert.rejects(() => service.analyse({ documentIds: ['1'], instruction: 'Compare employment type.' }), (error: unknown) => error instanceof AnalysisError && error.code === 'DOCUMENT_NOT_READY');
  assert.equal(repo.started.length, 0);
  repo.loadDocuments = async () => { throw new AnalysisError('DATABASE_UNAVAILABLE', 'Database unavailable', 503); };
  await assert.rejects(() => service.analyse(input), (error: unknown) => error instanceof AnalysisError && error.code === 'DATABASE_UNAVAILABLE');
  assert.equal(repo.started.length, 0);
});

test('explicit rule-based mode is unchanged and never calls Gemini', async () => {
  const repo = new Repository();
  const result = await new ResilientAnalysisService(repo, new MockAnalysisProvider()).analyse(employmentInput);
  assert.equal(result.mode, 'mock');
  assert.equal(repo.started.length, 1);
  assert.ok(!result.summary.includes('fallback'));
});

test('fallback missing-information observations quote real context and never fabricate absence evidence', async () => {
  const repo = new Repository();
  const transport: typeof fetch = async () => new Response('', { status: 503 });
  const result = await new ResilientAnalysisService(repo, new GeminiAnalysisProvider('synthetic-test-key', 'test-model', transport))
    .analyse({ ...input, instruction: 'Extract addresses and identify missing information.' });
  assert.equal(result.mode, 'mock');
  const missing = result.findings.filter(finding => finding.type === 'missing_information');
  assert.ok(missing.length);
  for (const finding of missing) {
    assert.match(finding.description, /context only, not evidence proving absence/);
    for (const source of finding.sources) {
      assert.equal(typeof source.quote, 'string');
      assert.equal(documents.find(document => document.id === source.documentId)!.text.slice(source.charStart!, source.charEnd!), source.quote);
    }
  }
});

test('the existing analysis route returns a successful labelled fallback without changing its response contract', async () => {
  const repo = new Repository();
  const transport: typeof fetch = async () => new Response('', { status: 503 });
  const service = new ResilientAnalysisService(repo, new GeminiAnalysisProvider('synthetic-test-key', 'test-model', transport));
  const app = express();
  app.use(express.json());
  app.use('/api/analysis', createAnalysisRouter(service));
  const response = await request(app).post('/api/analysis').send(employmentInput);
  assert.equal(response.status, 201);
  assert.equal(response.body.mode, 'mock');
  assert.match(response.body.summary, /Rule-based fallback/);
  const stored = await request(app).get(`/api/analysis/${response.body.id}`);
  assert.deepEqual(stored.body, response.body);
});

test('AI_MODE=gemini selects Gemini through the existing API and returns its configured model with validated evidence', async () => {
  const repo = new Repository();
  let calls = 0;
  const transport: typeof fetch = async (url, init) => {
    calls++;
    assert.ok(String(url).includes('/models/configured-test-model:generateContent'));
    assert.equal((init!.headers as Record<string, string>)['x-goog-api-key'], 'synthetic-configured-key');
    const body = JSON.parse(String(init!.body));
    assert.ok(body.contents[0].parts[0].text.includes(employmentInput.instruction));
    const data = JSON.parse(body.contents[0].parts[1].text);
    return data.documentId ? output({ facts: validFacts(data.documentId) }) : output({ findings: [] });
  };
  const service = createConfiguredAnalysisService(repo, {
    AI_MODE: 'gemini', GEMINI_API_KEY: 'synthetic-configured-key', GEMINI_MODEL: 'configured-test-model',
  }, transport);
  const app = express();
  app.use(express.json());
  app.use('/api/analysis', createAnalysisRouter(service));
  const response = await request(app).post('/api/analysis').send(employmentInput);
  assert.equal(response.status, 201);
  assert.equal(response.body.mode, 'gemini');
  assert.equal(response.body.model, 'configured-test-model');
  assert.equal(response.body.instruction, employmentInput.instruction);
  assert.equal(calls, 3);
  assert.deepEqual(repo.started.map(run => run.mode), ['gemini']);
  assert.equal(response.body.findings.filter((finding: { type: string }) => finding.type === 'discrepancy').length, 0);
  const comparison = response.body.findings.find((finding: { type: string }) => finding.type === 'comparison');
  assert.deepEqual(comparison.values.map((value: { value: string }) => value.value), ['Salaried', 'Salaried']);
  for (const finding of response.body.findings) for (const source of finding.sources) {
    assert.equal(documents.find(doc => doc.id === source.documentId)!.text.slice(source.charStart, source.charEnd), source.quote);
  }
  const saved = await request(app).get(`/api/analysis/${response.body.id}`);
  assert.deepEqual(saved.body, response.body);
});

test('AI_MODE=mock keeps local analysis even when Gemini credentials are configured', async () => {
  const repo = new Repository();
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; throw new Error('Gemini must not be called'); };
  const service = createConfiguredAnalysisService(repo, {
    AI_MODE: 'mock', GEMINI_API_KEY: 'synthetic-configured-key', GEMINI_MODEL: 'configured-test-model',
  }, transport);
  const result = await service.analyse(employmentInput);
  assert.equal(result.mode, 'mock');
  assert.equal(result.model, null);
  assert.equal(calls, 0);
  assert.equal(repo.started.length, 1);
});

test('configured Gemini mode uses the same API response contract when the mocked provider is unavailable', async () => {
  const repo = new Repository();
  const service = createConfiguredAnalysisService(repo, {
    AI_MODE: 'gemini', GEMINI_API_KEY: 'synthetic-configured-key', GEMINI_MODEL: 'configured-test-model',
  }, async () => new Response('', { status: 429 }));
  const result = await service.analyse(employmentInput);
  assert.equal(result.mode, 'mock');
  assert.equal(result.model, null);
  assert.match(result.summary, /Rule-based fallback \(AI_RATE_LIMITED\)/);
  assert.deepEqual(repo.started.map(run => run.mode), ['gemini', 'mock']);
});

test('Gemini 3 uses compatible parameters while legacy Gemini sampling settings are preserved', async () => {
  for (const model of ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash']) {
    const transport: typeof fetch = async (_url, init) => {
      const config = JSON.parse(String(init!.body)).generationConfig;
      if (model.startsWith('gemini-3')) {
        assert.equal(config.temperature, undefined);
        assert.equal(config.candidateCount, undefined);
        assert.deepEqual(config.thinkingConfig, { thinkingLevel: 'low' });
        assert.equal(config.responseMimeType, 'application/json');
        assert.ok(config.responseJsonSchema);
      } else {
        assert.equal(config.temperature, 0);
        assert.equal(config.candidateCount, 1);
        assert.equal(config.thinkingConfig, undefined);
        assert.equal(config.responseMimeType, 'application/json');
        assert.ok(config.responseJsonSchema);
      }
      const schema = JSON.stringify(config.responseJsonSchema);
      for (const unsupported of ['$schema', 'minLength', 'maxLength', 'minItems', 'maxItems', 'additionalProperties']) {
        assert.ok(!schema.includes(unsupported), unsupported);
      }
      return output({ facts: validFacts('1') });
    };
    const result = await new GeminiAnalysisProvider('synthetic-test-key', model, transport)
      .extract(documents[0]!, employmentInput.instruction, new AbortController().signal);
    assert.ok(result.some(fact => fact.value === 'Salaried'));
  }
});

test('Gemini wire schema simplification preserves strict local validation', async () => {
  for (const facts of [
    [{ field: '', value: 'Salaried', quote: 'Employment type: Salaried' }],
    [{ field: 'employment_type', value: 'x'.repeat(501), quote: 'x'.repeat(501) }],
    [{ field: 'employment_type', value: 'Salaried', quote: 'Employment type: Salaried', page: 1 }],
    Array.from({ length: 101 }, () => validFacts('1')[0]),
  ]) {
    const provider = new GeminiAnalysisProvider('synthetic-test-key', 'gemini-3.1-flash-lite', async () => output({ facts }));
    await assert.rejects(provider.extract(documents[0]!, employmentInput.instruction, new AbortController().signal),
      (error: unknown) => error instanceof AnalysisError && error.code === 'INVALID_AI_OUTPUT');
  }
});
