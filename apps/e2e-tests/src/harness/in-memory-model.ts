/**
 * A dependency-free, tenant-partitioned, in-memory stand-in for a Sequelize model. It implements the
 * subset of the model surface the Aegis repositories actually use (create / findAll / findOne /
 * findByPk / count / update), and partitions rows by `tenant_id` so a query under tenant A never sees
 * tenant B's rows — the in-memory analogue of PostgreSQL RLS. This is what lets the integration
 * harness drive the REAL repositories + services with no Postgres/Docker while still exercising tenant
 * isolation. (Same shape the per-lib specs use; lifted here so every FLOW shares one definition.)
 */

export interface Row {
  [k: string]: unknown;
}

export interface InMemoryModel {
  _rows: Row[];
  create(values: Row): Promise<{ get(opts?: { plain?: boolean }): Row; update(patch: Row): Promise<unknown> }>;
  findAll(opts?: { where?: Record<string, unknown>; order?: [string, string][] }): Promise<
    Array<{ get(opts?: { plain?: boolean }): Row; update(patch: Row): Promise<unknown> }>
  >;
  findOne(opts?: { where?: Record<string, unknown>; order?: [string, string][] }): Promise<
    { get(opts?: { plain?: boolean }): Row; update(patch: Row): Promise<unknown> } | null
  >;
  findByPk(id: string): Promise<{ get(opts?: { plain?: boolean }): Row; update(patch: Row): Promise<unknown> } | null>;
  count(opts?: { where?: Record<string, unknown> }): Promise<number>;
  update(patch: Row, opts: { where: Record<string, unknown> }): Promise<[number]>;
}

/**
 * Build one in-memory model. `currentTenant()` is read on every query so the harness can switch the
 * "RLS" tenant mid-test (exactly as a `SET LOCAL app.current_tenant` would change visibility).
 */
export function makeModel(currentTenant: () => string): InMemoryModel {
  const rows: Row[] = [];
  let seq = 0;

  const matches = (r: Row, where?: Record<string, unknown>): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => r[k] === v);
  };
  const scoped = (where?: Record<string, unknown>): Row[] =>
    rows.filter((r) => r['tenant_id'] === currentTenant() && matches(r, where));

  const wrap = (r: Row) => ({
    get: (opts?: { plain?: boolean }) => (opts?.plain ? { ...r } : r),
    update: async (patch: Row) => {
      Object.assign(r, patch);
      return wrap(r);
    },
  });

  const sortBy = (out: Row[], order?: [string, string][]): Row[] => {
    if (!order) return out;
    return [...out].sort((a, b) => {
      for (const [col, dir] of order) {
        const av = a[col] as number;
        const bv = b[col] as number;
        if (av === bv) continue;
        const cmp = av < bv ? -1 : 1;
        return dir === 'DESC' ? -cmp : cmp;
      }
      return 0;
    });
  };

  return {
    _rows: rows,
    create: async (values: Row) => {
      const row: Row = { id: `id-${++seq}`, created_at: new Date(seq), ...values };
      if (row['tenant_id'] === undefined) row['tenant_id'] = currentTenant();
      rows.push(row);
      return wrap(row);
    },
    findAll: async (opts) => sortBy(scoped(opts?.where), opts?.order).map(wrap),
    findOne: async (opts) => {
      const out = sortBy(scoped(opts?.where), opts?.order);
      return out[0] ? wrap(out[0]) : null;
    },
    findByPk: async (id: string) => {
      const r = scoped().find((x) => x['id'] === id);
      return r ? wrap(r) : null;
    },
    count: async (opts) => scoped(opts?.where).length,
    update: async (patch: Row, opts: { where: Record<string, unknown> }) => {
      const targets = scoped(opts.where);
      targets.forEach((r) => Object.assign(r, patch));
      return [targets.length] as [number];
    },
  };
}
