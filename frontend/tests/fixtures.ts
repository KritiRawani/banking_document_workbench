import type { UploadedDocument } from '../src/upload';
import type { AnalysisResult } from '../src/analysis';

export const documents: UploadedDocument[] = [1, 2, 3, 4].map(id => ({
  id: String(id), original_filename: `source-${id}.txt`, file_size_bytes: '100', processing_status: 'ready',
  extracted_text: 'Annual revenue: INR 2500000', error_message: null,
}));

export const analysis: AnalysisResult = {
  id: '9', status: 'completed', instruction: 'Compare revenue and missing information', mode: 'mock', model: null,
  summary: 'Reviewed four documents with source-backed values.', limitations: ['Mock mode uses literal comparisons.'],
  documents: documents.map(doc => ({ id: doc.id, name: doc.original_filename, factCount: 1 })),
  findings: [{ id: 'finding-1', type: 'discrepancy', severity: 'medium', contentKind: 'ai_interpretation',
    title: 'Reported revenue differs', description: 'Verify period and currency before drawing a conclusion.',
    sources: [{ documentId: '1', documentName: 'source-1.txt', quote: 'Annual revenue: INR 2500000', charStart: 0, charEnd: 27, page: 1 }],
    values: [{ documentId: '1', field: 'revenue', value: 'INR 2500000' }] },
  { id: 'finding-2', type: 'missing_information', severity: 'low', contentKind: 'ai_interpretation',
    title: 'Address not located', description: 'No address label was located in the extracted text.',
    sources: [{ documentId: '4', documentName: 'source-4.txt', quote: null, charStart: null, charEnd: null }], values: [] }],
};
