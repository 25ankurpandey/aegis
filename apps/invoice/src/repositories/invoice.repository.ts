import { OptimisticLockError, type Transaction } from 'sequelize';
import { ErrUtils } from '@aegis/service-core';
import { InvoiceShape } from '@aegis/shared-types';
import { ApprovalRecordType, InvoiceDuplicateStatus, TableName } from '@aegis/shared-enums';
import { withRecordAnnotationListFilters } from '@aegis/db';
import { provideSingleton } from '../ioc/container';
import { getInvoiceContext } from '../models/database-context';

/**
 * Data access for the invoice aggregate (the `invoices` root + its `invoice_metadata`,
 * `invoice_duplicates`, `invoice_approvals`, and append-only `invoice_activities`). Every method
 * takes the ambient RLS-scoped `Transaction` (the SERVICE opens it via `withTenantTransaction`), so
 * a tenant only ever sees its own rows.
 */
@provideSingleton(InvoiceRepository)
export class InvoiceRepository {
  // ---- invoices (aggregate root) ----

  async createInvoice(
    data: InvoiceShape.NewInvoice,
    t: Transaction,
  ): Promise<InvoiceShape.InvoiceRow> {
    const { Invoice } = getInvoiceContext();
    const row = await Invoice.create(
      { ...data, amount_minor: data.amount_minor.toString() },
      { transaction: t },
    );
    return row.get({ plain: true }) as InvoiceShape.InvoiceRow;
  }

