/**
 * OFFLINE unit tests for the pure Chargebee webhook → EntitlementChange mapper, plus the
 * applyEntitlementChanges loop against a mocked EntitlementService (no Postgres). The live
 * ingestion path is covered by chargebee-entitlement.integration.spec.ts.
 */
import { parseChargebeeEvent, applyEntitlementChanges } from '../src/entitlement/chargebee-webhook';
import { EntitlementService } from '../src/entitlement/entitlement.service';

jest.mock('../src/entitlement/entitlement.service', () => ({
  EntitlementService: jest.fn(),
}));

const MockedService = EntitlementService as unknown as jest.Mock;

const TENANT = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';

const MODULE_MAP: Record<string, string[]> = {
  'aegis-expense-pro': ['expense'],
  'aegis-suite': ['expense', 'invoice', 'payroll'],
  'addon-payroll': ['payroll'],
  'addon-expense-too': ['expense'],
};

/** Chargebee's standard envelope with sensible defaults; override per test. */
function event(
  eventType: string,
  subscription: Record<string, unknown> = {},
  customer: Record<string, unknown> | null = { id: 'cust_1', cf_tenant_id: TENANT },
): Record<string, unknown> {
  return {
    id: 'ev_1',
    occurred_at: 1751760000,
    event_type: eventType,
    content: {
      subscription: { id: 'sub_1', plan_id: 'aegis-expense-pro', status: 'active', ...subscription },
      ...(customer ? { customer } : {}),
    },
  };
}

