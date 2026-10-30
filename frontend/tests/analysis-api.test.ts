import { afterEach, expect, test, vi } from 'vitest';
import { analyseDocuments } from '../src/api';
import { analysisAsText, isAnalysisResult } from '../src/analysis';
import { analysis } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

test('analysis API sends document IDs and user instruction and validates the response', async () => {
  const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify(analysis), { status: 201 }));
  vi.stubGlobal('fetch', transport);
  const result = await analyseDocuments(['1', '2', '3', '4'], analysis.instruction, new AbortController().signal);
  expect(result.id).toBe('9');
  const [url, options] = transport.mock.calls[0]!;
  expect(url).toMatch(/\/api\/analysis$/);
  expect(JSON.parse(options.body)).toEqual({ documentIds: ['1', '2', '3', '4'], instruction: analysis.instruction });
});

test('API errors, network failures and omitted documents do not appear as successful analysis', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'DOCUMENT_NOT_READY', message: 'Documents are not ready.' } }), { status: 409 })));
  await expect(analyseDocuments(['1'], 'Compare', new AbortController().signal)).rejects.toThrow('Documents are not ready');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')));
  await expect(analyseDocuments(['1'], 'Compare', new AbortController().signal)).rejects.toThrow('Cannot reach');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...analysis, documents: analysis.documents.slice(0, 2), findings: [] }), { status: 201 })));
  await expect(analyseDocuments(['1', '2', '3', '4'], 'Compare', new AbortController().signal)).rejects.toThrow('every requested document');
});

test('unknown evidence sources are rejected and copy output preserves provenance', () => {
  const invalid = structuredClone(analysis);
  invalid.findings[0]!.sources[0]!.documentId = '999';
  expect(isAnalysisResult(invalid)).toBe(false);
  expect(analysisAsText(analysis)).toContain('source-1.txt (#1) page 1');
  expect(analysisAsText(analysis)).toContain('Full extracted-text scope');
});

test('a response from a previous instruction cannot be accepted as the current analysis', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(analysis), { status: 201 })));
  await expect(analyseDocuments(['1', '2', '3', '4'], 'Compare employment type.', new AbortController().signal))
    .rejects.toThrow('different instruction');
});
