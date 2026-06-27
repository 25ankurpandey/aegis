import { NotificationChannel } from '@aegis/shared-enums';
import type { NotificationShape } from '@aegis/shared-types';
import { NotificationPreferenceRepository } from '../../src/repositories/notification-preference.repository';
import * as ctx from '../../src/models/database-context';

/** A plain row wrapped to mimic a Sequelize instance's `.get({ plain: true })`. */
function instance(row: NotificationShape.NotificationPreferenceRow) {
  return { get: () => row };
}

function makeRow(
  over: Partial<NotificationShape.NotificationPreferenceRow>,
): NotificationShape.NotificationPreferenceRow {
  return {
    id: 'p',
    tenant_id: 't',
    user_id: null,
    event_type: 'expense/approved',
    channel: NotificationChannel.Email,
    enabled: true,
    created_by: null,
    updated_by: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

describe('NotificationPreferenceRepository.isChannelEnabled (W3-10 default-on gate)', () => {
  const tx = {} as never;
  let repo: NotificationPreferenceRepository;
  let findAll: jest.Mock;

  beforeEach(() => {
    repo = new NotificationPreferenceRepository();
    findAll = jest.fn();
    jest
      .spyOn(ctx, 'getNotificationContext')
      .mockReturnValue({ NotificationPreference: { findAll } } as never);
  });

  afterEach(() => jest.restoreAllMocks());

  const lookup = {
    userId: 'u1',
    eventType: 'expense/approved',
    channel: NotificationChannel.Email,
  };

  it('defaults ON when there is no preference row', async () => {
    findAll.mockResolvedValue([]);
    expect(await repo.isChannelEnabled(lookup, tx)).toBe(true);
  });

  it('suppresses the channel when a user-specific row disables it', async () => {
    findAll.mockResolvedValue([instance(makeRow({ user_id: 'u1', enabled: false }))]);
    expect(await repo.isChannelEnabled(lookup, tx)).toBe(false);
  });

  it('honors a tenant-wide default (user_id NULL) when no user-specific row exists', async () => {
    findAll.mockResolvedValue([instance(makeRow({ user_id: null, enabled: false }))]);
    expect(await repo.isChannelEnabled(lookup, tx)).toBe(false);
  });

  it('lets a user-specific row OVERRIDE a tenant-wide default', async () => {
    findAll.mockResolvedValue([
      instance(makeRow({ user_id: null, enabled: false })), // tenant default: off
      instance(makeRow({ user_id: 'u1', enabled: true })), // user override: on
    ]);
    expect(await repo.isChannelEnabled(lookup, tx)).toBe(true);
  });
});
