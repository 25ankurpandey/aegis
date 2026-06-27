import { Logger, RequestContext } from '@aegis/service-core';
import { ApprovalRecordType } from '@aegis/shared-enums';
import { getBus, EventTopic, type EventEnvelope, type RecordUpdatedPayload } from '@aegis/events';
import { container } from '../ioc/container';
import { InvoiceService } from '../services/invoice.service';

/**
 * BUG-0003 — RecordUpdated consumer (invoice half). A workflow `assign_team` / `add_tag` rule action
 * PRODUCES `EventTopic.RecordUpdated` (apps/workflow/src/engine/actions/builtin.ts) but, before this
 * consumer, NOTHING subscribed — so the action reported success while the team assignment / tag
 * attachment silently never happened (the same produced-with-no-consumer class as BUG-0001/0002).
 *
 * This worker-role consumer (the invoice half of a per-service triple, mirroring the ApprovalCompleted
 * consumers) applies the annotation to the invoice it OWNS, under the RequestContext the bus rebuilt
 * from the envelope (tenant + correlation propagate, so RLS + audit attribution hold across the async
 * hop). It filters by record type, so other record types are left to their own owner's consumer. A
 * failure propagates so the bus's bounded retry -> DLQ engages; the service write is idempotent.
 */

/** Anti-ambient-authority guard: the rebuilt context tenant MUST match the envelope's own tenant. */
function assertEnvelopeTenant(env: EventEnvelope): void {
  const ctxTenant = RequestContext.tenantId(); // throws if no scope — fail-closed
  if (!env.tenantId || env.tenantId !== ctxTenant) {
    throw new Error('event tenant does not match propagated context tenant');
  }
}

/** Resolve the service lazily so the DI container is fully loaded before first use. */
function service(): InvoiceService {
  return container.get(InvoiceService);
}

/** Narrow the polymorphic RecordUpdated facts to the typed `assign_team` / `add_tag` payload. */
function readAnnotation(payload: RecordUpdatedPayload): {
  teamId?: string;
  assigneeId?: string | null;
  tags?: string[];
  removeTags?: string[];
  ruleId?: string;
} {
  const teamId = typeof payload['teamId'] === 'string' ? (payload['teamId'] as string) : undefined;
  const rawAssigneeId = payload['assigneeId'];
  const assigneeId =
    typeof rawAssigneeId === 'string' || rawAssigneeId === null ? rawAssigneeId : undefined;
  const rawTags = payload['tags'];
  const tags = Array.isArray(rawTags)
    ? rawTags.filter((tag): tag is string => typeof tag === 'string')
    : undefined;
  const rawRemoveTags = payload['removeTags'];
  const removeTags = Array.isArray(rawRemoveTags)
    ? rawRemoveTags.filter((tag): tag is string => typeof tag === 'string')
    : undefined;
  const ruleId = typeof payload['ruleId'] === 'string' ? (payload['ruleId'] as string) : undefined;
  return { teamId, assigneeId, tags, removeTags, ruleId };
}

export async function onRecordUpdated(env: EventEnvelope<RecordUpdatedPayload>): Promise<void> {
  assertEnvelopeTenant(env);
  const { recordType, recordId } = env.payload;
  // Only OUR record type — other record types flow through the same topic but their own consumers.
  if (recordType !== ApprovalRecordType.Invoice) return;
  if (!recordId) throw new Error('record.updated missing recordId');

  const { teamId, assigneeId, tags, removeTags, ruleId } = readAnnotation(env.payload);
  if (
    teamId === undefined &&
    assigneeId === undefined &&
    (!tags || tags.length === 0) &&
    (!removeTags || removeTags.length === 0)
  )
    return; // nothing to apply

  await service().applyRecordUpdate(
    recordId,
    clean({ teamId, assigneeId, tags, removeTags, ruleId }),
  );
}

function clean<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Register the RecordUpdated -> record-annotate subscription (worker role). The bus rebuilds the
 * producer's RequestContext from the envelope before the handler, so the consumer runs under the same
 * verified tenant scope the rule fired under (in-process locally; Kafka in the worker role).
 */
export function registerRecordUpdateConsumer(): void {
  const bus = getBus();
  bus.subscribe(EventTopic.RecordUpdated, onRecordUpdated);
  Logger.info('record-update consumer registered', { topic: EventTopic.RecordUpdated });
}
