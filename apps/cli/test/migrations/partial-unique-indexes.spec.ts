/**
 * Proves the partial-unique-index invariant for paranoid (soft-delete) tables.
 *
 * Every natural-key UNIQUE index on a table that ALSO carries a `deleted_at` soft-delete column
 * MUST be a PARTIAL unique index scoped to live rows (`where: { deleted_at: null }`), so a record
 * can be recreated after it is soft-deleted instead of colliding with the tombstone (Postgres
 * 23505). Plain (non-partial) unique natural keys are only correct on non-paranoid tables.
 *
 * These tests run each migration's `up` against a fake QueryInterface that records the DDL it would
 * emit, then assert on the captured `createTable` column options and `addIndex` calls — no database
 * required.
 */
import type { QueryInterface } from 'sequelize';
import { up as up0001 } from '../../src/migrations/0001_identity';
import { up as up0003 } from '../../src/migrations/0003_expense';
import { up as up0004 } from '../../src/migrations/0004_workflow';
import { up as up0005 } from '../../src/migrations/0005_payroll';

interface RecordedTable {
  name: string;
  attributes: Record<string, { unique?: unknown }>;
}
interface RecordedIndex {
  table: string;
  fields: readonly (string | object)[];
  options: { unique?: boolean; name?: string; where?: Record<string, unknown> };
}

/** A QueryInterface stub that records every createTable / addIndex the migration emits. */
function makeRecorder(): {
  q: QueryInterface;
  tables: RecordedTable[];
  indexes: RecordedIndex[];
} {
  const tables: RecordedTable[] = [];
  const indexes: RecordedIndex[] = [];
  const q = {
    createTable: jest.fn(async (name: string, attributes: Record<string, { unique?: unknown }>) => {
      tables.push({ name, attributes });
    }),
    addIndex: jest.fn(
      async (
        table: string,
        fields: readonly (string | object)[],
        options: RecordedIndex['options'] = {},
      ) => {
        indexes.push({ table, fields, options });
      },
    ),
    addConstraint: jest.fn(async () => undefined),
    sequelize: { query: jest.fn(async () => undefined) },
  } as unknown as QueryInterface;
  return { q, tables, indexes };
}

/** A table is paranoid iff its create attributes declare a `deleted_at` column. */
function isParanoid(tables: RecordedTable[], table: string): boolean {
  const t = tables.find((x) => x.name === table);
  return !!t && Object.prototype.hasOwnProperty.call(t.attributes, 'deleted_at');
}

/** All unique indexes recorded for a table (addIndex with unique:true). */
function uniqueIndexes(indexes: RecordedIndex[], table: string): RecordedIndex[] {
  return indexes.filter((i) => i.table === table && i.options.unique === true);
}

/** Any inline column-level `unique` declared in a createTable for a table. */
function inlineUniqueColumns(tables: RecordedTable[], table: string): string[] {
  const t = tables.find((x) => x.name === table);
  if (!t) return [];
  return Object.entries(t.attributes)
    .filter(([, def]) => def && def.unique)
    .map(([col]) => col);
}

