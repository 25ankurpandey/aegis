import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import Joi from 'joi';
import jwt from 'jsonwebtoken';
import { contextMiddleware, validate, errorMiddleware } from '@aegis/service-core';
import {
  authenticate,
  authorize,
  createInMemoryEnforcer,
  setEnforcer,
  resetEnforcer,
} from '@aegis/access-control';
import { Permission } from '@aegis/shared-enums';
import { generateToolRegistry } from '../src/tool-registry/generate-tool-registry';
import type { AegisTool } from '../src/tool-registry/types';
import { evaluateActionGate } from '../src/danger/danger-gate';
import { deriveDangerFacts } from '../src/orchestrator/derive-danger-facts';
import type { DangerDecision } from '../src/danger/types';
import type { IndependentVerifier } from '../src/verification/verifier';
import type { VerificationRequest, VerificationVerdict } from '../src/verification/types';
import * as toolServer from '../src/tool-server/tool-server';
import {
  ceremonySatisfied,
  executeSupervisedWrite,
  mapBlast,
  type CeremonyEvidence,
} from '../src/execution/supervised-write';
import { createAegisMcpToolServer } from '../src/mcp/mcp-tool-server';

/**
 * D19 — THE SUPERVISED-WRITE PATH. Proves a dangerous write executes ONLY when the ceremony is satisfied
 * AND the verifier passes, and — the headline invariant — that the UNSAFE paths never reach invokeTool.
 *
 * Reuses the governed mini-app + in-memory enforcer + signed JWT pattern from tool-loop.spec.ts, so the
 * SAFE case really traverses `context → authenticate → authorize(PEP) → validate → handler`.
 */
const TENANT = '00000000-0000-4000-8000-000000000001';
const SECRET = 'test-secret';

const createPaymentSchema = Joi.object({
  amountMinor: Joi.number().integer().required(),
  currency: Joi.string().length(3).optional(),
});

function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(contextMiddleware({ mintCorrelationIdIfAbsent: true }));
  // A money-moving write: POST with an amountMinor ⇒ mapBlast === 'money' (a MATERIAL write).
  app.post(
    '/payment/v1/payments',
    authenticate(),
    authorize(Permission.ExpenseReportCreate),
    validate(createPaymentSchema),
    (req, res) => res.status(201).json({ data: { created: true, amountMinor: req.body.amountMinor } }),
  );
  app.use(errorMiddleware);
  return app;
}

function tokenFor(roles: string[]): string {
  return jwt.sign({ sub: 'u1', tenant_id: TENANT, roles }, SECRET);
}

/** A stub verifier whose verdict is fixed — no network, no model. */
function stubVerifier(verdict: VerificationVerdict): IndependentVerifier {
  return {
    verify: async (_req: VerificationRequest): Promise<VerificationVerdict> => verdict,
  };
}

const APPROVED: VerificationVerdict = {
  verified: true,
  methods: ['dual_control'],
  reasons: ['stub: independent (different-model) verifier approved'],
};
const REJECTED: VerificationVerdict = {
  verified: false,
  methods: [],
  reasons: ['stub: independent verifier rejected'],
};

