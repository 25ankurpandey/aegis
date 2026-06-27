import type { QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName, InvoiceStatus } from '@aegis/shared-enums';

/**
 * W5-06 DUPLICATE-DETECTION CONCURRENCY GUARD.
 *
 * The invoice `create()` path does a read (`findDuplicateCandidate`) then an insert. Under
 * concurrency two submits of the same dedup signature both pass the read as non-duplicate and both
 * insert as live invoices → the same bill is approved/paid twice. The existing
 * `invoices_dup_signature_idx` is intentionally NON-unique (a flagged duplicate is a real row that
 * shares the signature with its original), so it does not stop the race.
 *
 * This migration adds a DATABASE-ENFORCED guarantee: a PARTIAL-UNIQUE index over the dedup signature
 * `(tenant_id, vendor_name, invoice_number, amount_minor)` restricted to LIVE, NON-DUPLICATE rows
 * (`status <> 'duplicate' AND deleted_at IS NULL`). At most one live non-duplicate invoice can hold a
 * given signature, so the loser of a concurrent insert hits a 23505 the service catches and
 * deterministically marks as Duplicate — the guarantee now holds under concurrency, not just on the
 * best-effort read. Already-flagged duplicates are excluded from the predicate (they legitimately
 * share the signature with their original), and soft-deleted rows are excluded so a signature is
 * freed once an invoice is soft-deleted (avoids 23505 on recreate), matching the table's existing
 * soft-delete-scoped uniqueness convention.
 */

const TABLE = TableName.Invoices;
const INDEX = 'invoices_dup_signature_live_uq';
// Single-quoted SQL literal for the duplicate status (kept in lock-step with the domain enum).
const DUP = InvoiceStatus.Duplicate;

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  // Partial-unique on the live, non-duplicate dedup signature. Raw SQL (not addIndex) because the
  // predicate uses `<>` over the status column, which the addIndex `where` shorthand can't express.
  await q.sequelize.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX}" ` +
      `ON "${TABLE}" ("tenant_id", "vendor_name", "invoice_number", "amount_minor") ` +
      `WHERE "status" <> '${DUP}' AND "deleted_at" IS NULL`,
  );
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.sequelize.query(`DROP INDEX IF EXISTS "${INDEX}"`);
}
