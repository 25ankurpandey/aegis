import { EventTopic, getBus, type EventEnvelope } from '@aegis/events';
import { RuleEvent } from '@aegis/shared-enums';
import { Logger } from '@aegis/service-core';
import { container } from '../ioc/container';
import { RuleService } from '../services/rule.service';
import type { Facts } from '../engine/types';
import { registerConnectorSyncConsumer } from './connector-sync.consumer';
import { registerApprovalCommandConsumer } from './approval-command.consumer';

/**
 * Map the ACTUAL domain EventTopics that services emit onto the RuleEvent the rules are authored
 * against, so rules actually fire on real domain writes. The previous wiring subscribed to
 * `record.created`/`record.updated` — topics NO producer emits (record.updated is emitted only by
 * workflow's own builtin actions), so the engine never auto-fired. Those dead subscriptions are gone.
 *
 * W5-12 — SINGLE CANONICAL "approval done" TRIGGER. There are now TWO sources of truth for "an
 * approval resolved": the per-domain `*Approved` topics (`ExpenseApproved`/`InvoiceApproved`/
 * `PayRunApproved`, emitted by each owning service AND notification-bound) AND the shared approval
 * engine's `ApprovalCompleted` (emitted ONCE per chain completion by `@aegis/approvals`, for EVERY
 * approvable record type, carrying the canonical `recordType`/`recordId`/`outcome`). Subscribing the
 * engine path to BOTH would double-fire `RuleEvent.ApprovalCompleted` for every approval (the engine
 * stages `ApprovalCompleted` in the same tx the owning service then emits its `*Approved` from). We
 * therefore pick ONE canonical trigger: `EventTopic.ApprovalCompleted`. It is the only source that
 * (a) fires exactly once per chain resolution, (b) covers every record type uniformly, and (c) also
 * surfaces REJECTED outcomes (the `*Approved` topics are approve-only). The per-domain `*Approved`
 * topics stay — they drive notifications — but they NO LONGER map to a RuleEvent, so a rule fires
 * once per approval via the engine path, never twice.
 *
 * Loop guard: workflow itself emits `ApprovalCommand`, `RecordUpdated`, `NotificationRequested`, and
 * `ConnectorPushRequested` from its builtin actions — NONE of those topics appear in this map, so the
 * RULES ENGINE never consumes a topic it produces (no infinite re-trigger). `ConnectorPushRequested`
 * IS consumed by the separate ERP-sync consumer (see connector-sync.consumer.ts), which performs the
 * push and runs no rules, so it cannot re-trigger the engine either.
 *
 * The bus rebuilds the RequestContext from the envelope (tenant + correlation id), so RLS and audit
 * attribution hold across the async hop — there is NO user permission check here (the originating
 * write was already authorized; workflow trusts the propagated, verified context).
 * See docs/services/workflow.md §10.3.
 */
const TOPIC_TO_RULE_EVENT: Partial<Record<EventTopic, RuleEvent>> = {
  // A record entered the system / approval flow.
  [EventTopic.ExpenseSubmitted]: RuleEvent.RecordSubmitted,
  [EventTopic.InvoiceReceived]: RuleEvent.RecordSubmitted,
  // An approval resolved — the SINGLE canonical trigger (W5-12). The shared approval engine emits
  // `ApprovalCompleted` exactly once per chain, for every record type, so rules fire once per
  // approval. The per-domain `*Approved` topics are intentionally NOT mapped here (they'd double-fire).
  [EventTopic.ApprovalCompleted]: RuleEvent.ApprovalCompleted,
};

/**
 * Normalize a domain envelope into the engine's header-level Facts. Each domain payload carries a
 * resource id under a topic-specific key (reportId/invoiceId/payRunId) plus a status; we surface a
 * uniform `record_type`/`id`/`status` the validators read, and pass the rest of the payload through.
 *
 * W5-12 — the canonical `ApprovalCompleted` payload (the now-sole approval trigger) carries the
 * polymorphic key as `recordType`/`recordId` (engine-canonical, camelCase) rather than a
 * topic-specific `*Id`. We resolve those FIRST so a completed approval for ANY record type
 * (expense_report / invoice / pay_run) yields the same uniform `record_type`/`id` the validators read,
 * with the topic-specific keys kept as a fallback for the `RecordSubmitted` triggers.
 */
function toFacts(env: EventEnvelope): Facts {
  const payload = (env.payload ?? {}) as Record<string, unknown>;
  const recordType =
    (payload['recordType'] as string | undefined) ??
    ('reportId' in payload
      ? 'expense_report'
      : 'invoiceId' in payload
        ? 'invoice'
        : 'payRunId' in payload
          ? 'pay_run'
          : (payload['record_type'] as string | undefined));
  const id =
    payload['recordId'] ??
    payload['reportId'] ??
    payload['invoiceId'] ??
    payload['payRunId'] ??
    payload['id'];
  return { ...payload, record_type: recordType, id };
}

async function runRulesForEvent(env: EventEnvelope, ruleEvent: RuleEvent): Promise<void> {
  const facts = toFacts(env);
  const service = container.get(RuleService);
  const verdicts = await service.evaluateRules(ruleEvent, facts);
  Logger.info(`workflow evaluated ${verdicts.length} rule(s) for ${ruleEvent} (from ${env.topic})`);
}

/**
 * Subscribe the workflow worker's consumers. Called once at bootstrap (worker role only). Two
 * distinct subscriptions, neither re-triggering the rules engine on a topic it produces:
 *   1. the RULES engine on the domain triggers it auto-runs on (TOPIC_TO_RULE_EVENT), and
 *   2. the ERP-SYNC consumer (W2-07) on ConnectorPushRequested — it performs the connector push OFF
 *      the request path, idempotently, with the bus's retry → DLQ. It consumes the connector topic but
 *      does NOT run rules, so there is no produce-then-consume loop in the engine.
 */
export function registerConsumers(): void {
  const bus = getBus();
  for (const [topic, ruleEvent] of Object.entries(TOPIC_TO_RULE_EVENT) as Array<[EventTopic, RuleEvent]>) {
    bus.subscribe(topic, (env: EventEnvelope) => runRulesForEvent(env, ruleEvent));
  }
  registerConnectorSyncConsumer();
  // BUG-0001: apply rule-driven approval commands (auto_approve / assign_approval_policy) via the
  // shared engine. Like the ERP-sync consumer it consumes a topic workflow produces but runs the
  // approval ENGINE, not the rules engine, so there is no produce-then-consume rule loop.
  registerApprovalCommandConsumer();
  Logger.info('workflow consumers registered', { topics: Object.keys(TOPIC_TO_RULE_EVENT) });
}
