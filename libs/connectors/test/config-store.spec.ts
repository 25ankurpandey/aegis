import { ConnectorKind } from '@aegis/shared-enums';
import { StaticConnectorConfigStore } from '../src/config-store';

describe('StaticConnectorConfigStore', () => {
  it('resolves a per-(tenant,kind) config', async () => {
    const store = new StaticConnectorConfigStore();
    const cfg = await store.resolve(ConnectorKind.Finovo, 't9');
    expect(cfg).toEqual({ kind: ConnectorKind.Finovo, tenantId: 't9' });
  });

  it('merges per-kind defaults (baseUrl/credentialsRef/settings) under the resolved identity', async () => {
    const store = new StaticConnectorConfigStore({
      [ConnectorKind.LedgerOne]: { baseUrl: 'https://erp.example', credentialsRef: 'sec/ledger' },
    });
    const cfg = await store.resolve(ConnectorKind.LedgerOne, 't1');
    expect(cfg.baseUrl).toBe('https://erp.example');
    expect(cfg.credentialsRef).toBe('sec/ledger');
    expect(cfg.kind).toBe(ConnectorKind.LedgerOne); // identity is never overridable by a default.
    expect(cfg.tenantId).toBe('t1');
  });

  it('throws for an unknown connector kind', async () => {
    const store = new StaticConnectorConfigStore();
    await expect(store.resolve('nope' as ConnectorKind, 't1')).rejects.toThrow();
  });
});