  async findById(id: string, t: Transaction): Promise<InvoiceShape.InvoiceRow | null> {
    const { Invoice } = getInvoiceContext();
    const row = await Invoice.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as InvoiceShape.InvoiceRow) : null;
  }

  async list(
    filter: InvoiceShape.InvoiceListFilter,
    page: number,
    pageSize: number,
    t: Transaction,
  ): Promise<{ rows: InvoiceShape.InvoiceRow[]; total: number }> {
    const { Invoice } = getInvoiceContext();
    const where = withRecordAnnotationListFilters(
      { deleted_at: null },
      { ...filter, statuses: filter.statuses ?? (filter.status ? [filter.status] : undefined) },
      {
        tableName: TableName.Invoices,
        recordType: ApprovalRecordType.Invoice,
        sequelize: getInvoiceContext().sequelize,
      },
    ) as Record<string, unknown>;
    if (filter.vendorId) where['vendor_id'] = filter.vendorId;
    const result = await Invoice.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit: pageSize,
      offset: (page - 1) * pageSize,
      transaction: t,
    });
    return {
      rows: result.rows.map((r) => r.get({ plain: true }) as InvoiceShape.InvoiceRow),
      total: result.count,
    };
  }

  /**
   * Apply a status (or related field) patch to an invoice through a VERSION-CHECKED instance update
   * (W5-07). We load the row and `save()` it so Sequelize's optimistic locking kicks in: it appends a
   * `WHERE lock_version = ?` guard and increments `lock_version`, so a write racing another approver
   * throws `OptimisticLockError`. When `expectedVersion` is supplied (the version the caller observed
   * at its `assertStatus` read), we also reject up-front if the row has already moved on — so two
   * concurrent approvals can't both pass the status gate and clobber each other. Both the stale-read
   * and the racing-save cases surface as a 409 Conflict. A static `Model.update()` would bypass
   * optimistic locking entirely, which is the bug this replaces.
   */
  async updateStatus(
    id: string,
    patch: Partial<
      Pick<
        InvoiceShape.InvoiceRow,
        'status' | 'auto_approved' | 'auto_approved_by' | 'submitted_by' | 'approval_policy_id'
      >
    >,
    t: Transaction,
    expectedVersion?: number,
  ): Promise<void> {
    const { Invoice } = getInvoiceContext();
    const row = await Invoice.findByPk(id, { transaction: t });
    if (!row) throw ErrUtils.notFound('Invoice not found');
    // Stale-read guard: the caller asserted state at version N; if the row already advanced, refuse.
    if (expectedVersion !== undefined) {
      const current = row.get('lock_version') as number;
      if (current !== expectedVersion) {
        throw ErrUtils.conflict('Invoice was modified concurrently', {
          expected: expectedVersion,
          actual: current,
        });
      }
    }
    try {
      await row.update(patch, { transaction: t });
    } catch (err) {
      // A concurrent writer bumped lock_version between our load and save.
      if (err instanceof OptimisticLockError) {
        throw ErrUtils.conflict('Invoice was modified concurrently');
      }
      throw err;
    }
  }

  /**
   * Persist the workflow-rule annotations (`team_id` / `tags`). Used by the RecordUpdated consumer to
   * apply an `assign_team` / `add_tag` action to the record it owns; the service computes the merged
   * values (team set, tags unioned) and passes only the changed fields. Atomic within the RLS tx.
   */
  async applyLabels(
    id: string,
    patch: { team_id?: string | null; assignee_id?: string | null; tags?: string[] | null },
    t: Transaction,
  ): Promise<void> {
    const { Invoice } = getInvoiceContext();
    const row = await Invoice.findByPk(id, { transaction: t });
    if (!row) return;
    await row.update(patch, { transaction: t });
  }

  // ---- invoice_metadata (1:1) ----

  async createMetadata(
    data: InvoiceShape.NewInvoiceMetadata,
    t: Transaction,
  ): Promise<InvoiceShape.InvoiceMetadataRow> {
    const { InvoiceMetadata } = getInvoiceContext();
    const row = await InvoiceMetadata.create(
      { ...data, amount_minor: data.amount_minor.toString() },
      { transaction: t },
    );
    return row.get({ plain: true }) as InvoiceShape.InvoiceMetadataRow;
  }

  async findMetadata(
    invoiceId: string,
    t: Transaction,
  ): Promise<InvoiceShape.InvoiceMetadataRow | null> {
    const { InvoiceMetadata } = getInvoiceContext();
    const row = await InvoiceMetadata.findOne({ where: { invoice_id: invoiceId }, transaction: t });
    return row ? (row.get({ plain: true }) as InvoiceShape.InvoiceMetadataRow) : null;
  }

  // ---- invoice_duplicates ----

  /**
   * Find a prior invoice in this tenant whose dup signature collides
   * (vendor + number + amount + currency). Currency is part of the signature (BUG-0010): a
   * same-vendor/number/amount invoice in a DIFFERENT currency is a legitimately distinct bill, so it
   * must NOT match — the WHERE includes currency so the enforcement read agrees with the hashed
   * signature (and with the currency-inclusive partial-unique index in migration 0021).
   */
  async findDuplicateCandidate(
    input: InvoiceShape.DuplicateCandidateInput,
    t: Transaction,
  ): Promise<InvoiceShape.InvoiceRow | null> {
    const { Invoice } = getInvoiceContext();
    const { Op } = await import('sequelize');
    const where: Record<string, unknown> = {
      vendor_name: input.vendorName,
      invoice_number: input.invoiceNumber,
      amount_minor: input.amountMinor.toString(),
      currency: input.currency,
    };
    // Exclude the just-inserted row from the self-join; the recovery path has no own row to exclude.
    if (input.excludeId) where['id'] = { [Op.ne]: input.excludeId };
    const row = await Invoice.findOne({
      where,
      order: [['created_at', 'ASC']],
      transaction: t,
    });
    return row ? (row.get({ plain: true }) as InvoiceShape.InvoiceRow) : null;
  }

  async createDuplicate(
    data: InvoiceShape.NewInvoiceDuplicate,
    t: Transaction,
  ): Promise<InvoiceShape.InvoiceDuplicateRow> {
    const { InvoiceDuplicate } = getInvoiceContext();
    const row = await InvoiceDuplicate.create(
      { ...data, status: InvoiceDuplicateStatus.Flagged },
      { transaction: t },
    );
    return row.get({ plain: true }) as InvoiceShape.InvoiceDuplicateRow;
  }

  // ---- invoice_approvals ----

  async createApproval(
    data: InvoiceShape.NewInvoiceApproval,
    t: Transaction,
  ): Promise<InvoiceShape.InvoiceApprovalRow> {
    const { InvoiceApproval } = getInvoiceContext();
    const row = await InvoiceApproval.create({ ...data, active: true }, { transaction: t });
    return row.get({ plain: true }) as InvoiceShape.InvoiceApprovalRow;
  }

  async listApprovals(
    invoiceId: string,
    t: Transaction,
  ): Promise<InvoiceShape.InvoiceApprovalRow[]> {
    const { InvoiceApproval } = getInvoiceContext();
    const rows = await InvoiceApproval.findAll({
      where: { invoice_id: invoiceId },
      transaction: t,
    });
    return rows.map((r) => r.get({ plain: true }) as InvoiceShape.InvoiceApprovalRow);
  }

  // ---- invoice_activities (append-only) ----

  async recordActivity(data: InvoiceShape.NewInvoiceActivity, t: Transaction): Promise<void> {
    const { InvoiceActivity } = getInvoiceContext();
    await InvoiceActivity.create({ ...data }, { transaction: t });
  }
}
