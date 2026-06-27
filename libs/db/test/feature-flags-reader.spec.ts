import { FeatureFlags } from '@aegis/service-core';
import { getSequelize } from '../src/connection';
import { withTenantTransaction } from '../src/transaction';
import { featureFlagReader, registerDefaultFeatureFlagReader } from '../src/feature-flags-reader';

// Mock the DB seam so the reader is exercised without a real Postgres connection. Factory mocks
// (rather than auto-mock) keep these modules' other exports out of the picture.
jest.mock('../src/connection', () => ({ getSequelize: jest.fn() }));
jest.mock('../src/transaction', () => ({ withTenantTransaction: jest.fn() }));

const mockedGetSequelize = getSequelize as jest.Mock;
const mockedWithTenantTransaction = withTenantTransaction as jest.Mock;

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('featureFlagReader', () => {
  let query: jest.Mock;

  beforeEach(() => {
    query = jest.fn();
    mockedGetSequelize.mockReturnValue({ query });
    // Run the callback with a sentinel transaction, mirroring withTenantTransaction's contract.
    mockedWithTenantTransaction.mockImplementation((fn: (t: unknown) => unknown) => fn('TX'));
  });

  afterEach(() => {
    jest.clearAllMocks();
    FeatureFlags.setReader(undefined);
  });

  it('reads the enabled column inside a tenant-scoped transaction with bound params', async () => {
    query.mockResolvedValue([{ enabled: true }]);

    await expect(featureFlagReader(TENANT, 'expense.visualizer')).resolves.toBe(true);

    // RLS requires the read run under the explicit tenant context, not the ambient request.
    expect(mockedWithTenantTransaction).toHaveBeenCalledWith(expect.any(Function), {
      tenantId: TENANT,
    });
    // Tenant + flag are bound (never interpolated) and the query runs on the scoped transaction.
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM "tenant_features"'),
      expect.objectContaining({ bind: [TENANT, 'expense.visualizer'], transaction: 'TX' }),
    );
  });

  it('returns false when the flag row is present but disabled', async () => {
    query.mockResolvedValue([{ enabled: false }]);
    await expect(featureFlagReader(TENANT, 'payroll.beta')).resolves.toBe(false);
  });

  it('returns undefined when no (tenant, flag) row exists', async () => {
    query.mockResolvedValue([]);
    await expect(featureFlagReader(TENANT, 'unknown.flag')).resolves.toBeUndefined();
  });

  it('registerDefaultFeatureFlagReader wires the reader into FeatureFlags', async () => {
    expect(FeatureFlags.hasReader()).toBe(false);

    registerDefaultFeatureFlagReader();
    expect(FeatureFlags.hasReader()).toBe(true);

    // The helper now resolves a flag through the DB-backed reader.
    query.mockResolvedValue([{ enabled: true }]);
    await expect(FeatureFlags.isEnabledForTenant(TENANT, 'expense.visualizer')).resolves.toBe(true);
  });
});
