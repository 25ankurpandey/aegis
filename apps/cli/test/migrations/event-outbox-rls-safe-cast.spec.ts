import type { QueryInterface } from 'sequelize';
import { up as up0011 } from '../../src/migrations/0011_event_outbox';
import { up as up0030 } from '../../src/migrations/0030_event_outbox_rls_safe_tenant_cast';

function makeRecorder(): { q: QueryInterface; sql: string[] } {
  const sql: string[] = [];
  const q = {
    createTable: jest.fn(async () => undefined),
    addIndex: jest.fn(async () => undefined),
    sequelize: { query: jest.fn(async (stmt: string) => void sql.push(stmt)) },
  } as unknown as QueryInterface;
  return { q, sql };
}

describe('event_outbox RLS safe tenant cast', () => {
  it('fresh event_outbox migration guards empty tenant settings before uuid casts', async () => {
    const r = makeRecorder();
    await up0011({ context: r.q } as never);

    const policy = r.sql.find((s) => /CREATE POLICY "event_outbox_tenant_isolation"/.test(s));
    expect(policy).toBeDefined();
    expect(policy).toContain("NULLIF(current_setting('app.current_tenant', true), '')::uuid");
    expect(policy).toContain("current_setting('app.outbox_relay', true) = 'on'");
  });

  it('upgrade migration repairs existing event_outbox policies with the same safe predicate', async () => {
    const r = makeRecorder();
    await up0030({ context: r.q } as never);

    const policy = r.sql.find((s) => /CREATE POLICY "event_outbox_tenant_isolation"/.test(s));
    expect(policy).toBeDefined();
    expect(policy).toContain("NULLIF(current_setting('app.current_tenant', true), '')::uuid");
    expect(policy).toContain("current_setting('app.outbox_relay', true) = 'on'");
  });
});
