/**
 * @aegis/ai-core — the shared AI substrate every module plugs into (the AI analog of how
 * access-control / db / events are shared libs). First capability: the **tool registry generator** —
 * it walks a service's live Express router and emits authz-bound, self-describing tool descriptors
 * derived from the route's method/path + the `Permission` stamped by `authorize()` + the Joi input
 * schema stamped by `validate()`. This is the keystone of the agentic layer: any new route becomes an
 * agent tool by construction, with zero manual wiring (self-sustaining / auto-growing).
 *
 * See docs/strategy/ai-native-core.md (the AI-Native Module Contract) and docs/strategy/agentic-*.md.
 */
export * from './tool-registry/types';
export * from './tool-registry/joi-to-json-schema';
export * from './tool-registry/generate-tool-registry';
export * from './tool-registry/filter-tools';
export * from './tool-registry/tool-manifest';
export * from './tool-server/tool-server';
export * from './execution/supervised-write';
export * from './mcp/mcp-tool-server';
export * from './orchestrator/llm-client';
export * from './orchestrator/openai-compatible-client';
export * from './orchestrator/agent-orchestrator';
export * from './orchestrator/derive-danger-facts';
export * from './verification/types';
export * from './verification/verifier';
export * from './verification/trust-rule';
export * from './danger/types';
export * from './danger/danger-classifier';
export * from './danger/danger-policy';
export * from './danger/approval-gateway';
export * from './danger/danger-gate';
export * from './tool-registry/registry-validation';
export * from './execution/supervised-action-broker';
export * from './memory/conversation-store';
export * from './memory/run-conversation';
export * from './ui/ui-spec';
export * from './ui/render-turn';
export * from './llm/provider-types';
export * from './llm/anthropic-client';
export * from './llm/llm-gateway';
export * from './llm/llm-factory';
export * from './persistence/redis-conversation-store';
export * from './persistence/redis-pending-action-store';
export * from './persistence/redis-stores';
// The FIRST autonomous capability: the PROPOSE-ONLY self-audit (verifier-gated; no write path).
export * from './autonomy/types';
export * from './autonomy/self-audit';
