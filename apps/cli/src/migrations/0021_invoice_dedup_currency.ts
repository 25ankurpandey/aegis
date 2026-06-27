import type { QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName, InvoiceStatus } from '@aegis/shared-enums';

/**
 * BUG-0010 — INVOICE DEDUP MUST INCLUDE CURRENCY.
 *
 * The invoice dedup SIGNATURE (`InvoiceService.signature`) hashes
 * `(vendor + invoice_number + amount + CURRENCY)`, but both the enforcement read
 * (`findDuplicateCandidate`) and the partial-unique index created in 0017
 * (`invoices_dup_signature_live_uq`) omitted currency. The consequence: a legitimate invoice with the
 * SAME vendor / number / amount but a DIFFERENT currency collided with the existing one, was wrongly
 * marked `Duplicate`, and was never paid.
 *
 * This migration replaces the currency-LESS partial-unique dedup index with a currency-INCLUSIVE one,
 * so the database-enforced "at most one live, non-duplicate invoice per signature" guarantee matches
 * the real signature: two invoices that differ ONLY by currency are NOT duplicates of each other.
 * (The repository WHERE + `DuplicateCandidateInput` are updated in lock-step in the invoice service.)
 *
 * Drop-then-create (rather than CONCURRENTLY) keeps the change atomic inside the migration transaction,
 * consistent with how 0017 created the original index.
 */

const TABLE = TableName.Invoices;
const OLD_INDEX = 'invoices_dup_signature_live_uq';
const NEW_INDEX = 'invoices_dup_signature_cur_live_uq';
// Single-quoted SQL literal for the duplicate status (kept in lock-step with the domain enum).
const DUP = InvoiceStatus.Duplicate;

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  // 1) Drop the currency-less partial-unique index from 0017 — it over-collides across currencies.
  await q.sequelize.query(`DROP INDEX IF EXISTS "${OLD_INDEX}"`);

  // 2) Create the currency-INCLUSIVE partial-unique index over the full dedup signature. At most one
  //    live, non-duplicate invoice may hold a given (tenant, vendor, number, amount, currency); a
  //    different-currency invoice with the same vendor/number/amount is a distinct signature and is
  //    allowed. Predicate excludes flagged duplicates (they legitimately share the signature) and
  //    soft-deleted rows (frees the signature on soft-delete), matching 0017's conventions.
  await q.sequelize.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${NEW_INDEX}" ` +
      `ON "${TABLE}" ("tenant_id", "vendor_name", "invoice_number", "amount_minor", "currency") ` +
      `WHERE "status" <> '${DUP}' AND "deleted_at" IS NULL`,
  );
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  // Reverse: drop the currency-inclusive index and restore the original currency-less one from 0017.
  await q.sequelize.query(`DROP INDEX IF EXISTS "${NEW_INDEX}"`);
  await q.sequelize.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${OLD_INDEX}" ` +
      `ON "${TABLE}" ("tenant_id", "vendor_name", "invoice_number", "amount_minor") ` +
      `WHERE "status" <> '${DUP}' AND "deleted_at" IS NULL`,
  );
}
