import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildComparisons } from '../src/analysis/comparisons.js';
import { requestedFields } from '../src/analysis/rules.js';
import { groundFact } from '../src/analysis/service.js';
import type { AnalysisDocument } from '../src/analysis/types.js';

const documents: AnalysisDocument[] = [
  { id: '1', name: '01_loan_application.pdf', status: 'ready', metadata: null,
    text: 'Annual income: INR 1200000\nEmployment type: Salaried\nEmployer: First Employer' },
  { id: '2', name: '02_income_verification.pdf', status: 'ready', metadata: null,
    text: 'Annual income: INR 1080000\nEmployment type: Salaried\nEmployer: Second Employer' },
];
const broadFacts = documents.flatMap(document => [
  groundFact({ field: 'employment_type', value: 'Salaried', quote: 'Employment type: Salaried' }, document),
  groundFact({ field: 'annual_income', value: document.id === '1' ? 'INR 1200000' : 'INR 1080000',
    quote: document.id === '1' ? 'Annual income: INR 1200000' : 'Annual income: INR 1080000' }, document),
  groundFact({ field: 'employment', value: document.id === '1' ? 'First Employer' : 'Second Employer',
    quote: document.id === '1' ? 'Employer: First Employer' : 'Employer: Second Employer' }, document),
]);

test('document-role words and filenames do not widen the requested comparison fields', () => {
  for (const instruction of [
    'Compare employment type in the loan application and income verification documents. Identify whether the values match and provide source evidence.',
    'compare employment type in laon application and in income verification show the result',
    'Compare employment-type between 01_loan_application.pdf and 02_income_verification.pdf.',
    'Check whether employment types match in the income verification report and loan application form.',
  ]) {
    assert.deepEqual(requestedFields(instruction).map(field => field.key), ['employment_type'], instruction);
    const comparisons = buildComparisons(broadFacts, instruction);
    assert.equal(comparisons.length, 1, instruction);
    assert.equal(comparisons[0]!.type, 'comparison', instruction);
    const referenced = comparisons[0]!.factIds.map(id => broadFacts.find(fact => fact.id === id)!);
    assert.deepEqual(referenced.map(fact => fact.value), ['Salaried', 'Salaried']);
    assert.ok(referenced.every(fact => fact.field === 'employment_type'));
  }
});

test('identical employment values are matches after harmless whitespace and case differences', () => {
  const facts = structuredClone(broadFacts.filter(fact => fact.field === 'employment_type'));
  facts[1]!.value = ' salaried  ';
  const results = buildComparisons(facts, 'Compare employment type in income verification and loan application.');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.type, 'comparison');
  assert.equal(results[0]!.severity, 'info');
  assert.match(results[0]!.title, /matching values/);
});

test('explicitly requesting income alongside employment still selects both fields', () => {
  const instruction = 'Compare annual income and employment type in the loan application and income verification documents.';
  const keys = requestedFields(instruction).map(field => field.key);
  assert.deepEqual(new Set(keys), new Set(['annual_income', 'employment_type']));
  const results = buildComparisons(broadFacts, instruction);
  assert.equal(results.filter(result => result.type === 'comparison').length, 1);
  assert.equal(results.filter(result => result.type === 'discrepancy').length, 1);
});
