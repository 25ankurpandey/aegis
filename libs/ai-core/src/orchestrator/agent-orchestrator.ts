import type { Application } from 'express';
import {
  listToolsForPrincipal,
  invokeTool,
  toMcpToolDefinition,
  type InvokeResult,
} from '../tool-server/tool-server';
import type { AegisTool } from '../tool-registry/types';
import { evaluateActionGate } from '../danger/danger-gate';
import type { DangerDecision } from '../danger/types';
import type {
  ApprovalGateway,
  ApprovalHandle,
} from '../danger/approval-gateway';
import type { LlmClient, LlmHistoryMessage } from './llm-client';
import { deriveDangerFacts } from './derive-danger-facts';

/**
 * The AGENT ORCHESTRATOR — the first "talk to the app" loop. It runs one turn: (1) computes the tools the
 * principal may use, (2) shows ONLY those to the model, (3) if the model picks one of them, invokes it
 * through the guarded route (`invokeTool` → context → authenticate → authorize(PEP) → validate → RLS →
 * audit), and (4) returns the governed result.
 *
 * READ-ONLY / PROPOSE-SAFE TODAY: the orchestrator never bypasses the core. `invokeTool` still hits the
 * PEP, so an unauthorized action is denied by the core regardless of what the model wants. Three
 * invariants make this safe:
 *   - the model is only ever shown the FILTERED tool set (`listToolsForPrincipal`),
 *   - the orchestrator NEVER invents a tool: if the model names a tool that was not in the filtered offer,
 *     the turn is `refused` and NO HTTP call is made (defense in depth, on top of the PEP), and
 *   - the ENFORCED 2nd AXIS (danger): after the model picks a permitted tool and BEFORE `invokeTool`, the
 *     orchestrator runs the deterministic danger gate on server-derived facts. Only an `allow` ceremony
 *     is auto-executed; every write / dangerous action is SURFACED as `needs_ceremony` and NEVER
 *     auto-executed. Write-autonomy stays OFF — actually driving the confirm/step-up/approval flow is the
 *     app's job (this loop only refuses to run without it). The LLM never computes danger and cannot talk
 *     the classifier down (facts come from {@link deriveDangerFacts}, not from model output).
 */

/** Where/how the orchestrator reaches the governed service when invoking a chosen tool. */
export interface AgentInvokeContext {
  baseUrl: string;
  token: string;
  tenantId: string;
  correlationId?: string;
  fetchImpl?: typeof fetch;
}

/** The principal on whose behalf the turn runs — decides which tools are offered. */
export interface AgentPrincipal {
  /** Permissions the principal holds; a tool is offered only if the principal holds one of its permissions. */
  permissions: string[];
  /** Optional entitlement gate: offer a tool only if its module is enabled for the tenant. */
  isModuleEnabled?: (tool: AegisTool) => boolean;
}

/** Tenant-scoped danger inputs the gate needs beyond the derived facts. */
export interface AgentTenantContext {
  /**
   * How many DISTINCT humans could serve as a second approver (excluding the requester). Fed straight
   * into the danger gate. Undefined ⇒ the gate FAILS SAFE, treating the tenant as single-human
   * (out-of-band + review queue), never as silent self-approval.
   */
  approverPoolSize?: number;
}

/** Inputs to a single {@link runAgentTurn} call. */
export interface RunAgentTurnParams {
  app: Application;
  llm: LlmClient;
  invoke: AgentInvokeContext;
  principal: AgentPrincipal;
  userMessage: string;
  history?: LlmHistoryMessage[];
  /** Tenant danger context (approver pool). Omitted ⇒ the gate fails safe to single-human. */
  tenant?: AgentTenantContext;
  /**
   * Optional bridge to the app's approvals engine. When supplied AND the decision is `second_approver`,
   * the orchestrator opens the human gate and attaches the returned handle. Absent ⇒ the turn simply
   * surfaces `needs_ceremony` and lets the app drive the flow.
   */
  approvals?: ApprovalGateway;
}

/** The model chose an offered tool and the governed core executed it. */
export interface AgentToolTurn {
  kind: 'tool';
  toolName: string;
  args: Record<string, unknown>;
  result: InvokeResult;
}

