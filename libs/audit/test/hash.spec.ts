import { computeAuditHash, GENESIS_HASH, type AuditPayload } from '../src/hash';

const entry = (over: Partial<AuditPayload> = {}): AuditPayload => ({
  tenant_id: 't1',
  actor_id: 'u1',
  action: 'role.assigned',
  outcome: 'success',
  resource_type: 'user',
  resource_id: 'u2',
  details: { role: 'admin' },
  permissions: ['role.assign'],
  ...over,
});

describe('audit hash chain', () => {
  it('is deterministic', () => {
    expect(computeAuditHash(GENESIS_HASH, entry())).toEqual(computeAuditHash(GENESIS_HASH, entry()));
  });

  it('canonicalizes nested JSON object key order before hashing', () => {
    const appOrder = entry({
      details: {
        entity: 'expense',
        ruleId: 'expense.approve',
        status: 'synced',
        externalId: 'ledger_one-exp-1',
        connectorKind: 'ledger_one',
        idempotencyKey: 'exp-1',
      },
      permissions: [{ action: 'b', domain: 'expense' }, { domain: 'invoice', action: 'a' }],
    });
    const jsonbOrder = entry({
      details: {
        connectorKind: 'ledger_one',
        entity: 'expense',
        externalId: 'ledger_one-exp-1',
        idempotencyKey: 'exp-1',
        ruleId: 'expense.approve',
        status: 'synced',
      },
      permissions: [{ domain: 'expense', action: 'b' }, { action: 'a', domain: 'invoice' }],
    });

    expect(computeAuditHash(GENESIS_HASH, appOrder)).toEqual(computeAuditHash(GENESIS_HASH, jsonbOrder));
  });

  it('changes when any field changes', () => {
    const base = computeAuditHash(GENESIS_HASH, entry());
    expect(computeAuditHash(GENESIS_HASH, entry({ action: 'role.created' }))).not.toEqual(base);
    expect(computeAuditHash(GENESIS_HASH, entry({ actor_id: 'someone-else' }))).not.toEqual(base);
  });

  it('chains so tampering an early entry breaks every later hash', () => {
    // Build a 3-entry chain.
    const h1 = computeAuditHash(GENESIS_HASH, entry({ action: 'a1' }));
    const h2 = computeAuditHash(h1, entry({ action: 'a2' }));
    const h3 = computeAuditHash(h2, entry({ action: 'a3' }));

    // Tamper with entry 1; recompute downstream from the altered hash.
    const h1Tampered = computeAuditHash(GENESIS_HASH, entry({ action: 'a1-TAMPERED' }));
    const h2FromTamper = computeAuditHash(h1Tampered, entry({ action: 'a2' }));
    const h3FromTamper = computeAuditHash(h2FromTamper, entry({ action: 'a3' }));

    expect(h1Tampered).not.toEqual(h1);
    expect(h2FromTamper).not.toEqual(h2);
    expect(h3FromTamper).not.toEqual(h3); // the break propagates to the tip
  });
});
