import { EmailSuppressionReason } from '@aegis/shared-enums';
import { EmailSuppressionRepository } from '../../src/repositories/email-suppression.repository';
import * as ctx from '../../src/models/database-context';

/** G8 — the suppression-list DAL: case-insensitive `isSuppressed` lookup + idempotent `add`. */
describe('EmailSuppressionRepository', () => {
  const tx = {} as never;
  let repo: EmailSuppressionRepository;
  let findOne: jest.Mock;
  let create: jest.Mock;

  beforeEach(() => {
    repo = new EmailSuppressionRepository();
    findOne = jest.fn();
    create = jest.fn();
    jest
      .spyOn(ctx, 'getNotificationContext')
      .mockReturnValue({ EmailSuppression: { findOne, create } } as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('isSuppressed returns true for a normalized (lower-cased/trimmed) hit', async () => {
    findOne.mockResolvedValue({ get: () => ({ address: 'user@acme.com' }) });

    const hit = await repo.isSuppressed('  User@ACME.com ', tx);

    expect(hit).toBe(true);
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { address: 'user@acme.com' } }),
    );
  });

  it('isSuppressed returns false when no row exists', async () => {
    findOne.mockResolvedValue(null);
    expect(await repo.isSuppressed('user@acme.com', tx)).toBe(false);
  });

  it('add inserts a normalized entry when none exists', async () => {
    findOne.mockResolvedValue(null);
    create.mockResolvedValue({
      get: () => ({ id: 's1', tenant_id: 't1', address: 'user@acme.com', reason: 'bounce', source: 'sns', created_at: new Date() }),
    });

    const row = await repo.add(
      { tenant_id: 't1', address: 'User@Acme.com', reason: EmailSuppressionReason.Bounce, source: 'sns' },
      tx,
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'user@acme.com', reason: EmailSuppressionReason.Bounce, source: 'sns' }),
      expect.anything(),
    );
    expect(row.address).toBe('user@acme.com');
  });

  it('add is idempotent — returns the existing row without inserting', async () => {
    findOne.mockResolvedValue({
      get: () => ({ id: 's1', tenant_id: 't1', address: 'user@acme.com', reason: 'bounce', source: null, created_at: new Date() }),
    });

    const row = await repo.add(
      { tenant_id: 't1', address: 'user@acme.com', reason: EmailSuppressionReason.Complaint },
      tx,
    );

    expect(create).not.toHaveBeenCalled();
    expect(row.id).toBe('s1');
  });
});
