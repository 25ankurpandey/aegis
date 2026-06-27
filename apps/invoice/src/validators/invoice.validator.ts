import Joi from 'joi';
import { InvoiceTransactionType } from '@aegis/shared-enums';

/** Joi schemas for the invoice surface (create + approve). Applied via the `validate(...)` middleware. */
export const createInvoiceSchema = Joi.object({
  vendorId: Joi.string().uuid().optional(),
  vendorName: Joi.string().min(1).required(),
  invoiceNumber: Joi.string().min(1).required(),
  invoiceDate: Joi.string().isoDate().required(),
  dueDate: Joi.string().isoDate().optional(),
  transactionType: Joi.string()
    .valid(...Object.values(InvoiceTransactionType))
    .optional(),
  amountMinor: Joi.number().integer().min(0).required(),
  currency: Joi.string().length(3).uppercase().required(),
});

export const approveInvoiceSchema = Joi.object({
  comment: Joi.string().optional(),
  approvalLevel: Joi.number().integer().min(1).optional(),
});

/**
 * Decide body for the engine-backed POST /invoices/:id/decisions: the required terminal `decision`
 * (approved|rejected) + an optional comment recorded on the engine vote and mirrored onto the
 * invoice's own decision ledger.
 */
export const decideInvoiceSchema = Joi.object({
  decision: Joi.string().valid('approved', 'rejected').required(),
  comment: Joi.string().optional(),
});
