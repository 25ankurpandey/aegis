/**
 * W5-05 — the pure statutory-tax math. Tax is DATA: these prove the engine interprets
 * `tax_rules.params` (flat + progressive brackets) rather than hard-coding rates, and that the
 * pre-tax flag is read tolerantly from either `pre_tax` or `is_pre_tax`.
 */
import { deductionPreTaxFlag, taxForRule, totalTaxForRules } from '../../src/utils/tax-engine';

describe('tax-engine — flat rate', () => {
  it('taxes a flat fraction of the base (minor units, rounded)', () => {
    expect(taxForRule(100_00, { rate: 0.2 })).toBe(20_00);
    // Rounds to nearest minor unit.
    expect(taxForRule(101, { rate: 0.2 })).toBe(20); // 20.2 → 20
  });

  it('returns 0 for a non-positive base or absent params (the seeded/empty case via the data path)', () => {
    expect(taxForRule(0, { rate: 0.2 })).toBe(0);
    expect(taxForRule(-5, { rate: 0.2 })).toBe(0);
    expect(taxForRule(100_00, null)).toBe(0);
    expect(taxForRule(100_00, {})).toBe(0);
  });
});

describe('tax-engine — progressive brackets', () => {
  // 0–1,000 @ 0%, 1,000–5,000 @ 10%, 5,000+ @ 25% (minor units).
  const brackets = [
    { up_to: 1_000_00, rate: 0 },
    { up_to: 5_000_00, rate: 0.1 },
    { up_to: null, rate: 0.25 },
  ];

  it('only the open-ended top band applies above the last ceiling', () => {
    // base 8,000: 0 on first 1k, 10% on next 4k (=400), 25% on last 3k (=750) → 1,150.
    expect(taxForRule(8_000_00, { brackets })).toBe(1_150_00);
  });

  it('taxes only the slice that falls inside each band', () => {
    // base 3,000: 0 + 10% of 2,000 = 200.
    expect(taxForRule(3_000_00, { brackets })).toBe(200_00);
  });

  it('is order-independent (bands are sorted by ceiling)', () => {
    const shuffled = [brackets[2], brackets[0], brackets[1]];
    expect(taxForRule(8_000_00, { brackets: shuffled })).toBe(1_150_00);
  });
});

describe('tax-engine — multiple rules sum over the same base', () => {
  it('adds income tax + a flat social charge', () => {
    const rules = [{ params: { rate: 0.2 } }, { params: { rate: 0.05 } }];
    expect(totalTaxForRules(1_000_00, rules)).toBe(250_00);
  });

  it('an empty rule set yields zero tax via the lookup path', () => {
    expect(totalTaxForRules(1_000_00, [])).toBe(0);
  });
});

describe('deductionPreTaxFlag — tolerant of either column name', () => {
  it('reads pre_tax (0005 canonical column)', () => {
    expect(deductionPreTaxFlag({ id: 'd', tenant_id: 't', name: '401k', pre_tax: true })).toBe(true);
  });
  it('reads is_pre_tax (0018 fallback column)', () => {
    expect(deductionPreTaxFlag({ id: 'd', tenant_id: 't', name: 'hsa', is_pre_tax: true })).toBe(true);
  });
  it('defaults to false (post-tax) when neither flag is set or the code is missing', () => {
    expect(deductionPreTaxFlag({ id: 'd', tenant_id: 't', name: 'union' })).toBe(false);
    expect(deductionPreTaxFlag(undefined)).toBe(false);
  });
});
