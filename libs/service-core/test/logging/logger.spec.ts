import { Logger, ALERT_MARKER } from '../../src/logging/logger';

describe('Logger.alert (W2-13 ops channel)', () => {
  it('emits at fatal level and stamps the alert marker', () => {
    // Reach the private pino instance to assert the level + payload.
    const pinoInstance = (Logger as unknown as { logger: { fatal: (...a: unknown[]) => void } }).logger;
    const spy = jest.spyOn(pinoInstance, 'fatal').mockImplementation(() => undefined);
    try {
      Logger.alert('payroll bus drain failed', { service: 'payroll' });
      expect(spy).toHaveBeenCalledTimes(1);
      const [payload, message] = spy.mock.calls[0] as [Record<string, unknown>, string];
      expect(message).toBe('payroll bus drain failed');
      expect(payload[ALERT_MARKER]).toBe(true);
      expect(payload.service).toBe('payroll');
    } finally {
      spy.mockRestore();
    }
  });
});