describe('parseChargebeeEvent', () => {
  it.each([
    'subscription_created',
    'subscription_activated',
    'subscription_changed',
    'subscription_resumed',
    'subscription_reactivated',
  ])('%s grants the mapped module: enabled/active with no expiry', (type) => {
    expect(parseChargebeeEvent(event(type), { moduleMap: MODULE_MAP })).toEqual([
      {
        tenantId: TENANT,
        moduleId: 'expense',
        enabled: true,
        status: 'active',
        expiresAt: null,
        plan: 'aegis-expense-pro',
      },
    ]);
  });

  it('a non_renewing subscription keeps current_term_end as the paid-through expiry', () => {
    const termEnd = 1760000000; // Chargebee sends Unix SECONDS
    const [change] = parseChargebeeEvent(
      event('subscription_changed', { status: 'non_renewing', current_term_end: termEnd }),
      { moduleMap: MODULE_MAP },
    );
    expect(change.enabled).toBe(true);
    expect(change.status).toBe('active');
    expect(change.expiresAt).toEqual(new Date(termEnd * 1000));
  });

  it('subscription_cancelled keeps access with the paid-through expiry (grace until term end)', () => {
    const termEnd = 1760000000;
    const [change] = parseChargebeeEvent(
      event('subscription_cancelled', { status: 'cancelled', current_term_end: termEnd }),
      { moduleMap: MODULE_MAP },
    );
    expect(change).toEqual({
      tenantId: TENANT,
      moduleId: 'expense',
      enabled: true,
      status: 'active',
      expiresAt: new Date(termEnd * 1000),
      plan: 'aegis-expense-pro',
    });
  });

  it('subscription_deleted disables the module (status cancelled)', () => {
    const [change] = parseChargebeeEvent(event('subscription_deleted'), { moduleMap: MODULE_MAP });
    expect(change).toEqual({
      tenantId: TENANT,
      moduleId: 'expense',
      enabled: false,
      status: 'cancelled',
      expiresAt: null,
      plan: 'aegis-expense-pro',
    });
  });

  it('subscription_paused suspends the module', () => {
    const [change] = parseChargebeeEvent(event('subscription_paused'), { moduleMap: MODULE_MAP });
    expect(change.enabled).toBe(false);
    expect(change.status).toBe('suspended');
    expect(change.expiresAt).toBeNull();
  });

  it('unknown event types map to nothing', () => {
    expect(parseChargebeeEvent(event('payment_succeeded'), { moduleMap: MODULE_MAP })).toEqual([]);
    expect(parseChargebeeEvent(event('customer_changed'), { moduleMap: MODULE_MAP })).toEqual([]);
  });

  it('a plan_id absent from the moduleMap is skipped (never guessed)', () => {
    const payload = event('subscription_created', { plan_id: 'some-unknown-plan' });
    expect(parseChargebeeEvent(payload, { moduleMap: MODULE_MAP })).toEqual([]);
    expect(parseChargebeeEvent(payload, { moduleMap: {} })).toEqual([]); // {} default map
  });

  it('a missing tenant custom field is skipped', () => {
    const payload = event('subscription_created', {}, { id: 'cust_1' }); // no cf_tenant_id anywhere
    expect(parseChargebeeEvent(payload, { moduleMap: MODULE_MAP })).toEqual([]);
  });

  it('a non-UUID tenant is skipped (unmapped tenants are never guessed)', () => {
    const payload = event('subscription_created', {}, { id: 'cust_1', cf_tenant_id: 'tenant-42' });
    expect(parseChargebeeEvent(payload, { moduleMap: MODULE_MAP })).toEqual([]);
  });

  it('falls back to subscription.cf_tenant_id when the customer carries none', () => {
    const payload = event('subscription_created', { cf_tenant_id: OTHER_TENANT }, { id: 'cust_1' });
    const changes = parseChargebeeEvent(payload, { moduleMap: MODULE_MAP });
    expect(changes).toHaveLength(1);
    expect(changes[0].tenantId).toBe(OTHER_TENANT);
  });

  it('maps addons alongside the plan, skipping unmapped addon ids and deduplicating modules', () => {
    const payload = event('subscription_created', {
      plan_id: 'aegis-expense-pro',
      addons: [{ id: 'addon-payroll' }, { id: 'addon-expense-too' }, { id: 'unmapped-addon' }],
    });
    const changes = parseChargebeeEvent(payload, { moduleMap: MODULE_MAP });
    // expense from the plan (addon-expense-too deduped into it) + payroll from the addon.
    expect(changes.map((c) => c.moduleId)).toEqual(['expense', 'payroll']);
    expect(changes.every((c) => c.plan === 'aegis-expense-pro')).toBe(true);
  });

  it('a suite plan fans out to every module it grants', () => {
    const payload = event('subscription_created', { plan_id: 'aegis-suite' });
    const changes = parseChargebeeEvent(payload, { moduleMap: MODULE_MAP });
    expect(changes.map((c) => c.moduleId)).toEqual(['expense', 'invoice', 'payroll']);
  });

  it.each([
    [null],
    ['a string'],
    [42],
    [[]],
    [{}],
    [{ event_type: 'subscription_created' }], // no content
    [{ event_type: 'subscription_created', content: {} }], // no subscription
    [{ content: { subscription: { plan_id: 'aegis-expense-pro' } } }], // no event_type
  ])('malformed payload %p yields [] (total, never throws)', (payload) => {
    expect(parseChargebeeEvent(payload, { moduleMap: MODULE_MAP })).toEqual([]);
  });

  it('honors a custom resolveTenantId, still enforcing the UUID rule', () => {
    const payload = event('subscription_created', {}, { id: 'cust_1' }); // default resolver finds nothing
    const viaCustom = parseChargebeeEvent(payload, {
      moduleMap: MODULE_MAP,
      resolveTenantId: () => OTHER_TENANT,
    });
    expect(viaCustom.map((c) => c.tenantId)).toEqual([OTHER_TENANT]);

    const nonUuid = parseChargebeeEvent(payload, {
      moduleMap: MODULE_MAP,
      resolveTenantId: () => 'not-a-uuid',
    });
    expect(nonUuid).toEqual([]);
  });
});

describe('applyEntitlementChanges (mocked EntitlementService)', () => {
  beforeEach(() => {
    MockedService.mockReset();
    MockedService.mockImplementation(() => ({
      setModuleEntitlement: jest.fn().mockResolvedValue({}),
    }));
  });

  it('applies each change under its OWN tenant and returns the applied count', async () => {
    const changes = parseChargebeeEvent(event('subscription_created', { plan_id: 'aegis-suite' }), {
      moduleMap: MODULE_MAP,
    });
    await expect(applyEntitlementChanges(changes)).resolves.toBe(3);

    expect(MockedService).toHaveBeenCalledTimes(3);
    expect(MockedService).toHaveBeenNthCalledWith(1, { tenantId: TENANT });
    const firstInstance = MockedService.mock.results[0].value as {
      setModuleEntitlement: jest.Mock;
    };
    expect(firstInstance.setModuleEntitlement).toHaveBeenCalledWith({
      moduleId: 'expense',
      enabled: true,
      status: 'active',
      expiresAt: null,
      plan: 'aegis-suite',
    });
  });

  it('applies nothing (and returns 0) for an empty change set', async () => {
    await expect(applyEntitlementChanges([])).resolves.toBe(0);
    expect(MockedService).not.toHaveBeenCalled();
  });
});
