import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalysisService } from '../src/analysis/service.js';
import { MockAnalysisProvider } from '../src/analysis/providers.js';
import { missingFields } from '../src/analysis/rules.js';
import { parseMoney } from '../src/analysis/comparisons.js';
import type { AnalysisDocument, AnalysisRepository, AnalysisResult } from '../src/analysis/types.js';

function fixture(texts?: string[]) {
  const documents: AnalysisDocument[] = [
    { id: '1', name: '01_loan_application.pdf', status: 'ready', text: 'Applicant   Example Person\nAnnual income   ₹1,200,000\nRequested loan amount   INR 1,500,000\nResidential address   12 Sample Road\n', metadata: { pages: [{ page: 1, char_start: 0, char_end: 1000 }] } },
    { id: '2', name: '02_income_verification.pdf', status: 'ready', text: 'Applicant   Example Person\nVerified annual income   ₹1,080,000\nVerified monthly income   INR 90,000\nEmployer   Example Ltd\nEmployment type   Salaried\n', metadata: { pages: [{ page: 1, char_start: 0, char_end: 1000 }] } },
    { id: '3', name: 'property_valuation.pdf', status: 'ready', text: 'Applicant   Example Person\nEstimated market value   INR 2,000,000\nProperty address   24 Property Road\n', metadata: null },
    { id: '4', name: 'credit_review_notes.txt', status: 'ready', text: 'Applicant: Example Person\n- Verified annual income: INR 1,080,000\n- Requested loan amount: INR 1,500,000\n', metadata: null },
  ];
  if (texts) texts.forEach((text, index) => { documents[index]!.text = text; });
  const saved = new Map<string, AnalysisResult>();
  const repository: AnalysisRepository = {
    async loadDocuments(ids) { return documents.filter(doc => ids.includes(doc.id)); },
    async start() { return '1'; }, async complete(result) { saved.set(result.id, result); },
    async fail() {}, async get(id) { return saved.get(id); },
  };
  return { service: new AnalysisService(repository, new MockAnalysisProvider()), documents, saved };
}

test('annual income mismatch is ₹120,000 with evidence exclusively from the two named PDFs', async () => {
  const { service, documents, saved } = fixture();
  const result = await service.analyse({ documentIds: ['1', '2', '3', '4'], instruction: 'Compare all uploaded banking loan documents and identify discrepancies and missing information.' });
  const finding = result.findings.find(item => item.type === 'discrepancy' && item.title === 'Annual income: mismatch');
  assert.ok(finding);
  assert.match(finding.description, /₹1,200,000/);
  assert.match(finding.description, /₹1,080,000/);
  assert.match(finding.description, /Calculated absolute difference: ₹120,000 \(₹1,200,000 − ₹1,080,000\)/);
  assert.match(finding.description, /loan_application\.pdf/);
  assert.match(finding.description, /income_verification\.pdf/);
  assert.equal(finding.contentKind, 'ai_interpretation');
  assert.deepEqual(new Set(finding.sources.map(source => source.documentId)), new Set(['1', '2']));
  assert.ok(!finding.sources.some(source => source.documentId === '3'));
  for (const source of finding.sources) {
    const doc = documents.find(document => document.id === source.documentId)!;
    assert.equal(doc.text.slice(source.charStart!, source.charEnd!), source.quote);
  }
  assert.ok(finding.sources.filter(source => ['1', '2'].includes(source.documentId)).every(source => source.page === 1));
  assert.ok(!result.findings.filter(item => item.type === 'missing_information').some(item => /licen[cs]e|revenue|profit|assets|liabilities/i.test(item.title)));
  assert.ok(result.findings.some(item => item.type === 'comparison' && item.values.every(value => value.field === 'loan')));
  assert.equal(saved.get(result.id), result);
});

test('annual and monthly income, employer/type, property/residential addresses are separate matching fields', async () => {
  const { service } = fixture();
  const result = await service.analyse({ documentIds: ['1', '2', '3', '4'], instruction: 'Compare all uploaded loan documents.' });
  for (const finding of result.findings.filter(item => item.type === 'comparison' || item.type === 'discrepancy')) {
    assert.equal(new Set(finding.values.map(value => value.field)).size, 1);
  }
  const income = result.findings.find(item => item.type === 'discrepancy' && item.values[0]?.field === 'annual_income')!;
  assert.ok(!income.values.some(value => value.value === 'INR 90,000'));
  assert.ok(!result.findings.some(item => item.type === 'discrepancy' && item.values[0]?.field === 'address'));
});

