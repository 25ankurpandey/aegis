import { FeatureFlags, type FeatureFlagReader } from '../../src/config/feature-flags';
import { RequestContext } from '../../src/context/request-context';
import type { RequestContextData } from '../../src/context/context.types';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function ctx(tenantId: string): RequestContextData {
  return { tenantId, correlationId: 'corr-1', startedAt: Date.now() };
}

/** In-memory reader so the helper is exercised without a real DB. */
function inMemoryReader(rows: Record<string, Record<string, boolean>>): FeatureFlagReader {
  return async (tenantId, flag) => rows[tenantId]?.[flag];
}

describe('FeatureFlags', () => {
  afterEach(() => FeatureFlags.setReader(undefined));

  it('defaults to false when no reader is registered (graceful default)', async () => {
    expect(FeatureFlags.hasReader()).toBe(false);
    await RequestContext.run(ctx(TENANT_A), async () => {
      expect(await FeatureFlags.isEnabled('expense.visualizer')).toBe(false);
    });
  });

  it('defaults to false when there is no active request context', async () => {
    FeatureFlags.setReader(inMemoryReader({ [TENANT_A]: { 'expense.visualizer': true } }));
    expect(await FeatureFlags.isEnabled('expense.visualizer')).toBe(false);
  });

  it('returns the flag value for the current request tenant', async () => {
    FeatureFlags.setReader(
      inMemoryReader({
        [TENANT_A]: { 'expense.visualizer': true, 'payroll.beta': false },
        [TENANT_B]: { 'expense.visualizer': false },
      }),
    );

    await RequestContext.run(ctx(TENANT_A), async () => {
      expect(await FeatureFlags.isEnabled('expense.visualizer')).toBe(true);
      expect(await FeatureFlags.isEnabled('payroll.beta')).toBe(false);
    });
    await RequestContext.run(ctx(TENANT_B), async () => {
      expect(await FeatureFlags.isEnabled('expense.visualizer')).toBe(false);
    });
  });

  it('defaults to false when the (tenant, flag) row is absent', async () => {
    FeatureFlags.setReader(inMemoryReader({ [TENANT_A]: {} }));
    await RequestContext.run(ctx(TENANT_A), async () => {
      expect(await FeatureFlags.isEnabled('unknown.flag')).toBe(false);
    });
  });

  it('isEnabledForTenant works off the request path', async () => {
    FeatureFlags.setReader(inMemoryReader({ [TENANT_A]: { 'workflow.async': true } }));
    expect(await FeatureFlags.isEnabledForTenant(TENANT_A, 'workflow.async')).toBe(true);
    expect(await FeatureFlags.isEnabledForTenant(TENANT_B, 'workflow.async')).toBe(false);
  });

  it('fails soft to false when the reader throws', async () => {
    FeatureFlags.setReader(async () => {
      throw new Error('db down');
    });
    await RequestContext.run(ctx(TENANT_A), async () => {
      expect(await FeatureFlags.isEnabled('expense.visualizer')).toBe(false);
    });
  });
});
