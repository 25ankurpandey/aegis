import type { ModelStatic, Model, Sequelize } from 'sequelize';
import { getSequelize, createModelRegistry } from '@aegis/db';
import { defineInvoice } from './invoice.model';
import { defineInvoiceMetadata } from './invoice-metadata.model';
import { defineInvoiceDuplicate } from './invoice-duplicate.model';
import { defineInvoiceApproval } from './invoice-approval.model';
import { defineInvoiceActivity } from './invoice-activity.model';

type M = ModelStatic<Model>;

/** The set of invoice models, registered on the shared connection (the service's DatabaseContext). */
export interface InvoiceContext {
  Invoice: M;
  InvoiceMetadata: M;
  InvoiceDuplicate: M;
  InvoiceApproval: M;
  InvoiceActivity: M;
  sequelize: Sequelize;
}

let ctx: InvoiceContext | null = null;

/**
 * Defines every invoice model on the shared `getSequelize()` connection (once), wires the
 * associations, and returns the assembled context. The return shape is unchanged from the previous
 * single-file `context.ts`, so all callers keep working (SPEC §11.1 — one `*.model.ts` per table +
 * a `database-context.ts` that imports + registers them). Money lives in integer minor units; every
 * table is tenant-scoped (RLS).
 */
export function getInvoiceContext(): InvoiceContext {
  if (ctx) return ctx;
  const s = getSequelize();
  // Single registration path: every model is routed through the registry so the shared base-model
  // options (timestamps/underscored/paranoid/version) are applied + tracked consistently (W2-09).
  const registry = createModelRegistry(s);

  const Invoice = registry.register(defineInvoice(s));
  const InvoiceMetadata = registry.register(defineInvoiceMetadata(s));
  const InvoiceDuplicate = registry.register(defineInvoiceDuplicate(s));
  const InvoiceApproval = registry.register(defineInvoiceApproval(s));
  const InvoiceActivity = registry.register(defineInvoiceActivity(s));

  Invoice.hasOne(InvoiceMetadata, { foreignKey: 'invoice_id', as: 'metadata' });
  Invoice.hasMany(InvoiceDuplicate, { foreignKey: 'invoice_id', as: 'duplicates' });
  Invoice.hasMany(InvoiceApproval, { foreignKey: 'invoice_id', as: 'approvals' });
  Invoice.hasMany(InvoiceActivity, { foreignKey: 'invoice_id', as: 'activities' });

  ctx = { Invoice, InvoiceMetadata, InvoiceDuplicate, InvoiceApproval, InvoiceActivity, sequelize: s };
  return ctx;
}
