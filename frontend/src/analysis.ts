export interface AnalysisEvidence {
  documentId: string;
  documentName: string;
  quote: string | null;
  charStart: number | null;
  charEnd: number | null;
  page?: number;
}
export interface AnalysisFinding {
  id: string;
  type: 'summary' | 'key_value' | 'comparison' | 'discrepancy' | 'missing_information';
  severity: 'info' | 'low' | 'medium' | 'high';
  contentKind: 'extracted_fact' | 'ai_interpretation';
  title: string;
  description: string;
  sources: AnalysisEvidence[];
  values: { documentId: string; field: string; value: string }[];
}
export interface AnalysisResult {
  id: string;
  status: 'completed';
  instruction: string;
  mode: 'mock' | 'gemini';
  model: string | null;
  summary: string;
  limitations: string[];
  documents: { id: string; name: string; factCount: number }[];
  findings: AnalysisFinding[];
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function isEvidence(value: unknown): value is AnalysisEvidence {
  return object(value) && typeof value.documentId === 'string' && typeof value.documentName === 'string' &&
    (typeof value.quote === 'string' || value.quote === null) &&
    (value.charStart === null || (Number.isInteger(value.charStart) && Number(value.charStart) >= 0)) &&
    (value.charEnd === null || (Number.isInteger(value.charEnd) && Number(value.charEnd) >= 0)) &&
    (value.page === undefined || (Number.isInteger(value.page) && Number(value.page) > 0));
}
function isFinding(value: unknown): value is AnalysisFinding {
  return object(value) && typeof value.id === 'string' && typeof value.title === 'string' && typeof value.description === 'string' &&
    ['summary', 'key_value', 'comparison', 'discrepancy', 'missing_information'].includes(String(value.type)) &&
    ['info', 'low', 'medium', 'high'].includes(String(value.severity)) &&
    ['extracted_fact', 'ai_interpretation'].includes(String(value.contentKind)) &&
    Array.isArray(value.sources) && value.sources.length > 0 && value.sources.every(isEvidence) &&
    Array.isArray(value.values) && value.values.every(item => object(item) && typeof item.documentId === 'string' && typeof item.field === 'string' && typeof item.value === 'string');
}
export function isAnalysisResult(value: unknown): value is AnalysisResult {
  if (!object(value) || typeof value.id !== 'string' || value.status !== 'completed' || typeof value.instruction !== 'string' ||
    !['mock', 'gemini'].includes(String(value.mode)) || !(value.model === null || typeof value.model === 'string') ||
    typeof value.summary !== 'string' || !Array.isArray(value.limitations) || !value.limitations.every(item => typeof item === 'string') ||
    !Array.isArray(value.documents) || !value.documents.every(item => object(item) && typeof item.id === 'string' && typeof item.name === 'string' && Number.isInteger(item.factCount)) ||
    !Array.isArray(value.findings) || !value.findings.every(isFinding)) return false;
  const ids = new Set(value.documents.map(doc => doc.id));
  return value.findings.every(finding => finding.sources.every(source => ids.has(source.documentId)) && finding.values.every(item => ids.has(item.documentId)));
}

export const findingLabels: Record<AnalysisFinding['type'], string> = {
  summary: 'Document summaries', discrepancy: 'Mismatches', missing_information: 'Missing information',
  comparison: 'Matching values & comparisons', key_value: 'Extracted key values',
};

export function analysisAsText(result: AnalysisResult): string {
  return [
    `Analysis #${result.id} (${result.mode})`, `Instruction: ${result.instruction}`, result.summary,
    ...result.findings.map(finding => [
      `${findingLabels[finding.type]} | ${finding.severity} | ${finding.contentKind}: ${finding.title}`,
      finding.description,
      ...finding.values.map(value => `${result.documents.find(doc => doc.id === value.documentId)?.name ?? value.documentId}: ${value.field} = ${value.value}`),
      ...finding.sources.map(source => `${source.documentName} (#${source.documentId})${source.page ? ` page ${source.page}` : ''}: ${source.quote === null ? 'Full extracted-text scope; no quote for absence.' : `"${source.quote}" [characters ${source.charStart}–${source.charEnd}]`}`),
    ].join('\n')),
    'Limitations:', ...result.limitations,
  ].join('\n\n');
}
