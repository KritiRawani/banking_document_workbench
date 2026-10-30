export interface AnalysisDocument {
  id: string;
  name: string;
  text: string;
  metadata: unknown;
  status: string;
}
export interface Evidence {
  documentId: string;
  documentName: string;
  quote: string | null;
  charStart: number | null;
  charEnd: number | null;
  page?: number;
}
export interface Fact {
  id: string;
  documentId: string;
  field: string;
  value: string;
  evidence: Evidence;
}
export interface Finding {
  id: string;
  type: 'summary' | 'key_value' | 'comparison' | 'discrepancy' | 'missing_information';
  severity: 'info' | 'low' | 'medium' | 'high';
  contentKind: 'extracted_fact' | 'ai_interpretation';
  title: string;
  description: string;
  sources: Evidence[];
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
  findings: Finding[];
}
export interface RawFact { field: string; value: string; quote: string }
export interface Proposal {
  type: 'comparison' | 'discrepancy';
  title: string;
  description: string;
  severity: 'info' | 'low' | 'medium' | 'high';
  factIds: string[];
}
export interface AnalysisProvider {
  mode: 'mock' | 'gemini';
  model: string | null;
  extract(document: AnalysisDocument, instruction: string, signal: AbortSignal): Promise<RawFact[]>;
  compare(facts: Fact[], instruction: string, signal: AbortSignal): Promise<Proposal[]>;
}
export interface AnalysisRepository {
  loadDocuments(ids: string[]): Promise<AnalysisDocument[]>;
  start(documents: AnalysisDocument[], instruction: string, provider: AnalysisProvider): Promise<string>;
  complete(result: AnalysisResult): Promise<void>;
  fail(id: string, message: string): Promise<void>;
  get(id: string): Promise<AnalysisResult | undefined>;
}

export class AnalysisError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}