describe('supervised-write path (D19): ceremony AND verifier, else refused', () => {
  const app = buildApp();
  let server: Server;
  let baseUrl: string;
  let tools: AegisTool[];
  const token = tokenFor(['expense-manager']);

  const paymentTool = () =>
    tools.find((t) => t.path === '/payment/v1/payments' && t.method === 'POST')!;

  let invokeSpy: jest.SpyInstance;

  beforeAll(async () => {
    const enforcer = await createInMemoryEnforcer({
      policies: [{ sub: 'expense-manager', dom: TENANT, act: Permission.ExpenseReportCreate }],
    });
    setEnforcer(enforcer);
    tools = generateToolRegistry(app).tools;
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    resetEnforcer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    // Spy that still calls the real invokeTool — so the SAFE case really hits the governed route, while
    // every test can assert whether invokeTool was reached at all (the headline invariant).
    invokeSpy = jest.spyOn(toolServer, 'invokeTool');
  });
  afterEach(() => {
    invokeSpy.mockRestore();
  });

  const invokeCtx = () => ({ baseUrl, token, tenantId: TENANT });

  // A money write big enough to trip the monetary dimension ⇒ non-allow ceremony (needs_ceremony).
  const moneyArgs = { amountMinor: 5_000_000 }; // $50k

  it('mapBlast classifies a money write as material', () => {
    const facts = deriveDangerFacts(paymentTool(), moneyArgs);
    expect(mapBlast(facts)).toBe('money');
  });

  it('the danger gate demands a ceremony for the money write (not allow)', () => {
    const decision = evaluateActionGate(deriveDangerFacts(paymentTool(), moneyArgs), {});
    expect(decision.ceremony).not.toBe('allow');
  });

  it('(i) UNSAFE — needs_ceremony write with NO/!granted approval ⇒ refused, NO HTTP call', async () => {
    const decision: DangerDecision = evaluateActionGate(
      deriveDangerFacts(paymentTool(), moneyArgs),
      {},
    );
    // Ceremony demands human proof; supply none (or a non-granted approval).
    const evidence: CeremonyEvidence = { approval: { approvalId: 'a1', status: 'pending' } };

    const res = await executeSupervisedWrite({
      tool: paymentTool(),
      args: moneyArgs,
      invoke: invokeCtx(),
      decision,
      evidence,
      verify: { deterministic: true, independent: stubVerifier(APPROVED), expected: 5_000_000, deterministicRecheck: async () => ({ value: 5_000_000 }) },
    });

    expect(res.executed).toBe(false);
    expect(res.refusedReason).toMatch(/ceremony not satisfied/i);
    expect(invokeSpy).not.toHaveBeenCalled(); // HEADLINE: never reached invokeTool
  });

  it('(ii) UNSAFE — money write, ceremony satisfied BUT verifier not passing ⇒ refused, NO HTTP call', async () => {
    const decision = evaluateActionGate(deriveDangerFacts(paymentTool(), moneyArgs), {});
    const evidence = satisfyingEvidence(decision);

    // (a) same-model / rejected independent verifier.
    const rejected = await executeSupervisedWrite({
      tool: paymentTool(),
      args: moneyArgs,
      invoke: invokeCtx(),
      decision,
      evidence,
      verify: {
        deterministic: true,
        deterministicRecheck: async () => ({ value: 5_000_000 }),
        expected: 5_000_000,
        independent: stubVerifier(REJECTED),
      },
    });
    expect(rejected.executed).toBe(false);
    expect(rejected.verification?.verified).toBe(false);
    expect(invokeSpy).not.toHaveBeenCalled();

    // (b) deterministic MISMATCH (recompute != expected) even with an approving independent verifier.
    const mismatch = await executeSupervisedWrite({
      tool: paymentTool(),
      args: moneyArgs,
      invoke: invokeCtx(),
      decision,
      evidence,
      verify: {
        deterministic: true,
        deterministicRecheck: async () => ({ value: 999 }), // != expected
        expected: 5_000_000,
        independent: stubVerifier(APPROVED),
      },
    });
    expect(mismatch.executed).toBe(false);
    expect(mismatch.verification?.verified).toBe(false);

    // (c) sampled-only: no deterministic, no independent ⇒ material AND cannot be met.
    const sampledOnly = await executeSupervisedWrite({
      tool: paymentTool(),
      args: moneyArgs,
      invoke: invokeCtx(),
      decision,
      evidence,
      verify: {},
    });
    expect(sampledOnly.executed).toBe(false);
    expect(sampledOnly.verification?.verified).toBe(false);

    expect(invokeSpy).not.toHaveBeenCalled(); // HEADLINE across all three material-verifier failures
  });

  it('(iii) SAFE — ceremony granted + deterministic match + independent(different-model) ⇒ executed, governed 201', async () => {
    const decision = evaluateActionGate(deriveDangerFacts(paymentTool(), moneyArgs), {});
    const evidence = satisfyingEvidence(decision);

    const res = await executeSupervisedWrite({
      tool: paymentTool(),
      args: moneyArgs,
      invoke: invokeCtx(),
      decision,
      evidence,
      verify: {
        deterministic: true,
        deterministicRecheck: async () => ({ value: 5_000_000 }),
        expected: 5_000_000,
        independent: stubVerifier(APPROVED),
        proposerModelId: 'proposer-model',
      },
    });

    expect(res.executed).toBe(true);
    expect(res.verification?.verified).toBe(true);
    expect(res.result?.status).toBe(201);
    expect(res.result?.body).toMatchObject({ data: { created: true, amountMinor: 5_000_000 } });
    expect(invokeSpy).toHaveBeenCalledTimes(1); // the ONE sanctioned invocation
  });

  it('(iv) typed_confirm with the WRONG phrase ⇒ refused, NO HTTP call', async () => {
    const decision: DangerDecision = {
      ceremony: 'typed_confirm',
      level: 2,
      assessment: { level: 2, dimensions: {}, reasons: [] },
      requiresHuman: false,
      typedConfirmationPhrase: 'CREATE 1 payments',
      reasons: [],
    };

    const res = await executeSupervisedWrite({
      tool: paymentTool(),
      args: moneyArgs,
      invoke: invokeCtx(),
      decision,
      evidence: { typedConfirmation: 'not the phrase' },
    });

    expect(res.executed).toBe(false);
    expect(res.refusedReason).toMatch(/phrase mismatch/i);
    expect(invokeSpy).not.toHaveBeenCalled();

    // Sanity: the EXACT phrase satisfies the ceremony predicate (non-material blast would then execute).
    expect(ceremonySatisfied(decision, { typedConfirmation: 'CREATE 1 payments' }).ok).toBe(true);
  });

  it('(v) block ceremony ⇒ ALWAYS refused, NO HTTP call', async () => {
    const decision: DangerDecision = {
      ceremony: 'block',
      level: 5,
      assessment: { level: 5, dimensions: {}, reasons: [] },
      requiresHuman: true,
      reviewQueue: true,
      reasons: [],
    };

    // Even with maximal "evidence" a block is terminal.
    const res = await executeSupervisedWrite({
      tool: paymentTool(),
      args: moneyArgs,
      invoke: invokeCtx(),
      decision,
      evidence: {
        typedConfirmation: 'anything',
        confirmedAt: Date.now(),
        confirmed: true,
        stepUp: { verified: true },
        approval: { approvalId: 'a1', status: 'granted' },
        outOfBandConfirmed: true,
      },
    });

    expect(res.executed).toBe(false);
    expect(res.refusedReason).toMatch(/block/i);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('ceremonySatisfied enforces each ceremony deterministically', () => {
    expect(ceremonySatisfied(d('allow'), {}).ok).toBe(true);

    expect(ceremonySatisfied(d('confirm'), {}).ok).toBe(false);
    expect(ceremonySatisfied(d('confirm'), { confirmedAt: Date.now() }).ok).toBe(true);
    expect(ceremonySatisfied(d('confirm'), { confirmed: true }).ok).toBe(true);

    expect(ceremonySatisfied(d('step_up'), {}).ok).toBe(false);
    expect(ceremonySatisfied(d('step_up'), { stepUp: { verified: false } }).ok).toBe(false);
    expect(ceremonySatisfied(d('step_up'), { stepUp: { verified: true } }).ok).toBe(true);

    expect(ceremonySatisfied(d('second_approver'), { approval: { approvalId: 'a', status: 'denied' } }).ok).toBe(false);
    expect(ceremonySatisfied(d('second_approver'), { approval: { approvalId: 'a', status: 'granted' } }).ok).toBe(true);

    // cooling_off: an aged confirmation passes; a fresh one does not.
    const cool = { ...d('cooling_off'), coolingOffMs: 1000 };
    expect(ceremonySatisfied(cool, { confirmedAt: Date.now() }).ok).toBe(false);
    expect(ceremonySatisfied(cool, { confirmedAt: Date.now() - 5000 }).ok).toBe(true);

    // requiresOutOfBand is an ADDITIONAL requirement on top of the per-ceremony check.
    const oob: DangerDecision = { ...d('second_approver'), requiresOutOfBand: true };
    expect(ceremonySatisfied(oob, { approval: { approvalId: 'a', status: 'granted' } }).ok).toBe(false);
    expect(
      ceremonySatisfied(oob, {
        approval: { approvalId: 'a', status: 'granted' },
        outOfBandConfirmed: true,
      }).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// MCP wiring: a dangerous tools/call short-circuits with isError + the required ceremony (NO invoke).
// ---------------------------------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function('s', 'return import(s);') as (
  s: string,
) => Promise<Record<string, unknown>>;

function resolveSdkCjsDir(): string {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '@modelcontextprotocol', 'sdk');
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return path.join(candidate, 'dist', 'cjs');
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('cannot find @modelcontextprotocol/sdk');
    dir = parent;
  }
}

async function importSdk(subpath: string): Promise<Record<string, unknown>> {
  try {
    return await dynamicImport(`@modelcontextprotocol/sdk/${subpath}`);
  } catch {
    const path = require('node:path') as typeof import('node:path');
    return require(path.join(resolveSdkCjsDir(), subpath)) as Record<string, unknown>;
  }
}

interface McpClient {
  connect(transport: unknown): Promise<void>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
  close(): Promise<void>;
}

async function loadClientSdk(): Promise<{
  makeClient: () => McpClient;
  linkedTransports: () => [unknown, unknown];
}> {
  const clientMod = await importSdk('client/index.js');
  const inMemMod = await importSdk('inMemory.js');
  const ClientCtor = clientMod.Client as new (info: { name: string; version: string }) => McpClient;
  const InMemoryTransport = inMemMod.InMemoryTransport as { createLinkedPair(): [unknown, unknown] };
  return {
    makeClient: () => new ClientCtor({ name: 'test-client', version: '0.0.0' }),
    linkedTransports: () => InMemoryTransport.createLinkedPair(),
  };
}

describe('MCP tools/call runs the danger gate BEFORE invoking (opt-in dangerContext)', () => {
  const TENANT2 = '00000000-0000-4000-8000-000000000001';
  const app = buildApp();
  let server: Server;
  let baseUrl: string;
  let invokeSpy: jest.SpyInstance;

  beforeAll(async () => {
    const enforcer = await createInMemoryEnforcer({
      policies: [{ sub: 'expense-manager', dom: TENANT2, act: Permission.ExpenseReportCreate }],
    });
    setEnforcer(enforcer);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    resetEnforcer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    invokeSpy = jest.spyOn(toolServer, 'invokeTool');
  });
  afterEach(() => invokeSpy.mockRestore());

  it('a dangerous (money) tools/call returns isError + the required ceremony and does NOT invoke', async () => {
    const { makeClient, linkedTransports } = await loadClientSdk();
    const mcp = await createAegisMcpToolServer({
      app,
      invoke: { baseUrl, tokenProvider: () => tokenFor(['expense-manager']), tenantId: TENANT2 },
      dangerContext: {}, // opt IN to the gate
    });
    const [clientTransport, serverTransport] = linkedTransports();
    const client = makeClient();
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

    const paymentTool = mcp.tools.find((t) => t.method === 'POST')!;
    const res = await client.callTool({
      name: paymentTool.name,
      arguments: { amountMinor: 5_000_000 }, // $50k ⇒ ceremony !== allow
    });

    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text) as { error?: string; ceremony?: string };
    expect(body.error).toBe('ceremony_required');
    expect(body.ceremony).not.toBe('allow');
    // HEADLINE: the gate short-circuited — invokeTool was never reached.
    expect(invokeSpy).not.toHaveBeenCalled();

    await client.close();
    await mcp.close();
  });
});

/** A bare decision with just a ceremony, for the predicate unit checks. */
function d(ceremony: DangerDecision['ceremony']): DangerDecision {
  return {
    ceremony,
    level: 0,
    assessment: { level: 0, dimensions: {}, reasons: [] },
    requiresHuman: false,
    reasons: [],
  };
}

/** Produce evidence that satisfies whatever ceremony `decision` demands (for the "ceremony passes" cases). */
function satisfyingEvidence(decision: DangerDecision): CeremonyEvidence {
  const e: CeremonyEvidence = {
    confirmedAt: Date.now() - (decision.coolingOffMs ?? 0) - 1000,
    confirmed: true,
    stepUp: { verified: true },
    approval: { approvalId: 'a1', status: 'granted' },
  };
  if (decision.typedConfirmationPhrase) e.typedConfirmation = decision.typedConfirmationPhrase;
  if (decision.requiresOutOfBand) e.outOfBandConfirmed = true;
  return e;
}
