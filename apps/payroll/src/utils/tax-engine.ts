import { PayrollShape } from '@aegis/shared-types';

/**
 * Pure statutory-tax math. Tax is DATA: the engine never hard-codes rates — it interprets the
 * effective-dated `tax_rules.params` resolved for the employee's jurisdiction + pay date (SPEC §0/§5).
 *
 * All money is integer minor units. Two rule shapes are supported (see {@link PayrollShape.TaxRuleParams}):
 *   - flat:      `{ rate }`     → tax = round(base * rate)
 *   - bracketed: `{ brackets }` → progressive marginal bands over the base.
 *
 * Multiple resolved rules (e.g. income_tax + social_security) sum. A jurisdiction with no resolved
 * rule yields zero tax — but via this lookup path, NOT a hard-coded constant (the seeded/empty case).
 */

/** Read the pre-tax flag off a deduction code, tolerating either column name (`pre_tax`/`is_pre_tax`). */
export function deductionPreTaxFlag(code: PayrollShape.DeductionCodeRow | undefined): boolean {
  if (!code) return false;
  return code.pre_tax === true || code.is_pre_tax === true;
}

/** Tax one rule against a (non-negative) taxable base, returning minor units (rounded, never negative). */
export function taxForRule(base: number, params: PayrollShape.TaxRuleParams | null | undefined): number {
  if (base <= 0 || !params) return 0;

  // Progressive brackets take precedence when present.
  if (Array.isArray(params.brackets) && params.brackets.length > 0) {
    return taxBrackets(base, params.brackets);
  }
  if (typeof params.rate === 'number' && params.rate > 0) {
    return Math.max(0, Math.round(base * params.rate));
  }
  return 0;
}

/** Sum every resolved rule's tax over the same taxable base. */
export function totalTaxForRules(
  base: number,
  rules: ReadonlyArray<Pick<PayrollShape.TaxRuleRow, 'params'>>,
): number {
  let total = 0;
  for (const rule of rules) {
    total += taxForRule(base, rule.params);
  }
  return total;
}

/** Progressive marginal bands: each band taxes the slice of base in `(prevCeiling, up_to]` at `rate`. */
function taxBrackets(base: number, brackets: PayrollShape.TaxBracket[]): number {
  // Order by ascending ceiling; an omitted/null `up_to` is the open-ended top band (sorts last).
  const ordered = [...brackets].sort((a, b) => ceiling(a) - ceiling(b));
  let tax = 0;
  let prev = 0;
  for (const band of ordered) {
    const top = band.up_to == null ? Number.POSITIVE_INFINITY : band.up_to;
    if (base <= prev) break;
    const slice = Math.min(base, top) - prev;
    if (slice > 0 && band.rate > 0) tax += slice * band.rate;
    prev = top;
  }
  return Math.max(0, Math.round(tax));
}

/** Sort key for a bracket ceiling (open-ended top band sorts last). */
function ceiling(b: PayrollShape.TaxBracket): number {
  return b.up_to == null ? Number.POSITIVE_INFINITY : b.up_to;
}