describe('partial unique indexes on paranoid soft-delete tables', () => {
  describe('0001_identity', () => {
    let tables: RecordedTable[];
    let indexes: RecordedIndex[];
    beforeAll(async () => {
      const r = makeRecorder();
      await up0001({ context: r.q } as never);
      tables = r.tables;
      indexes = r.indexes;
    });

    it('tenants is paranoid and its slug is a partial unique index, not an inline unique column', () => {
      expect(isParanoid(tables, 'tenants')).toBe(true);
      // No inline column-level unique on slug (would be a plain, full-table unique).
      expect(inlineUniqueColumns(tables, 'tenants')).not.toContain('slug');
      const slug = indexes.find((i) => i.table === 'tenants' && i.options.name === 'tenants_slug_uq');
      expect(slug).toBeDefined();
      expect(slug!.options.unique).toBe(true);
      expect(slug!.options.where).toEqual({ deleted_at: null });
    });

    it('users (tenant_id,email) unique is scoped to live rows', () => {
      expect(isParanoid(tables, 'users')).toBe(true);
      const idx = indexes.find((i) => i.options.name === 'users_tenant_email_uq');
      expect(idx).toBeDefined();
      expect(idx!.fields).toEqual(['tenant_id', 'email']);
      expect(idx!.options.unique).toBe(true);
      expect(idx!.options.where).toEqual({ deleted_at: null });
    });

    it('roles gains a partial unique (tenant_id,name) for custom roles', () => {
      expect(isParanoid(tables, 'roles')).toBe(true);
      const idx = indexes.find((i) => i.options.name === 'roles_tenant_name_uq');
      expect(idx).toBeDefined();
      expect(idx!.fields).toEqual(['tenant_id', 'name']);
      expect(idx!.options.unique).toBe(true);
      expect(idx!.options.where).toEqual({ deleted_at: null });
    });

    it('roles also enforces unique system-role names (tenant_id IS NULL) over live rows', () => {
      const idx = indexes.find((i) => i.options.name === 'roles_system_name_uq');
      expect(idx).toBeDefined();
      expect(idx!.fields).toEqual(['name']);
      expect(idx!.options.unique).toBe(true);
      expect(idx!.options.where).toEqual({ tenant_id: null, deleted_at: null });
    });

    it('non-paranoid identity tables keep PLAIN unique natural keys', () => {
      // permissions.name, role_perm_uq, user_roles_tenant_user_uq are on non-paranoid tables.
      expect(isParanoid(tables, 'permissions')).toBe(false);
      expect(isParanoid(tables, 'role_permissions')).toBe(false);
      expect(isParanoid(tables, 'user_roles')).toBe(false);
      for (const name of ['role_perm_uq', 'user_roles_tenant_user_uq']) {
        const idx = indexes.find((i) => i.options.name === name);
        expect(idx).toBeDefined();
        expect(idx!.options.where).toBeUndefined();
      }
    });
  });

  describe('0003_expense', () => {
    let tables: RecordedTable[];
    let indexes: RecordedIndex[];
    beforeAll(async () => {
      const r = makeRecorder();
      await up0003({ context: r.q } as never);
      tables = r.tables;
      indexes = r.indexes;
    });

    it.each([
      ['expense_categories_tenant_code_uq', 'expense_categories'],
      ['expense_reports_tenant_number_uq', 'expense_reports'],
    ])('%s is a partial unique on a paranoid table', (name, table) => {
      expect(isParanoid(tables, table)).toBe(true);
      const idx = indexes.find((i) => i.options.name === name);
      expect(idx).toBeDefined();
      expect(idx!.options.unique).toBe(true);
      expect(idx!.options.where).toEqual({ deleted_at: null });
    });
  });

  describe('0005_payroll', () => {
    let tables: RecordedTable[];
    let indexes: RecordedIndex[];
    beforeAll(async () => {
      const r = makeRecorder();
      await up0005({ context: r.q } as never);
      tables = r.tables;
      indexes = r.indexes;
    });

    it.each([
      ['pay_calendars_tenant_name_uq', 'pay_calendars'],
      ['earning_codes_tenant_name_uq', 'earning_codes'],
      ['deduction_codes_tenant_name_uq', 'deduction_codes'],
      ['pay_runs_tenant_period_uq', 'pay_runs'],
    ])('%s is a partial unique on a paranoid table', (name, table) => {
      expect(isParanoid(tables, table)).toBe(true);
      const idx = indexes.find((i) => i.options.name === name);
      expect(idx).toBeDefined();
      expect(idx!.options.unique).toBe(true);
      expect(idx!.options.where).toEqual({ deleted_at: null });
    });

    it('idempotency-key unique indexes on non-paranoid tables stay PLAIN', () => {
      // payments / payroll_input_items are append-only (not paranoid): full-table unique is correct.
      expect(isParanoid(tables, 'payments')).toBe(false);
      expect(isParanoid(tables, 'payroll_input_items')).toBe(false);
      for (const name of ['payments_idempotency_uq', 'payroll_inputs_idempotency_uq']) {
        const idx = indexes.find((i) => i.options.name === name);
        expect(idx).toBeDefined();
        expect(idx!.options.where).toBeUndefined();
      }
    });
  });

  describe('0004_workflow (already-correct template — regression guard)', () => {
    it('rules_tenant_name_uq remains a partial unique on the paranoid rules table', async () => {
      const r = makeRecorder();
      await up0004({ context: r.q } as never);
      expect(isParanoid(r.tables, 'rules')).toBe(true);
      const idx = r.indexes.find((i) => i.options.name === 'rules_tenant_name_uq');
      expect(idx).toBeDefined();
      expect(idx!.options.unique).toBe(true);
      expect(idx!.options.where).toEqual({ deleted_at: null });
    });
  });

  describe('invariant: every unique index on a paranoid table is partial', () => {
    it.each([
      ['0001_identity', up0001],
      ['0003_expense', up0003],
      ['0004_workflow', up0004],
      ['0005_payroll', up0005],
    ])('%s — no plain unique natural key survives on a soft-delete table', async (_label, up) => {
      const r = makeRecorder();
      await up({ context: r.q } as never);
      for (const t of r.tables) {
        if (!isParanoid(r.tables, t.name)) continue;
        // No inline column-level unique on a paranoid table.
        expect(inlineUniqueColumns(r.tables, t.name)).toEqual([]);
        // Every addIndex(unique:true) on a paranoid table must carry the live-rows predicate.
        for (const idx of uniqueIndexes(r.indexes, t.name)) {
          expect(idx.options.where).toEqual(
            expect.objectContaining({ deleted_at: null }),
          );
        }
      }
    });
  });
});
