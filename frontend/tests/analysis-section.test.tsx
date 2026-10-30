import { beforeEach, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AnalysisSection from '../src/components/AnalysisSection';
import DocumentUpload from '../src/components/DocumentUpload';
import { analyseDocuments, uploadDocuments } from '../src/api';
import { analysis, documents } from './fixtures';

vi.mock('../src/api', () => ({ analyseDocuments: vi.fn(), uploadDocuments: vi.fn() }));
const analyse = vi.mocked(analyseDocuments);
const upload = vi.mocked(uploadDocuments);
beforeEach(() => { vi.resetAllMocks(); });

function employmentResult() {
  const result = structuredClone(analysis);
  result.id = '10';
  result.instruction = 'Compare employment type.';
  result.summary = 'Employment type matches. 0 potential differences.';
  result.findings = [{ id: 'employment-match', type: 'comparison', severity: 'info', contentKind: 'ai_interpretation',
    title: 'Employment type: matching values', description: 'Salaried vs Salaried.',
    values: ['1', '2'].map(documentId => ({ documentId, field: 'employment_type', value: 'Salaried' })),
    sources: ['1', '2'].map(documentId => ({ documentId, documentName: `source-${documentId}.txt`, quote: 'Employment type: Salaried', charStart: 0, charEnd: 25 })) }];
  return result;
}

test('drop zone validates dropped files and lets users remove them before uploading', () => {
  render(<DocumentUpload />);
  const zone = screen.getByRole('region', { name: 'Document drop zone' });
  fireEvent.dragEnter(zone, { dataTransfer: { types: ['Files'] } });
  expect(zone).toHaveClass('is-dragging');
  fireEvent.drop(zone, { dataTransfer: { files: [new File(['abc'], 'dropped.txt', { type: 'text/plain' })] } });
  expect(zone).not.toHaveClass('is-dragging');
  expect(screen.getByText('dropped.txt')).toBeVisible();
  expect(screen.getByText('3 bytes')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Upload 1 file' })).toBeEnabled();
  expect(upload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove dropped.txt' }));
  expect(screen.queryByText('dropped.txt')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Upload documents' })).toBeDisabled();
  fireEvent.drop(zone, { dataTransfer: { files: [new File(['invalid'], 'unsupported.csv', { type: 'text/csv' })] } });
  expect(screen.getByText('Only PDF and TXT files are supported.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Upload 1 file' })).toBeDisabled();
});

test('analysis waits for documents and a nonblank instruction', () => {
  const { rerender } = render(<AnalysisSection documents={[]} />);
  expect(screen.getByRole('button', { name: 'Analyze Documents' })).toBeDisabled();
  rerender(<AnalysisSection documents={documents} />);
  expect(screen.getByRole('button', { name: 'Analyze Documents' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Analysis instruction'), { target: { value: '   ' } });
  expect(screen.getByRole('button', { name: 'Analyze Documents' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Analysis instruction'), { target: { value: 'Compare revenue' } });
  expect(screen.getByRole('button', { name: 'Analyze Documents' })).toBeEnabled();
});

test('all four IDs and exact instruction are submitted once with loading, severity and source evidence', async () => {
  let resolve!: (result: typeof analysis) => void;
  analyse.mockReturnValue(new Promise(done => { resolve = done; }));
  render(<AnalysisSection documents={[...documents, documents[0]!]} />);
  fireEvent.change(screen.getByLabelText('Analysis instruction'), { target: { value: `  ${analysis.instruction}  ` } });
  fireEvent.click(screen.getByRole('button', { name: 'Analyze Documents' }));
  expect(screen.getByRole('button', { name: 'Analysing documents…' })).toBeDisabled();
  expect(analyse).toHaveBeenCalledWith(['1', '2', '3', '4'], analysis.instruction, expect.any(AbortSignal));
  resolve(analysis);
  expect(await screen.findByText('Reported revenue differs')).toBeVisible();
  expect(screen.getByText('Severity: medium')).toBeVisible();
  expect(screen.getByText('Annual revenue: INR 2500000')).toBeVisible();
  expect(screen.getByText(/Page 1/)).toBeVisible();
  expect(screen.getByText(/No quotation supports absence/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Analyze Documents' })).toBeEnabled();
});

test('backend errors are visible and the analysis can be retried', async () => {
  analyse.mockRejectedValueOnce(new Error('Every selected document must be ready.')).mockResolvedValueOnce(analysis);
  render(<AnalysisSection documents={documents} />);
  fireEvent.change(screen.getByLabelText('Analysis instruction'), { target: { value: analysis.instruction } });
  fireEvent.click(screen.getByRole('button', { name: 'Analyze Documents' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Every selected document must be ready.');
  fireEvent.click(screen.getByRole('button', { name: 'Analyze Documents' }));
  expect(await screen.findByText('Reported revenue differs')).toBeVisible();
});

test('calculated income difference and both original PDF quotations are displayed without changing upload flow', async () => {
  const result = structuredClone(analysis);
  result.findings = [{ id: 'income-mismatch', type: 'discrepancy', severity: 'medium', contentKind: 'ai_interpretation',
    title: 'Annual income: mismatch', description: 'Calculated absolute difference: ₹120,000 (₹1,200,000 − ₹1,080,000).',
    values: [{ documentId: '1', field: 'annual_income', value: '₹1,200,000' }, { documentId: '2', field: 'annual_income', value: '₹1,080,000' }],
    sources: [
      { documentId: '1', documentName: 'loan_application.pdf', quote: 'Annual income: ₹1,200,000', charStart: 0, charEnd: 24, page: 1 },
      { documentId: '2', documentName: 'income_verification.pdf', quote: 'Verified annual income: ₹1,080,000', charStart: 0, charEnd: 33, page: 1 },
    ] }];
  analyse.mockResolvedValue(result);
  render(<AnalysisSection documents={documents} />);
  fireEvent.change(screen.getByLabelText('Analysis instruction'), { target: { value: analysis.instruction } });
  fireEvent.click(screen.getByRole('button', { name: 'Analyze Documents' }));
  expect(await screen.findByText(/Calculated absolute difference: ₹120,000/)).toBeVisible();
  expect(screen.getByText('Annual income: ₹1,200,000')).toBeVisible();
  expect(screen.getByText('Verified annual income: ₹1,080,000')).toBeVisible();
  expect(screen.getByText('loan_application.pdf')).toBeVisible();
  expect(screen.getByText('income_verification.pdf')).toBeVisible();
});

test('copy includes evidence and edits/new documents mark earlier results stale', async () => {
  analyse.mockResolvedValue(analysis);
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  const { rerender } = render(<AnalysisSection documents={documents} />);
  fireEvent.change(screen.getByLabelText('Analysis instruction'), { target: { value: analysis.instruction } });
  fireEvent.click(screen.getByRole('button', { name: 'Analyze Documents' }));
  await screen.findByText('Reported revenue differs');
  fireEvent.click(screen.getByRole('button', { name: 'Copy analysis' }));
  await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Annual revenue: INR 2500000')));
  fireEvent.change(screen.getByLabelText('Analysis instruction'), { target: { value: 'Compare names instead' } });
  expect(screen.getByText(/earlier document set or instruction/)).toBeVisible();
  expect(screen.queryByText('Reported revenue differs')).not.toBeInTheDocument();
  rerender(<AnalysisSection documents={documents.slice(0, 2)} />);
  expect(screen.getByText(/earlier document set or instruction/)).toBeVisible();
});

test('new employment analysis replaces previous mismatches and displays Salaried vs Salaried with zero mismatches', async () => {
  let complete!: (result: typeof analysis) => void;
  analyse.mockResolvedValueOnce(analysis).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  render(<AnalysisSection documents={documents} />);
  fireEvent.change(screen.getByLabelText('Analysis instruction'), { target: { value: analysis.instruction } });
  fireEvent.click(screen.getByRole('button', { name: 'Analyze Documents' }));
  await screen.findByText('Reported revenue differs');
  fireEvent.change(screen.getByLabelText('Analysis instruction'), { target: { value: 'Compare employment type.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Analyze Documents' }));
  expect(screen.queryByText('Reported revenue differs')).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Analysis statistics' })).not.toBeInTheDocument();
  complete(employmentResult());
  expect(await screen.findByText('Salaried vs Salaried.')).toBeVisible();
  expect(within(screen.getByRole('group', { name: 'Analysis statistics' })).getByText('Mismatches')).toHaveTextContent('0');
  expect(screen.queryByText('Reported revenue differs')).not.toBeInTheDocument();
  expect(screen.getAllByText('Salaried')).toHaveLength(2);
  expect(analyse.mock.calls[1]![1]).toBe('Compare employment type.');
});

test('a late obsolete response cannot overwrite the latest analysis after document changes', async () => {
  let finishOld!: (result: typeof analysis) => void;
  analyse.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }));
  const { rerender } = render(<AnalysisSection documents={documents} />);
  fireEvent.change(screen.getByLabelText('Analysis instruction'), { target: { value: analysis.instruction } });
  fireEvent.click(screen.getByRole('button', { name: 'Analyze Documents' }));
  const oldSignal = analyse.mock.calls[0]![2];
  rerender(<AnalysisSection documents={documents.slice(0, 2)} />);
  expect(oldSignal.aborted).toBe(true);
  const latest = employmentResult();
  latest.documents = latest.documents.slice(0, 2);
  analyse.mockResolvedValueOnce(latest);
  fireEvent.change(screen.getByLabelText('Analysis instruction'), { target: { value: latest.instruction } });
  fireEvent.click(screen.getByRole('button', { name: 'Analyze Documents' }));
  await screen.findByText('Salaried vs Salaried.');
  await act(async () => { finishOld(analysis); });
  expect(screen.getByText('Salaried vs Salaried.')).toBeVisible();
  expect(screen.queryByText('Reported revenue differs')).not.toBeInTheDocument();
  expect(within(screen.getByRole('group', { name: 'Analysis statistics' })).getByText('Mismatches')).toHaveTextContent('0');
});

test('rerunning the same instruction clears the previous result even if the new request fails', async () => {
  let fail!: (error: Error) => void;
  analyse.mockResolvedValueOnce(employmentResult()).mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
  render(<AnalysisSection documents={documents} />);
  fireEvent.change(screen.getByLabelText('Analysis instruction'), { target: { value: 'Compare employment type.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Analyze Documents' }));
  await screen.findByText('Salaried vs Salaried.');
  fireEvent.click(screen.getByRole('button', { name: 'Analyze Documents' }));
  expect(screen.queryByText('Salaried vs Salaried.')).not.toBeInTheDocument();
  fail(new Error('Provider unavailable.'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Provider unavailable.');
  expect(screen.queryByRole('group', { name: 'Analysis statistics' })).not.toBeInTheDocument();
});

test('upload results across batches feed all four ready IDs into analysis below Document Results', async () => {
  upload.mockResolvedValueOnce(documents.slice(0, 2).map(doc => ({ filename: doc.original_filename, outcome: 'ready', document: doc })))
    .mockResolvedValueOnce(documents.slice(2).map(doc => ({ filename: doc.original_filename, outcome: 'ready', document: doc })));
  analyse.mockResolvedValue(analysis);
  render(<DocumentUpload />);
  const picker = screen.getByLabelText('Choose PDF or TXT files');
  fireEvent.change(picker, { target: { files: [new File(['a'], 'one.txt', { type: 'text/plain' }), new File(['b'], 'two.txt', { type: 'text/plain' })] } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload 2 files' }));
  await screen.findByText(/2 ready documents will be included/);
  fireEvent.change(picker, { target: { files: [new File(['c'], 'three.txt', { type: 'text/plain' }), new File(['d'], 'four.txt', { type: 'text/plain' })] } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload 2 files' }));
  await screen.findByText(/4 ready documents will be included/);
  const results = screen.getByRole('heading', { name: 'Document results' });
  const section = screen.getByRole('heading', { name: 'Document analysis' });
  expect(results.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Analysis instruction'), { target: { value: analysis.instruction } });
  fireEvent.click(screen.getByRole('button', { name: 'Analyze Documents' }));
  await waitFor(() => expect(analyse).toHaveBeenCalledWith(expect.arrayContaining(['1', '2', '3', '4']), analysis.instruction, expect.any(AbortSignal)));
  expect(analyse.mock.calls[0]![0]).toHaveLength(4);
});
