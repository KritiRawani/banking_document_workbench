import { factsForInstruction, fields, groupedFacts } from './rules.js';
import type { Fact, Proposal } from './types.js';

const moneyFields = new Set(['annual_income', 'monthly_income', 'loan', 'obligation', 'property_value', 'revenue', 'profit', 'assets', 'liabilities']);
const discrepancyDocuments = ['01_loan_application.pdf', '02_income_verification.pdf'];

export function incomeDiscrepancyScope(facts: Fact[]): Fact[] {
  const scoped = facts.filter(fact => fact.field === 'annual_income' && discrepancyDocuments.includes(fact.evidence.documentName.toLowerCase()));
  const names = new Set(scoped.map(fact => fact.evidence.documentName.toLowerCase()));
  const ids = new Set(scoped.map(fact => fact.documentId));
  // Require both named sources; never select ambiguous duplicate versions.
  return discrepancyDocuments.every(name => names.has(name)) && ids.size === 2 ? scoped : [];
}
interface Money { currency: string; minor: bigint }

// Integer minor units avoid floating-point rounding. No exchange rates,
// annualisation, unit assumptions, estimates or model arithmetic are used.
export function parseMoney(value: string): Money | undefined {
  const match = /^(INR|₹|Rs\.?|USD|EUR|€|GBP|£)\s*((?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d{1,2})?)$/i.exec(value.trim());
  if (!match) return undefined;
  const currency = /^(?:INR|₹|Rs\.?)$/i.test(match[1]!) ? 'INR' : /^(?:EUR|€)$/i.test(match[1]!) ? 'EUR' : /^(?:GBP|£)$/i.test(match[1]!) ? 'GBP' : 'USD';
  const [whole, fraction = ''] = match[2]!.replace(/,/g, '').split('.');
  return { currency, minor: BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')) };
}

function formatMoney(money: Money): string {
  const whole = (money.minor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = money.minor % 100n;
  return `${money.currency === 'INR' ? '₹' : `${money.currency} `}${whole}${fraction ? `.${fraction.toString().padStart(2, '0')}` : ''}`;
}

export function comparisonRequested(instruction: string): boolean {
  return !/(?:no|without)\s+comparisons?|(?:do not|don't|never)\s+compare/i.test(instruction) &&
    /compar|inconsisten|discrepan|mismatch|differ|across|collective|financial|\bmatch(?:es|ing)?\b/i.test(instruction);
}

export function buildComparisons(facts: Fact[], instruction: string): Proposal[] {
  if (!comparisonRequested(instruction)) return [];
  const proposals: Proposal[] = [];
  // Enforce the current instruction even when a caller supplies broad facts.
  for (const [field, group] of groupedFacts(factsForInstruction(facts, instruction))) {
    if (new Set(group.map(fact => fact.documentId)).size < 2) continue;
    const label = fields.find(item => item.key === field)?.label ?? field;
    const textValues = new Set(group.map(fact => fact.value.trim().replace(/\s+/g, ' ').toLowerCase()));
    const amounts = moneyFields.has(field) ? group.map(fact => ({ fact, money: parseMoney(fact.value) })) : [];
    const parsed = amounts.filter((item): item is { fact: Fact; money: Money } => Boolean(item.money));
    const docAmounts = new Map<string, Set<string>>();
    for (const item of amounts) {
      const key = item.money ? `${item.money.currency}:${item.money.minor}` : `unparsed:${item.fact.value}`;
      docAmounts.set(item.fact.documentId, new Set([...(docAmounts.get(item.fact.documentId) ?? []), key]));
    }
    const unambiguous = [...new Map(parsed.filter(item => docAmounts.get(item.fact.documentId)?.size === 1)
      .map(item => [item.fact.documentId, item] as const)).values()];
    const differences: string[] = [];
    for (let i = 0; i < unambiguous.length; i++) for (let j = i + 1; j < unambiguous.length; j++) {
      const left = unambiguous[i]!;
      const right = unambiguous[j]!;
      if (left.money.currency !== right.money.currency || left.money.minor === right.money.minor) continue;
      const high = left.money.minor > right.money.minor ? left : right;
      const low = high === left ? right : left;
      differences.push(`${high.fact.evidence.documentName} reports ${formatMoney(high.money)}; ${low.fact.evidence.documentName} reports ${formatMoney(low.money)}. Calculated absolute difference: ${formatMoney({ currency: high.money.currency, minor: high.money.minor - low.money.minor })} (${formatMoney(high.money)} − ${formatMoney(low.money)}).`);
    }
    const completeMoney = amounts.length > 0 && parsed.length === group.length;
    const normalized = new Set(parsed.map(item => `${item.money.currency}:${item.money.minor}`));
    const differentCurrencies = new Set(parsed.map(item => item.money.currency)).size > 1;
    const differs = completeMoney ? normalized.size > 1 : textValues.size > 1;
    const discrepancy = differences.length > 0 || (differs && !differentCurrencies);
    const description = differences.length
      ? `${differences.join('\n')} The difference is calculated from the quoted source values, not an extracted fact. Verify the same applicant, reporting period and gross/net basis before concluding an inconsistency.`
      : differentCurrencies ? 'Reported currencies differ. Values are listed for review; no cross-currency subtraction or exchange-rate assumption was made.'
      : differs ? 'Reported values differ across the matching field. Values are shown verbatim; no numeric difference is calculated for ambiguous amounts, units or multiple values in one document.'
      : completeMoney ? 'Reported amounts match after normalising currency notation and number grouping. Original source values and quotations are preserved.'
      : 'Reported values match after trimming whitespace and case. Original source quotations are preserved.';
    proposals.push({ type: discrepancy ? 'discrepancy' : 'comparison', severity: discrepancy ? 'medium' : 'info',
      title: `${label}: ${discrepancy ? 'mismatch' : differentCurrencies ? 'currency review' : 'matching values'}`, description,
      factIds: group.map(fact => fact.id) });
  }
  return proposals;
}
