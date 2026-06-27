/**
 * Proves the optimistic-locking schema invariant (W2-08) and the invoice-number index (W2-10).
 *
 * Optimistic locking: every mutable AGGREGATE-ROOT table that is read-modify-written by concurrent
 * actors carries a `lock_version` INTEGER NOT NULL DEFAULT 0 column (Sequelize `version:true` maps
 * to it and adds a `WHERE lock_version = ?` guard, throwing OptimisticLockError on a stale write).
 * Append-only / log tables (`*_activities`, `*_audit_logs`, idempotent ledgers) must NOT carry it.
 *
 * Like the partial-unique-index spec, these run each migration's `up` against a recording fake
 * QueryInterface and assert on the captured DDL — no database required.
 */
import type { QueryInterface } from 'sequelize';
import { up as up0001 } from '../../src/migrations/0001_identity';
import { up as up0002 } from '../../src/migrations/0002_invoice';
import { up as up0003 } from '../../src/migrations/0003_expense';
import { up as up0004 } from '../../src/migrations/0004_workflow';
import { up as up0005 } from '../../src/migrations/0005_payroll';

interface RecordedTable {
  name: string;
  attributes: Record<string, { defaultValue?: unknown; allowNull?: unknown }>;
}
interface RecordedIndex {
  table: string;
  fields: readonly (string | object)[];
  options: { unique?: boolean; name?: string; where?: Record<string, unknown> };
}

function makeRecorder(): { q: QueryInterface; tables: RecordedTable[]; indexes: RecordedIndex[] } {
  const tables: RecordedTable[] = [];
  const indexes: RecordedIndex[] = [];
  const q = {
    createTable: jest.fn(async (name: string, attributes: RecordedTable['attributes']) => {
      tables.push({ name, attributes });
    }),
    addIndex: jest.fn(
      async (table: string, fields: readonly (string | object)[], options: RecordedIndex['options'] = {}) => {
        indexes.push({ table, fields, options });
      },
    ),
    addConstraint: jest.fn(async () => undefined),
    sequelize: { query: jest.fn(async () => undefined) },
  } as unknown as QueryInterface;
  return { q, tables, indexes };
}

/** Run every migration up against one shared recorder so cross-file assertions see all tables. */
async function runAll() {
  const r = makeRecorder();
  for (const up of [up0001, up0002, up0003, up0004, up0005]) {
    await up({ context: r.q } as never);
  }
  return r;
}

function table(tables: RecordedTable[], name: string): RecordedTable | undefined {
  return tables.find((t) => t.name === name);
}
function hasLockVersion(tables: RecordedTable[], name: string): boolean {
  const t = table(tables, name);
  return !!t && Object.prototype.hasOwnProperty.call(t.attributes, 'lock_version');
}

describe('optimistic locking (lock_version) on mutable aggregate roots — W2-08', () => {
  let tables: RecordedTable[];
  let indexes: RecordedIndex[];
  beforeAll(async () => {
    const r = await runAll();
    tables = r.tables;
    indexes = r.indexes;
  });

  // These are the aggregate roots with concurrent-update risk (status machines / mutable masters).
  it.each([
    ['users', '0001'],
    ['roles', '0001'],
    ['invoices', '0002'],
    ['expense_reports', '0003'],
    ['rules', '0004'],
    ['employees', '0005'],
    ['pay_runs', '0005'],
  ])('%s carries a NOT NULL lock_version DEFAULT 0', (name) => {
    expect(hasLockVersion(tables, name)).toBe(true);
    const col = table(tables, name)!.attributes['lock_version'] as { allowNull: boolean; defaultValue: number };
    expect(col.allowNull).toBe(false);
    expect(col.defaultValue).toBe(0);
  });

  // Append-only / log / ledger tables must NOT be optimistically locked (they are never updated).
  it.each([
    'invoice_activities',
    'expense_activities',
    'rule_audit_logs',
    'payments',
    'payroll_input_items',
    'ledger_entries',
  ])('append-only/log table %s has no lock_version', (name) => {
    // Only assert when the table was actually created in the recorded set.
    if (table(tables, name)) {
      expect(hasLockVersion(tables, name)).toBe(false);
    }
  });

  it('the domain effective-dating tax_rules.version is left untouched (not an optimistic lock)', () => {
    // tax_rules has its own `version` column (>=1 effective-date counter); it must NOT gain a
    // separate lock_version — that would conflate two different concepts.
    expect(hasLockVersion(tables, 'tax_rules')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(table(tables, 'tax_rules')!.attributes, 'version')).toBe(true);
  });

  describe('invoice_number index — W2-10', () => {
    it('invoices has a (tenant_id, vendor_id, invoice_number) index for per-vendor lookups', () => {
      const idx = indexes.find((i) => i.options.name === 'invoices_tenant_vendor_number_idx');
      expect(idx).toBeDefined();
      expect(idx!.fields).toEqual(['tenant_id', 'vendor_id', 'invoice_number']);
      // vendor_id is nullable and confirmed duplicates share an invoice_number → NON-unique lookup.
      expect(idx!.options.unique).toBeFalsy();
    });
  });
});
