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
import { generateToolRegistry, toMcpToolDefinition } from '@aegis/ai-core';
import { createAegisMcpToolServer } from '../src/mcp/mcp-tool-server';

/**
 * MCP TRANSPORT smoke/mapping test. Offline and deterministic: NO live LLM, NO network MCP client. We
 * build a tiny guarded Express app (context → authenticate → authorize(PEP) → validate → handler, with
 * an in-memory Casbin enforcer), construct the MCP server via the factory, then drive it through the
 * SDK's in-memory transport with a real MCP `Client`. This proves (a) the factory maps the auto-generated
 * registry to MCP `tools/list` correctly and (b) an MCP `tools/call` still flows through the GUARDED route
 * — the governed core allows/denies, the MCP layer is not a bypass.
 *
 * The SDK is ESM-only behind subpath exports; under the repo's CommonJS tsconfig we load its `Client` and
 * `InMemoryTransport` via a guarded dynamic `import()` (same technique the server file uses), so this spec
 * stays strict-typecheck-clean without touching any tsconfig.
 */
const TENANT = '00000000-0000-4000-8000-000000000001';
const SECRET = 'test-secret';

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function('s', 'return import(s);') as (
  s: string,
) => Promise<Record<string, unknown>>;

// Locate the SDK's CommonJS build (fallback for Jest, which forbids dynamic ESM import by default).
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
  listTools(): Promise<{ tools: Array<{ name: string; description: string; inputSchema: unknown }> }>;
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
  const InMemoryTransport = inMemMod.InMemoryTransport as {
    createLinkedPair(): [unknown, unknown];
  };
  return {
    makeClient: () => new ClientCtor({ name: 'test-client', version: '0.0.0' }),
    linkedTransports: () => InMemoryTransport.createLinkedPair(),
  };
}

const createExpenseSchema = Joi.object({
  amount: Joi.number().integer().required(),
  currency: Joi.string().length(3).optional(),
});
const expenseIdParamSchema = Joi.object({ id: Joi.string().uuid().required() });

function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(contextMiddleware({ mintCorrelationIdIfAbsent: true }));
  app.post(
    '/expense/v1/expenses',
    authenticate(),
    authorize(Permission.ExpenseReportCreate),
    validate(createExpenseSchema),
    (req, res) => res.status(201).json({ data: { created: true, amount: req.body.amount } }),
  );
  app.get(
    '/expense/v1/expenses/:id',
    authenticate(),
    authorize(Permission.ExpenseReportView),
    validate(expenseIdParamSchema, 'params'),
    (req, res) => res.status(200).json({ data: { id: req.params.id } }),
  );
  app.use(errorMiddleware);
  return app;
}

function tokenFor(roles: string[]): string {
  return jwt.sign({ sub: 'u1', tenant_id: TENANT, roles }, SECRET);
}

describe('MCP tool server (registry → MCP tools/list + governed tools/call)', () => {
  const app = buildApp();
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const enforcer = await createInMemoryEnforcer({
      policies: [
        { sub: 'expense-manager', dom: TENANT, act: Permission.ExpenseReportCreate },
        { sub: 'expense-manager', dom: TENANT, act: Permission.ExpenseReportView },
        { sub: 'viewer', dom: TENANT, act: Permission.ExpenseReportView },
      ],
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

  it('registers exactly the auto-generated tools (mapping = toMcpToolDefinition)', async () => {
    const mcp = await createAegisMcpToolServer({
      app,
      invoke: { baseUrl, tokenProvider: () => tokenFor(['expense-manager']), tenantId: TENANT },
    });
    const expected = generateToolRegistry(app).tools;
    expect(mcp.tools).toHaveLength(expected.length);
    expect(new Set(mcp.tools.map((t) => t.name))).toEqual(new Set(expected.map((t) => t.name)));
    // The MCP definition for each tool is exactly the toMcpToolDefinition mapping.
    for (const tool of mcp.tools) {
      expect(toMcpToolDefinition(tool)).toEqual({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
    await mcp.close();
  });

  it('exposes only the filtered tools when a principal filter is given', async () => {
    const mcp = await createAegisMcpToolServer({
      app,
      invoke: { baseUrl, tokenProvider: () => tokenFor(['viewer']), tenantId: TENANT },
      filter: { permissions: [String(Permission.ExpenseReportView)] },
    });
    // A viewer holds only the read permission → only the GET tool is exposed.
    expect(mcp.tools.map((t) => t.method)).toEqual(['GET']);
    await mcp.close();
  });

  it('lists tools over a real in-memory MCP round-trip', async () => {
    const { makeClient, linkedTransports } = await loadClientSdk();
    const mcp = await createAegisMcpToolServer({
      app,
      invoke: { baseUrl, tokenProvider: () => tokenFor(['expense-manager']), tenantId: TENANT },
    });
    const [clientTransport, serverTransport] = linkedTransports();
    const client = makeClient();
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    const expected = new Set(generateToolRegistry(app).tools.map((t) => t.name));
    expect(new Set(listed.tools.map((t) => t.name))).toEqual(expected);
    // inputSchema survived transport intact as JSON Schema (has a type/properties, not a Zod object).
    const create = listed.tools.find((t) => t.name.includes('expenses') && !t.name.includes('id'));
    expect(create?.inputSchema).toMatchObject({ type: 'object' });

    await client.close();
    await mcp.close();
  });

  it('INVOKES a tool over MCP → the guarded route executes it (allowed principal)', async () => {
    const { makeClient, linkedTransports } = await loadClientSdk();
    const mcp = await createAegisMcpToolServer({
      app,
      invoke: { baseUrl, tokenProvider: () => tokenFor(['expense-manager']), tenantId: TENANT },
    });
    const [clientTransport, serverTransport] = linkedTransports();
    const client = makeClient();
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

    const createTool = mcp.tools.find((t) => t.method === 'POST')!;
    const res = await client.callTool({ name: createTool.name, arguments: { amount: 1500 } });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as { data?: { created?: boolean; amount?: number } };
    expect(body.data).toMatchObject({ created: true, amount: 1500 });

    await client.close();
    await mcp.close();
  });

  it('is DENIED by the PEP over MCP when the principal lacks the permission (no bypass)', async () => {
    const { makeClient, linkedTransports } = await loadClientSdk();
    // A viewer token, but we still expose the write tool → the PEP must deny at call time.
    const mcp = await createAegisMcpToolServer({
      app,
      invoke: { baseUrl, tokenProvider: () => tokenFor(['viewer']), tenantId: TENANT },
    });
    const [clientTransport, serverTransport] = linkedTransports();
    const client = makeClient();
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

    const createTool = mcp.tools.find((t) => t.method === 'POST')!;
    const res = await client.callTool({ name: createTool.name, arguments: { amount: 1500 } });
    // Governed denial surfaces as an MCP error result carrying the 403 body — not a silent success.
    expect(res.isError).toBe(true);

    await client.close();
    await mcp.close();
  });
});
