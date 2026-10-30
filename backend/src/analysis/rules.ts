import { AnalysisError, type AnalysisDocument, type Fact, type RawFact } from './types.js';

// Aliases keep the mock implementation explicit, deterministic and auditable.
export const fields = [
  { key: 'company', label: 'Company/applicant name', aliases: 'company(?: name)?|applicant(?: name)?|borrower(?: name)?|legal name|name', intent: /\b(compan(?:y|ies)|names?|applicants?|borrowers?)\b/i },
  { key: 'address', label: 'Residential/registered address', aliases: 'address on application|(?:registered |business |residential )?address', intent: /\baddresses?\b/i },
  { key: 'property_address', label: 'Property address', aliases: 'property address', intent: /\b(addresses?|property)\b/i },
  { key: 'licence', label: 'Licence number', aliases: 'licen[cs]e(?: number| details| no\.?)?', intent: /\blicen[cs]e\b/i },
  { key: 'revenue', label: 'Annual revenue', aliases: '(?:annual |total )?(?:revenue|turnover)', intent: /\b(revenues?|turnover|financial)\b/i },
  { key: 'loan', label: 'Requested loan', aliases: '(?:requested loan amount|requested loan|loan amount|requested amount)', intent: /\b(loans?|requested amount|financial)\b/i },
  { key: 'date', label: 'Application date', aliases: 'application date|date', intent: /\bdates?\b/i },
  { key: 'expiry', label: 'Licence expiry', aliases: '(?:licen[cs]e )?(?:expiry date|expiration date|expires)', intent: /\b(expir\w*|licen[cs]e|dates?)\b/i },
  { key: 'obligation', label: 'Monthly obligation/payment', aliases: '(?:declared |verified )?monthly obligations?|obligations?|monthly emi|payment due|repayment|due date', intent: /\b(obligations?|payments?|repayments?|emi|due|financial)\b/i },
  { key: 'profit', label: 'Net profit', aliases: '(?:net )?profit', intent: /\b(profit|financial)\b/i },
  { key: 'assets', label: 'Total assets', aliases: '(?:total )?assets', intent: /\b(assets|financial)\b/i },
  { key: 'liabilities', label: 'Total liabilities', aliases: '(?:total )?liabilities', intent: /\b(liabilities|financial)\b/i },
  { key: 'annual_income', label: 'Annual income', aliases: '(?:(?:verified|declared|gross|net) )?annual income', intent: /\b(income|financial)\b/i },
  { key: 'monthly_income', label: 'Monthly income', aliases: '(?:(?:verified|declared|gross|net) )?monthly income', intent: /\b(income|financial)\b/i },
  { key: 'property_value', label: 'Property valuation', aliases: '(?:estimated |assessed )?(?:property value|market value)|valuation amount', intent: /\b(property|valuation|financial)\b/i },
  { key: 'birth_date', label: 'Date of birth', aliases: 'date of birth|dob', intent: /\b(birth|dob|dates?|identity)\b/i },
  { key: 'purpose', label: 'Loan purpose', aliases: 'loan purpose|purpose of loan', intent: /\b(purpose|loans?)\b/i },
  { key: 'employment', label: 'Employer/employment', aliases: 'employment|employer(?: name)?', intent: /\b(employ\w*|income)\b/i },
  { key: 'employment_type', label: 'Employment type', aliases: 'employment types?|employment status|type of employment', intent: /\b(employ\w*|income)\b/i },
  { key: 'application_id', label: 'Application ID', aliases: 'application id|application number', intent: /\b(application id|application number|identity)\b/i },
  { key: 'review_date', label: 'Review date', aliases: 'review date', intent: /\b(review date|dates?)\b/i },
  { key: 'valuation_date', label: 'Valuation date', aliases: 'valuation date', intent: /\b(valuation|dates?)\b/i },
  { key: 'verification_date', label: 'Verification date', aliases: 'verification date', intent: /\b(verification|dates?)\b/i },
  { key: 'credit_score', label: 'Credit score', aliases: '(?:credit|cibil) score', intent: /\b(credit|cibil|score|financial)\b/i },
];

const businessOnly = new Set(['licence', 'expiry', 'revenue', 'profit', 'assets', 'liabilities']);
export const loanFields = fields.filter(field => !businessOnly.has(field.key));