/** The model chose to reply in natural language rather than call a tool. */
export interface AgentMessageTurn {
  kind: 'message';
  text: string;
}

/** The model named a tool that was NOT in the filtered offer — nothing was invoked. */
export interface AgentRefusedTurn {
  kind: 'refused';
  reason: string;
}

/**
 * The model chose a PERMITTED tool, but the deterministic danger gate ruled it a write / dangerous
 * action that must not auto-execute. NOTHING was invoked: the turn surfaces the required ceremony so the
 * app can drive the confirm / step-up / approval flow. `decision` carries the full server-computed
 * ceremony (facts came from {@link deriveDangerFacts}, never from the model). When an
 * {@link ApprovalGateway} was supplied and the decision required a second approver, `approval` holds the
 * opened handle.
 */
export interface AgentNeedsCeremonyTurn {
  kind: 'needs_ceremony';
  tool: AegisTool;
  toolName: string;
  args: Record<string, unknown>;
  decision: DangerDecision;
  approval?: ApprovalHandle;
}

/** The outcome of one orchestrated turn. */
export type AegisTurnResult =
  | AgentToolTurn
  | AgentMessageTurn
  | AgentRefusedTurn
  | AgentNeedsCeremonyTurn;

/**
 * Run one agent turn against a live governed app. See the file doc-comment for the safety invariants.
 */
export async function runAgentTurn(params: RunAgentTurnParams): Promise<AegisTurnResult> {
  const { app, llm, invoke, principal, userMessage, history, tenant, approvals } = params;

  // (a) The LLM sees ONLY the tools this principal may use.
  const tools = listToolsForPrincipal(app, {
    permissions: principal.permissions,
    isModuleEnabled: principal.isModuleEnabled,
  });

  // (b) Ask the model to pick a tool (or reply), showing it only the filtered set.
  const choice = await llm.chooseTool({
    userMessage,
    tools: tools.map(toMcpToolDefinition),
    history,
  });

  // (c) The model chose a tool. Only invoke it if it was actually in the offered set.
  if (choice.toolName) {
    const chosen = tools.find((t) => t.name === choice.toolName);
    if (!chosen) {
      // (e) Named a tool outside the filtered offer — never invoke it.
      return {
        kind: 'refused',
        reason: `Model chose tool "${choice.toolName}" which is not in the offered set.`,
      };
    }
    const args = choice.args ?? {};

    // (c1) ENFORCED 2nd AXIS (danger). Compute the ceremony from SERVER-DERIVED facts (never model
    // output) and BEFORE any invoke. `approverPoolSize` is undefined by default ⇒ the gate fails safe
    // to a single-human tenant. Only an `allow` ceremony auto-executes; every write / dangerous action
    // is surfaced as `needs_ceremony` and NEVER auto-executed (write-autonomy stays OFF — driving the
    // confirm / step-up / approval flow is the app's job).
    const decision = evaluateActionGate(deriveDangerFacts(chosen, args), {
      approverPoolSize: tenant?.approverPoolSize,
    });

    if (decision.ceremony !== 'allow') {
      // (c2) Optionally open the human gate if the app wired an approvals bridge and a second approver
      // is required; otherwise just surface the required ceremony. Either way, NOTHING is invoked.
      let approval: ApprovalHandle | undefined;
      if (approvals && decision.ceremony === 'second_approver') {
        approval = await approvals.requireApproval({
          requesterPrincipal: principal.permissions.join(','),
          tenantId: invoke.tenantId,
          actionRef: chosen.name,
          decision,
          factsSummary: `${chosen.method} ${chosen.path}`,
          ...(decision.requiresOutOfBand ? { outOfBand: true } : {}),
          ...(invoke.correlationId ? { correlationId: invoke.correlationId } : {}),
        });
      }
      return {
        kind: 'needs_ceremony',
        tool: chosen,
        toolName: chosen.name,
        args,
        decision,
        ...(approval ? { approval } : {}),
      };
    }

    // (c3) `allow`: read / low-danger tool — proceed through the guarded route as today.
    const result = await invokeTool(chosen, args, invoke);
    return { kind: 'tool', toolName: chosen.name, args, result };
  }

  // (d) No tool — return the natural-language reply.
  return { kind: 'message', text: choice.assistantMessage ?? '' };
}
