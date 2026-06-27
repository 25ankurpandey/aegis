import { Config } from '../../src/config/config';
import { ErrUtils } from '../../src/errors/error-utils';

describe('Config.requireAll (boot-time required-config gate)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('returns the resolved map when every key is present', () => {
    process.env.A_KEY = 'a';
    process.env.B_KEY = 'b';
    expect(Config.requireAll(['A_KEY', 'B_KEY'])).toEqual({ A_KEY: 'a', B_KEY: 'b' });
  });

  it('throws an aggregated error listing EVERY missing key (not just the first)', () => {
    process.env.PRESENT = 'x';
    delete process.env.MISSING_ONE;
    delete process.env.MISSING_TWO;
    let caught: unknown;
    try {
      Config.requireAll(['PRESENT', 'MISSING_ONE', 'MISSING_TWO']);
    } catch (err) {
      caught = err;
    }
    expect(ErrUtils.isAppError(caught)).toBe(true);
    const message = (caught as Error).message;
    expect(message).toContain('MISSING_ONE');
    expect(message).toContain('MISSING_TWO');
    expect(message).not.toContain('PRESENT');
    expect((caught as { details?: { missing?: string[] } }).details?.missing).toEqual([
      'MISSING_ONE',
      'MISSING_TWO',
    ]);
  });

  it('treats an empty-string value as missing', () => {
    process.env.EMPTY = '';
    expect(() => Config.requireAll(['EMPTY'])).toThrow(/EMPTY/);
  });

  it('does not throw for an empty key list', () => {
    expect(Config.requireAll([])).toEqual({});
  });
});