export function instructionFieldText(instruction: string): string {
  // Document references describe where to compare, not what to compare.
  // In "employment type in income verification", income is a source name.
  return instruction
    .replace(/[^\s"'<>]+\.(?:pdf|txt)\b/gi, ' ')
    .replace(/\b(?:loan[\s_-]+application|income[\s_-]+verification|property[\s_-]+valuation|credit[\s_-]+review(?:[\s_-]+notes)?)\b(?:\s+(?:documents?|files?|reports?|forms?|pdfs?))?/gi, ' ')
    .replace(/[_\u2010-\u2015-]/g, ' ');
}

export function explicitInstructionFields(instruction: string) {
  const fieldText = instructionFieldText(instruction);
  const mentions = fields.flatMap(field => [...fieldText.matchAll(new RegExp(`\\b(?:${field.aliases})\\b`, 'gi'))]
    .map(match => ({ field, start: match.index!, end: match.index! + match[0].length })));
  // Prefer the whole phrase: "employment type" must not also select employer,
  // and "annual income" must not expand into every income-related field.
  const precise = mentions.filter(item => !mentions.some(other => other !== item && other.start <= item.start && other.end >= item.end && other.end - other.start > item.end - item.start));
  const characters = fieldText.split('');
  for (const item of precise) characters.fill(' ', item.start, item.end);
  const remaining = characters.join('').replace(/\b(?:banking\s+)?loan\s+documents?\b/gi, 'documents');
  return fields.filter(field => precise.some(item => item.field.key === field.key) || field.intent.test(remaining));
}

export function factsForInstruction(facts: Fact[], instruction: string): Fact[] {
  if (!explicitInstructionFields(instruction).length) return facts;
  const allowed = new Set(requestedFields(instruction).map(field => field.key));
  return facts.filter(fact => allowed.has(canonicalField(fact.field)));
}

export function requestedFields(instruction: string) {
  const explicit = explicitInstructionFields(instruction);
  const broadLoanReview = /\b(?:all|uploaded|supporting|banking)\s+(?:(?:the|banking|loan)\s+)*documents?\b|\bloan documents?\b/i.test(instruction) && !/\bonly\b/i.test(instruction);
  const selected = explicit.length ? explicit : broadLoanReview || /compar|summar|inconsisten|discrepan|missing|key|extract|review|analys|analyz|consolidat|insight/i.test(instruction) ? loanFields : [];
  return selected.filter(field => !new RegExp(`(?:ignore|exclude|omit|without|do not (?:include|extract|compare)|don't (?:include|extract|compare))[ \\t]+(?:the[ \\t]+)?(?:${field.aliases})\\b`, 'i').test(instruction));
}

// Missing fields must be applicable to that source's role. A valuation report
// need not contain income; an income verification need not contain loan purpose.
export function missingFields(document: AnalysisDocument, instruction: string) {
  const marker = `${document.name}\n${document.text.slice(0, 300)}`.toLowerCase().replace(/[_-]/g, ' ');
  let applicable: string[];
  if (/income verification/.test(marker)) applicable = ['application_id', 'company', 'annual_income', 'monthly_income', 'employment', 'employment_type', 'verification_date'];
  else if (/property valuation/.test(marker)) applicable = ['application_id', 'company', 'property_address', 'property_value', 'valuation_date'];
  else if (/credit (?:review|notes)/.test(marker)) applicable = ['application_id', 'company', 'review_date'];
  else if (/loan application/.test(marker)) applicable = ['application_id', 'company', 'birth_date', 'address', 'loan', 'purpose', 'annual_income', 'employment', 'employment_type', 'obligation'];
  else applicable = loanFields.map(field => field.key);
  return requestedFields(instruction).filter(field => !businessOnly.has(field.key) && applicable.includes(field.key));
}

export function canonicalField(field: string): string {
  const exact = fields.find(item => item.key === field.trim().toLowerCase());
  if (exact) return exact.key;
  const normalized = field.trim().toLowerCase().replace(/[_-]/g, ' ');
  return fields.find(item => item.key === normalized || new RegExp(`^(?:${item.aliases})$`, 'i').test(normalized))?.key ?? normalized;
}

export function isMissingValue(value: string): boolean {
  return /^(?:|n\/?a|not (?:provided|available|stated|applicable)|missing|unknown|none|[-–—])$/i.test(value.trim());
}

export function extractRules(document: AnalysisDocument, instruction: string): RawFact[] {
  const facts: RawFact[] = [];
  for (const field of requestedFields(instruction)) {
    const pattern = new RegExp(`(?:^|[\\n;])[ \\t]*(?:[-*•][ \\t]+)?(${field.aliases})(?:[ \\t]*[:=][ \\t]*|[ \\t]{2,})([^\\n;]+)`, 'gi');
    for (const match of document.text.matchAll(pattern)) {
      const quote = match[0].replace(/^[\n;]/, '').trim();
      const value = match[2]!.trim();
      if (!isMissingValue(value) && quote.length <= 1500 && value.length <= 500) facts.push({ field: field.key, value, quote });
    }
    // PDFs often have prose instead of labelled lines. Only extract an explicit
    // monetary value immediately following a financial field; never infer one.
    if (['revenue', 'loan', 'profit', 'assets', 'liabilities', 'annual_income', 'monthly_income', 'property_value', 'obligation'].includes(field.key)) {
      const prose = new RegExp(`\\b(?:${field.aliases})\\s*(?::|=|is|of)?\\s*((?:(?:INR|USD|EUR|GBP|Rs\\.?|[$€£₹])\\s*)?[0-9][0-9,.]*(?:\\s*(?:million|billion|crore|lakh))?)`, 'gi');
      for (const match of document.text.matchAll(prose)) {
        if (!facts.some(fact => fact.field === field.key && fact.value === match[1]!.trim())) {
          facts.push({ field: field.key, value: match[1]!.trim(), quote: match[0] });
        }
      }
    }
  }
  if (facts.length > 100) throw new AnalysisError('ANALYSIS_FACT_LIMIT', 'More than 100 facts were found in a document chunk. Narrow the instruction.', 413);
  return facts;
}

export function groupedFacts(facts: Fact[]): Map<string, Fact[]> {
  const groups = new Map<string, Fact[]>();
  for (const fact of facts) groups.set(fact.field, [...(groups.get(fact.field) ?? []), fact]);
  return groups;
}
