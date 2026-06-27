import { Logger, RequestContext } from '@aegis/service-core';
import { ApprovalRecordType } from '@aegis/shared-enums';
import {
  getBus,
  EventTopic,
  type EventEnvelope,
  type ApprovalCompletedPayload,
} from '@aegis/events';
import { container } from '../ioc/container';
import { ExpenseService } from '../services/expense.service';

/**
 * BUG-0005 — STRANDED-RECORD RECOVERY (expense half).
 *
 * `decideReport` records the vote + stages `ApprovalCompleted` in the engine's tx, then advances the
 * report in a SEPARATE step. If that in-request advance fails, the chain is complete but the report is
 * stranded in APPROVALS forever (a retry would re-vote → "already decided"). This worker-role consumer
 * subscribes to the relayed `ApprovalCompleted` and drives the report's own idempotent
 * `applyCompletionFromEvent`, so the staged event ALSO advances the record — recovering the stranded
 * report. It is again-safe: `applyCompletion` is a no-op once the report is terminal, so a re-delivered
 * (at-least-once) ApprovalCompleted advances a stranded record exactly once and a double delivery does
 * nothing.
 */

/**
 * Anti-ambient-authority guard: the tenant the bus rebuilt into the RequestContext from the envelope
 * MUST match the envelope's own tenant. Tenant authority comes from the ENVELOPE (makeEnvelope stamps
 * it from the producer's RequestContext), never the payload.
 */
function assertEnvelopeTenant(env: EventEnvelope): void {
  const ctxTenant = RequestContext.tenantId(); // throws if no scope — fail-closed
  if (!env.tenantId || env.tenantId !== ctxTenant) {
    throw new Error('event tenant does not match propagated context tenant');
  }
}

/** Resolve the service lazily so the DI container is fully loaded before first use. */
function service(): ExpenseService {
  return container.get(ExpenseService);
}

async function onApprovalCompleted(env: EventEnvelope<ApprovalCompletedPayload>): Promise<void> {
  assertEnvelopeTenant(env);
  // The engine key is canonical (`recordType`/`recordId`); fall back to the subject aliases.
  const recordType = env.payload.recordType ?? env.payload.subjectType;
  const recordId = env.payload.recordId ?? env.payload.subjectId;
  // Only OUR record type — invoice/payroll runs flow through the same topic but their own consumers.
  if (recordType !== ApprovalRecordType.ExpenseReport) return;
  const decidedBy = env.payload.decidedBy ?? env.payload.subjectId;
  await service().applyCompletionFromEvent(recordId, env.payload.outcome, decidedBy);
}

/**
 * Register the ApprovalCompleted → record-advance subscription. The bus rebuilds the producer's
 * RequestContext (tenantId, correlationId, sourceService) from the envelope before the handler, so the
 * consumer runs under the same verified tenant scope the engine emitted under (in-process locally;
 * Kafka in the distributed `PROCESS_TYPE=worker` role).
 */
export function registerConsumers(): void {
  const bus = getBus();
  bus.subscribe(EventTopic.ApprovalCompleted, onApprovalCompleted);
  Logger.info('expense consumers registered', { topics: [EventTopic.ApprovalCompleted] });
}