test('discrepancy scope ignores conflicting fields and income from every other document', async () => {
  const { service, documents, saved } = fixture();
  documents[0]!.text += 'Monthly income: INR 100,000\n';
  documents[1]!.text += 'Requested loan amount: INR 2,500,000\nResidential address: 99 Different Road\n';
  documents[2]!.text += 'Annual income: INR 9,000,000\nRequested loan amount: INR 8,000,000\n';
  documents[3]!.text = 'Annual income: INR 7,000,000\nRequested loan amount: INR 6,000,000\n';
  const result = await service.analyse({ documentIds: ['1', '2', '3', '4'], instruction: 'Compare all uploaded loan documents and identify discrepancies.' });
  const discrepancies = result.findings.filter(finding => finding.type === 'discrepancy');
  assert.equal(discrepancies.length, 1);
  const finding = discrepancies[0]!;
  assert.equal(finding.title, 'Annual income: mismatch');
  assert.match(finding.description, /₹120,000/);
  assert.equal((finding.description.match(/Calculated absolute difference/g) ?? []).length, 1);
  assert.deepEqual(new Set(finding.values.map(value => value.field)), new Set(['annual_income']));
  assert.deepEqual(new Set(finding.sources.map(source => source.documentName)), new Set(['01_loan_application.pdf', '02_income_verification.pdf']));
  assert.deepEqual(new Set(finding.values.map(value => value.documentId)), new Set(['1', '2']));
  assert.ok(!/7,000,000|9,000,000|property_valuation|credit_review/.test(finding.description));
  for (const source of finding.sources) assert.equal(documents.find(doc => doc.id === source.documentId)!.text.slice(source.charStart!, source.charEnd!), source.quote);
  assert.deepEqual(saved.get(result.id)?.findings.filter(item => item.type === 'discrepancy'), discrepancies);
  assert.match(result.summary, /1 potential difference/);
});

test('a missing named PDF is never replaced with a different document in discrepancy results', async () => {
  const { service, documents } = fixture();
  documents[1]!.name = 'another_income_document.pdf';
  const result = await service.analyse({ documentIds: ['1', '2', '3', '4'], instruction: 'Compare all loan documents for discrepancies.' });
  assert.equal(result.findings.filter(finding => finding.type === 'discrepancy').length, 0);
});

test('employment type comparison only shows matching Salaried values despite conflicting annual income', async () => {
  const { service, documents, saved } = fixture();
  documents[0]!.text += 'Employer   Different Employer\nEmployment type   Salaried\n';
  const result = await service.analyse({ documentIds: ['1', '2', '3', '4'], instruction: 'Compare employment type across all uploaded documents.' });
  const comparison = result.findings.find(finding => finding.type === 'comparison');
  assert.ok(comparison);
  assert.equal(result.findings.filter(finding => finding.type === 'discrepancy').length, 0);
  assert.deepEqual(comparison.values.map(value => value.value), ['Salaried', 'Salaried']);
  assert.ok(result.findings.every(finding => finding.values.every(value => value.field === 'employment_type')));
  assert.ok(result.findings.every(finding => finding.sources.every(source => source.quote === 'Employment type   Salaried')));
  assert.ok(!/annual_income|annual income|120,000|1,200,000|1,080,000/i.test(JSON.stringify(result.findings)));
  assert.deepEqual(saved.get(result.id)?.findings, result.findings);
});

test('currency notation and Indian/Western grouping do not generate false income mismatches', async () => {
  const { service } = fixture(['Annual income: ₹12,00,000', 'Verified annual income: INR 1,200,000.00']);
  const result = await service.analyse({ documentIds: ['1', '2'], instruction: 'Compare annual income.' });
  const comparison = result.findings.find(item => item.type === 'comparison' && item.values[0]?.field === 'annual_income');
  assert.ok(comparison);
  assert.equal(result.findings.filter(item => item.type === 'discrepancy').length, 0);
  assert.equal(parseMoney('INR 1,200,000.01')?.minor, 120000001n);
  assert.equal(parseMoney('₹12,00,000')?.minor, 120000000n);
  assert.equal(parseMoney('INR 1,20,00'), undefined);
});

test('different currencies, bare numbers and ambiguous multiple values are never subtracted', async () => {
  for (const texts of [
    ['Annual income: INR 1,200,000', 'Verified annual income: USD 1,080,000'],
    ['Annual income: 1200000', 'Verified annual income: 1080000'],
    ['Annual income: INR 1,200,000\nAnnual income: INR 1,100,000', 'Verified annual income: INR 1,080,000'],
  ]) {
    const { service } = fixture(texts);
    const result = await service.analyse({ documentIds: ['1', '2'], instruction: 'Compare annual income.' });
    assert.ok(result.findings.every(item => !item.description.includes('Calculated absolute difference')));
  }
});

test('missing fields follow the role of the document and never ask for irrelevant business-loan metrics', () => {
  const { documents } = fixture();
  const instruction = 'Compare all uploaded loan documents and identify missing information.';
  const valuation = missingFields(documents[2]!, instruction).map(field => field.key);
  assert.ok(valuation.includes('property_value'));
  assert.ok(!valuation.includes('annual_income'));
  const verification = missingFields(documents[1]!, instruction).map(field => field.key);
  assert.ok(verification.includes('annual_income'));
  assert.ok(!verification.includes('purpose'));
  for (const doc of documents) assert.ok(missingFields(doc, instruction).every(field => !['licence', 'revenue', 'profit'].includes(field.key)));
});
