import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalField, explicitInstructionFields, isMissingValue, missingFields, requestedFields } from './rules.js';
import { buildComparisons, incomeDiscrepancyScope } from './comparisons.js';
import { AnalysisError, type AnalysisDocument, type AnalysisProvider, type AnalysisRepository, type AnalysisResult, type Fact, type Finding, type RawFact } from './types.js';

export const analysisRequest = z.object({
  documentIds: z.array(z.string().regex(/^[1-9]\d{0,19}$/)).min(1).max(10)
    .refine(ids => new Set(ids).size === ids.length, 'Document IDs must be unique'),
  instruction: z.string().trim().min(1).max(4000),
}).strict();

export function documentChunks(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split(/(?<=\n)/)) {
    if (line.length > 12_000) throw new AnalysisError('ANALYSIS_SEGMENT_LIMIT', 'A document contains a text line longer than 12,000 characters. Split it into smaller readable sections before analysis.', 413);
    if (current.length + line.length > 12_000) { chunks.push(current); current = ''; }
    current += line;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function groundFact(raw: RawFact, document: AnalysisDocument): Fact {
  const index = document.text.indexOf(raw.quote);
  if (!raw.field.trim() || !raw.value.trim() || !raw.quote.trim() || index < 0 || !raw.quote.includes(raw.value)) {
    throw new AnalysisError('UNGROUNDED_AI_OUTPUT', 'Analysis returned a value or quotation that could not be verified against its source. No findings were saved.', 502);
  }
  const metadata = document.metadata as { pages?: { page: number; char_start: number; char_end: number }[] } | null;
  const page = metadata?.pages?.find(item => item.char_start <= index && item.char_end >= index + raw.quote.length)?.page;
  return {
    id: randomUUID(), documentId: document.id, field: canonicalField(raw.field), value: raw.value,
    evidence: { documentId: document.id, documentName: document.name, quote: raw.quote,
      charStart: index, charEnd: index + raw.quote.length, ...(page ? { page } : {}) },
  };
}

function fromFacts(type: Finding['type'], title: string, description: string, facts: Fact[], severity: Finding['severity'] = 'info'): Finding {
  return { id: randomUUID(), type, severity, contentKind: type === 'key_value' ? 'extracted_fact' : 'ai_interpretation',
    title: title.slice(0, 255), description, sources: facts.map(fact => fact.evidence),
    values: facts.map(fact => ({ documentId: fact.documentId, field: fact.field, value: fact.value })) };
}

export class AnalysisService {
  constructor(private readonly repository: AnalysisRepository, private readonly provider: AnalysisProvider,
    private readonly context: { notices?: readonly string[]; summaryPrefix?: string } = {}) {}

  async analyse(input: unknown): Promise<AnalysisResult> {
    const parsed = analysisRequest.safeParse(input);
    if (!parsed.success) throw new AnalysisError('INVALID_ANALYSIS_REQUEST', 'Provide 1–10 unique document IDs and an instruction of 1–4,000 characters.', 400);
    const { documentIds, instruction } = parsed.data;
    const explicitScope = explicitInstructionFields(instruction).length > 0;
    const allowedFields = new Set(requestedFields(instruction).map(field => field.key));
    const loaded = await this.repository.loadDocuments(documentIds);
    if (loaded.length !== documentIds.length) throw new AnalysisError('DOCUMENT_NOT_FOUND', 'One or more requested documents do not exist.', 404);
    const documents = documentIds.map(id => loaded.find(doc => doc.id === id)!);
    if (documents.some(doc => doc.status !== 'ready' || !doc.text?.trim())) {
      throw new AnalysisError('DOCUMENT_NOT_READY', 'Every selected document must have ready status and readable extracted text.', 409);
    }
    // Reject oversized analysis explicitly; never silently omit/truncate documents.
    if (documents.reduce((sum, doc) => sum + doc.text.length, 0) > 100_000) {
      throw new AnalysisError('ANALYSIS_CONTENT_LIMIT', 'Analysis supports up to 100,000 extracted characters in total. Use smaller documents.', 413);
    }
    const id = await this.repository.start(documents, instruction, this.provider);
    const signal = AbortSignal.timeout(180_000);
    try {
      const facts: Fact[] = [];
      const findings: Finding[] = [];
      for (const document of documents) {
        const raw: RawFact[] = [];
        // Independent chunks retain their document boundary. Evidence is checked
        // against the complete stored document after extraction.
        for (const text of documentChunks(document.text)) {
          signal.throwIfAborted();
          raw.push(...await this.provider.extract({ ...document, text }, instruction, signal));
        }
        const unique = new Map<string, Fact>();
        for (const item of raw) {
          // Apply current instruction scope to both mock and Gemini output,
          // before summaries, comparisons, discrepancy rules or persistence.
          if (explicitScope && !allowedFields.has(canonicalField(item.field))) continue;
          const fact = groundFact(item, document);
          if (isMissingValue(fact.value)) continue;
          unique.set(`${fact.field}\0${fact.value}\0${fact.evidence.charStart}`, fact);
        }
        if (unique.size > 100) throw new AnalysisError('ANALYSIS_FACT_LIMIT', 'A document produced more than 100 facts. Narrow the instruction or use smaller documents.', 413);
        const individual = [...unique.values()];
        facts.push(...individual);
        for (const fact of individual) findings.push(fromFacts('key_value', fact.field, fact.value, [fact]));
        if (individual.length) findings.push(fromFacts('summary', `Summary: ${document.name}`,
          individual.slice(0, 6).map(fact => `${fact.field}: ${fact.value}`).join('; '), individual.slice(0, 6)));
        if (/missing|incomplete|absent|not provided|not stated/i.test(instruction)) {
          for (const field of missingFields(document, instruction)) {
            // Absence is only a scoped observation. An unlabelled occurrence
            // suppresses a missing finding rather than claiming it is absent.
            if (individual.some(fact => fact.field === field.key)) continue;
            const labels = new RegExp(`(?:^|[\\n;])[ \\t]*(?:[-*•][ \\t]+)?(?:${field.aliases})(?:[ \\t]*[:=][ \\t]*|[ \\t]{2,})([^\\n;]*)`, 'gi');
            const blank = [...document.text.matchAll(labels)].find(match => isMissingValue(match[1]!));
            const blankQuote = blank?.[0].replace(/^[\n;]/, '').trim();
            // Findings always contain a genuine quotation. For absence,
            // this excerpt is explicitly context, not fabricated proof of absence.
            const contextQuote = !blankQuote ? document.text.trimStart().slice(0, 250).trimEnd() : undefined;
            const quote = blankQuote ?? contextQuote;
            if (!blank && new RegExp(`\\b(?:${field.aliases})\\b`, 'i').test(document.text)) continue;
            const start = quote ? document.text.indexOf(quote) : null;
            findings.push({ id: randomUUID(), type: 'missing_information', severity: 'low', contentKind: 'ai_interpretation',
              title: `${field.label} ${blank ? 'value not provided' : 'not located'}`,
              description: blank ? `The ${field.label.toLowerCase()} label is blank or explicitly marked unavailable in the quoted extracted text. Verify the original document and whether this field is applicable.`
                : `No explicit ${field.label.toLowerCase()} label or validated value was located in this document's full extracted text. This is a scope-limited observation, not proof the information is absent from the original file.${contextQuote ? ' The quoted excerpt identifies the searched source and is context only, not evidence proving absence.' : ''}`,
              sources: [{ documentId: document.id, documentName: document.name, quote: quote ?? null,
                charStart: start, charEnd: start !== null && quote ? start + quote.length : null }], values: [] });
          }
        }
      }
      signal.throwIfAborted();
      if (new Set(facts.map(fact => fact.documentId)).size > 1) {
        const deterministic = buildComparisons(facts, instruction);
        const comparedFields = new Set(deterministic.flatMap(proposal => proposal.factIds.map(id => facts.find(fact => fact.id === id)!.field)));
        const proposals = await this.provider.compare(facts, instruction, signal);
        if (proposals.length > 50) throw new AnalysisError('INVALID_AI_OUTPUT', 'Analysis returned too many collective findings.', 502);
        for (const proposal of proposals) {
          const referenced = proposal.factIds.map(factId => facts.find(fact => fact.id === factId));
          if (!referenced.length || referenced.some(fact => !fact) || new Set(referenced.map(fact => fact!.documentId)).size < 2) {
            throw new AnalysisError('UNGROUNDED_AI_OUTPUT', 'A collective finding cited invalid or insufficient source documents. No findings were saved.', 502);
          }
          // Reject new numerical claims even in interpretation prose. All values
          // shown in comparison tables are built exclusively from grounded facts.
          const citedText = referenced.map(fact => fact!.evidence.quote).join(' ');
          const numbers = (text: string) => text.match(/\d[\d,.]*(?:%|\b)/g) ?? [];
          const citedNumbers = new Set(numbers(citedText));
          if (numbers(`${proposal.title} ${proposal.description}`).some(number => !citedNumbers.has(number))) {
            throw new AnalysisError('UNGROUNDED_AI_OUTPUT', 'An interpretation introduced a numerical claim absent from its cited evidence. No findings were saved.', 502);
          }
          // Prefer complete, server-checked comparisons for a matching field;
          // retain provider interpretations that span different fields.
          const referencedFields = new Set(referenced.map(fact => fact!.field));
          if (!(referencedFields.size === 1 && comparedFields.has(referenced[0]!.field))) {
            findings.push(fromFacts(proposal.type, proposal.title, proposal.description, referenced as Fact[], proposal.severity));
          }
        }
        for (const proposal of deterministic) findings.push(fromFacts(proposal.type, proposal.title, proposal.description,
          proposal.factIds.map(id => facts.find(fact => fact.id === id)!), proposal.severity));
      }
      // Recompute from the two sources before persistence and summary counts.
      // Trimming citations alone could retain arithmetic based on other files.
      const scopedFacts = incomeDiscrepancyScope(facts);
      const scopedDiscrepancies = buildComparisons(scopedFacts, instruction)
        .filter(proposal => proposal.type === 'discrepancy')
        .map(proposal => fromFacts(proposal.type, proposal.title, proposal.description,
          proposal.factIds.map(id => scopedFacts.find(fact => fact.id === id)!), proposal.severity));
      const retained = findings.filter(finding => finding.type !== 'discrepancy');
      findings.splice(0, findings.length, ...retained, ...scopedDiscrepancies);
      const limitations = [
        ...(this.context.notices ?? []),
        ...(scopedFacts.length ? ['Discrepancy scope: annual income only, between 01_loan_application.pdf and 02_income_verification.pdf. Other fields and documents are excluded from discrepancy results.'] : []),
        'Quoted facts and offsets are verified against extracted text. Interpretations and severity require human review; extraction and AI can still make mistakes.',
        'Missing-information reports cover only extracted text and configured field labels, not images or information outside these documents.',
        ...(this.provider.mode === 'mock' ? ['Mock mode: deterministic banking-loan field extraction and comparisons. Same-currency differences use exact server arithmetic; broader reasoning requires Gemini mode. Missing-field checks are limited to applicable loan-document fields.'] : []),
        ...(facts.length === 0 ? ['No relevant explicit facts were extracted. No factual conclusions can be drawn for this instruction.'] : []),
      ];
      const result: AnalysisResult = { id, status: 'completed', instruction, mode: this.provider.mode, model: this.provider.model,
        summary: `${this.context.summaryPrefix ?? ''}Reviewed ${documents.length} document(s) individually and collectively. Located ${facts.length} source-backed value(s), ${findings.filter(f => f.type === 'discrepancy').length} potential difference(s), and ${findings.filter(f => f.type === 'missing_information').length} scoped missing-information observation(s).`,
        limitations, documents: documents.map(doc => ({ id: doc.id, name: doc.name, factCount: facts.filter(fact => fact.documentId === doc.id).length })), findings };
      await this.repository.complete(result);
      return result;
    } catch (error) {
      const safe = error instanceof AnalysisError ? error : new AnalysisError('ANALYSIS_FAILED', 'Analysis failed or exceeded its time limit. Please retry.', 502);
      await this.repository.fail(id, safe.message).catch(() => undefined);
      throw safe;
    }
  }

  async get(id: string) {
    if (!/^[1-9]\d{0,19}$/.test(id)) throw new AnalysisError('INVALID_ANALYSIS_ID', 'Analysis ID must be a positive integer.', 400);
    const result = await this.repository.get(id);
    if (!result) throw new AnalysisError('ANALYSIS_NOT_FOUND', 'Completed analysis not found.', 404);
    return result;
  }
}
