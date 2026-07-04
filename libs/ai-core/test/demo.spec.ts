import { runDemo } from '../../../scripts/demo/agent-loop-demo';
import type { AgentToolTurn, AgentNeedsCeremonyTurn } from '@aegis/ai-core';

/**
 * Verifies the runnable demo harness (scripts/demo/agent-loop-demo.ts) drives the whole governed loop
 * offline and that BOTH control axes fire: (1) a WRITE (create) is stopped by the DANGER gate
 * (needs_ceremony, no HTTP call); (2) a low-danger read auto-executes (200); (3) a tool the principal
 * can't use isn't offered (reply); (4) a low-danger read whose bearer token lacks the grant is DENIED
 * by the PEP at the route (403 — no bypass); (5) off-topic replies. Proves the demo works and keeps it
 * runnable in CI without a TS runner or any network/keys.
 */
describe('agent-loop demo harness (offline, governed loop)', () => {
  it('runs the whole loop and each step is governed as expected', async () => {
    const result = await runDemo(() => {
      /* silence the demo's console output during the test */
    });

    expect(result.mode).toContain('offline STUB');
    expect(result.steps).toHaveLength(5);

    // 1) Manager asks to CREATE (a write) -> the danger gate requires a ceremony; NOT auto-executed.
    // ($1500 is a lightweight `confirm`; full human approval only kicks in at higher danger — so we
    // assert the write was GATED, i.e. some ceremony beyond `allow`, not that it needed a human.)
    const create = result.steps[0].turn as AgentNeedsCeremonyTurn;
    expect(create.kind).toBe('needs_ceremony');
    expect(create.toolName).toMatch(/^post_/);
    expect(create.decision.ceremony).not.toBe('allow');
    expect(create.decision.level).toBeGreaterThanOrEqual(1);
    expect(create).not.toHaveProperty('result'); // no HTTP call was made

    // 2) Manager reads by id -> low-danger read auto-executes, governed 200.
    const read = result.steps[1].turn as AgentToolTurn;
    expect(read.kind).toBe('tool');
    expect(read.result.status).toBe(200);

    // 3) Viewer create request -> the create tool isn't even offered, so the model replies (no HTTP).
    expect(result.steps[2].turn.kind).toBe('message');

    // 4) Read IS offered + passes the danger gate, but the bearer token has no grant -> PEP DENIES (403).
    const denied = result.steps[3].turn as AgentToolTurn;
    expect(denied.kind).toBe('tool');
    expect(denied.result.status).toBe(403);
    expect(denied.result.ok).toBe(false);

    // 5) Off-topic -> natural-language reply, no tool call.
    expect(result.steps[4].turn.kind).toBe('message');
  });
});
