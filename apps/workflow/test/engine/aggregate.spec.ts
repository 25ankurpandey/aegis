import { RuleRunStatus } from '@aegis/shared-enums';
import { aggregateVerdict } from '../../src/engine/aggregate';
import type { ActionStatus } from '../../src/engine/types';

describe('aggregateVerdict', () => {
  it('returns Skipped for no actions', () => {
    expect(aggregateVerdict([])).toBe(RuleRunStatus.Skipped);
  });

  it('returns Success when all actions succeed (or no_update)', () => {
    const statuses: ActionStatus[] = ['success', 'no_update', 'success'];
    expect(aggregateVerdict(statuses)).toBe(RuleRunStatus.Success);
  });

  it('returns Skipped when every action is skipped', () => {
    expect(aggregateVerdict(['skip', 'skip'])).toBe(RuleRunStatus.Skipped);
  });

  it('returns Error when every action errors', () => {
    expect(aggregateVerdict(['error', 'error'])).toBe(RuleRunStatus.Error);
  });

  it('returns PartialSuccess on a success/error mix', () => {
    expect(aggregateVerdict(['success', 'error'])).toBe(RuleRunStatus.PartialSuccess);
  });

  it('returns PartialSuccess on a success/skip mix', () => {
    expect(aggregateVerdict(['success', 'skip'])).toBe(RuleRunStatus.PartialSuccess);
  });
});
