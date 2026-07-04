import type {
  LlmChooseToolInput,
  LlmClient,
  LlmToolChoice,
} from '../src/orchestrator/llm-client';
import { OpenAiCompatibleLlmClient } from '../src/orchestrator/openai-compatible-client';
import { LlmGateway } from '../src/llm/llm-gateway';
import { AnthropicLlmClient } from '../src/llm/anthropic-client';
import { buildLlmGateway, readLlmProviderSpecsFromEnv } from '../src/llm/llm-factory';
import type { LlmProviderConfig } from '../src/llm/provider-types';

/**
 * OFFLINE gateway tests — every provider is a stub {@link LlmClient}, no network is touched. Proves
 * priority selection, explicit active override, error fallback, disabled skipping, runtime mutation,
 * all-fail behavior, and the factory's kind→client mapping. Plus a mocked-fetch parse test of
 * {@link AnthropicLlmClient}.
 */

/** A stub client that always returns a tagged assistant message so we can assert who served. */
function stubClient(tag: string): LlmClient {
  return {
    chooseTool: async (): Promise<LlmToolChoice> => ({ assistantMessage: tag }),
  };
}

/** A stub client that always throws — exercises fallback. */
function throwingClient(name: string): LlmClient {
  return {
    chooseTool: async (): Promise<LlmToolChoice> => {
      throw new Error(`${name} exploded`);
    },
  };
}

const INPUT: LlmChooseToolInput = { userMessage: 'hi', tools: [] };

function cfg(
  name: string,
  priority: number,
  client: LlmClient,
  enabled = true,
): LlmProviderConfig {
  return { name, priority, enabled, client };
}

describe('LlmGateway — selection, priority, runtime switching, fallback', () => {
  it('routes to the highest-priority (lowest number) enabled provider', async () => {
    const gw = new LlmGateway()
      .register(cfg('b', 2, stubClient('B')))
      .register(cfg('a', 1, stubClient('A')));
    const res = await gw.chooseTool(INPUT);
    expect(res.assistantMessage).toBe('A');
    expect(gw.lastServedBy()).toBe('a');
  });

  it('breaks priority ties by registration order (deterministic)', async () => {
    const gw = new LlmGateway()
      .register(cfg('first', 5, stubClient('FIRST')))
      .register(cfg('second', 5, stubClient('SECOND')));
    const res = await gw.chooseTool(INPUT);
    expect(res.assistantMessage).toBe('FIRST');
  });

  it('explicit setActive overrides priority (pins the chosen provider to the front)', async () => {
    const gw = new LlmGateway()
      .register(cfg('a', 1, stubClient('A')))
      .register(cfg('b', 2, stubClient('B')));
    gw.setActive('b');
    expect(gw.getActive()).toBe('b');
    const res = await gw.chooseTool(INPUT);
    expect(res.assistantMessage).toBe('B');
    expect(gw.lastServedBy()).toBe('b');
  });

  it('setActive on an unknown provider throws', () => {
    const gw = new LlmGateway().register(cfg('a', 1, stubClient('A')));
    expect(() => gw.setActive('nope')).toThrow(/unknown provider/i);
  });

  it('falls back to the next enabled provider by priority when the primary throws', async () => {
    const gw = new LlmGateway()
      .register(cfg('primary', 1, throwingClient('primary')))
      .register(cfg('backup', 2, stubClient('BACKUP')));
    const res = await gw.chooseTool(INPUT);
    expect(res.assistantMessage).toBe('BACKUP');
    expect(gw.lastServedBy()).toBe('backup');
  });

  it('active provider that throws still falls back to the next by priority', async () => {
    const gw = new LlmGateway()
      .register(cfg('a', 1, stubClient('A')))
      .register(cfg('b', 2, throwingClient('b')))
      .register(cfg('c', 3, stubClient('C')));
    gw.setActive('b'); // pinned front, but throws → next by priority is a, then c
    const res = await gw.chooseTool(INPUT);
    expect(res.assistantMessage).toBe('A');
  });

  it('skips disabled providers for both selection and fallback', async () => {
    const gw = new LlmGateway()
      .register(cfg('a', 1, stubClient('A'), false)) // disabled → skipped
      .register(cfg('b', 2, stubClient('B')));
    const res = await gw.chooseTool(INPUT);
    expect(res.assistantMessage).toBe('B');
  });

  it('a disabled active selection is ignored — routing falls back to priority order', async () => {
    const gw = new LlmGateway()
      .register(cfg('a', 1, stubClient('A')))
      .register(cfg('b', 2, stubClient('B')));
    gw.setActive('b');
    gw.disable('b');
    const res = await gw.chooseTool(INPUT);
    expect(res.assistantMessage).toBe('A');
  });

  it('setPriority changes selection at runtime', async () => {
    const gw = new LlmGateway()
      .register(cfg('a', 1, stubClient('A')))
      .register(cfg('b', 2, stubClient('B')));
    expect((await gw.chooseTool(INPUT)).assistantMessage).toBe('A');
    gw.setPriority('b', 0); // b now beats a
    expect((await gw.chooseTool(INPUT)).assistantMessage).toBe('B');
  });

  it('enable/disable change selection at runtime', async () => {
    const gw = new LlmGateway()
      .register(cfg('a', 1, stubClient('A')))
      .register(cfg('b', 2, stubClient('B')));
    gw.disable('a');
    expect((await gw.chooseTool(INPUT)).assistantMessage).toBe('B');
    gw.enable('a');
    expect((await gw.chooseTool(INPUT)).assistantMessage).toBe('A');
  });

  it('throws a clear error when all providers fail', async () => {
    const gw = new LlmGateway()
      .register(cfg('a', 1, throwingClient('a')))
      .register(cfg('b', 2, throwingClient('b')));
    await expect(gw.chooseTool(INPUT)).rejects.toThrow(
      /all providers failed.*a exploded.*b exploded/is,
    );
  });

  it('throws when there are no enabled providers to route to', async () => {
    const gw = new LlmGateway().register(cfg('a', 1, stubClient('A'), false));
    await expect(gw.chooseTool(INPUT)).rejects.toThrow(/no enabled providers/i);
  });

  it('setPriority/enable/disable on an unknown provider throw', () => {
    const gw = new LlmGateway();
    expect(() => gw.setPriority('x', 1)).toThrow(/unknown provider/i);
    expect(() => gw.enable('x')).toThrow(/unknown provider/i);
    expect(() => gw.disable('x')).toThrow(/unknown provider/i);
  });

  it('register replaces an existing provider by name', () => {
    const gw = new LlmGateway()
      .register(cfg('a', 1, stubClient('A')))
      .register(cfg('a', 9, stubClient('A2')));
    expect(gw.listProviders()).toHaveLength(1);
    expect(gw.listProviders()[0].priority).toBe(9);
  });
});

describe('buildLlmGateway — maps kinds to the right client classes', () => {
  it('constructs anthropic → AnthropicLlmClient and openai-compatible → OpenAiCompatibleLlmClient', () => {
    const gw = buildLlmGateway(
      [
        { name: 'anthropic', kind: 'anthropic', apiKey: 'k', model: 'claude-x', priority: 1 },
        {
          name: 'groq',
          kind: 'openai-compatible',
          baseUrl: 'https://api.groq.com/openai/v1',
          apiKey: 'k',
          model: 'llama',
          priority: 2,
        },
      ],
      { activeName: 'anthropic' },
    );
    const providers = gw.listProviders();
    const anthropic = providers.find((p) => p.name === 'anthropic')!;
    const groq = providers.find((p) => p.name === 'groq')!;
    expect(anthropic.client).toBeInstanceOf(AnthropicLlmClient);
    expect(groq.client).toBeInstanceOf(OpenAiCompatibleLlmClient);
    expect(gw.getActive()).toBe('anthropic');
  });

  it('defaults priority to declaration order and enabled to true', () => {
    const gw = buildLlmGateway([
      { name: 'one', kind: 'anthropic', apiKey: 'k', model: 'm' },
      { name: 'two', kind: 'anthropic', apiKey: 'k', model: 'm' },
    ]);
    const [a, b] = gw.listProviders();
    expect(a.priority).toBe(0);
    expect(b.priority).toBe(1);
    expect(a.enabled).toBe(true);
  });
});

describe('readLlmProviderSpecsFromEnv', () => {
  it('parses AEGIS_LLM_PROVIDERS JSON', () => {
    const specs = readLlmProviderSpecsFromEnv({
      AEGIS_LLM_PROVIDERS: JSON.stringify([
        { name: 'a', kind: 'anthropic', apiKey: 'k', model: 'm', priority: 1 },
      ]),
    } as NodeJS.ProcessEnv);
    expect(specs).toHaveLength(1);
    expect(specs[0].kind).toBe('anthropic');
  });

  it('falls back to the single-provider env as one openai-compatible "default"', () => {
    const specs = readLlmProviderSpecsFromEnv({
      AEGIS_LLM_BASE_URL: 'https://api.openai.com/v1',
      AEGIS_LLM_API_KEY: 'sk',
      AEGIS_LLM_MODEL: 'gpt-4o',
    } as NodeJS.ProcessEnv);
    expect(specs).toEqual([
      {
        name: 'default',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk',
        model: 'gpt-4o',
      },
    ]);
  });

  it('returns [] when nothing is configured', () => {
    expect(readLlmProviderSpecsFromEnv({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('throws on malformed AEGIS_LLM_PROVIDERS JSON', () => {
    expect(() =>
      readLlmProviderSpecsFromEnv({ AEGIS_LLM_PROVIDERS: '{not json' } as NodeJS.ProcessEnv),
    ).toThrow(/not valid JSON/i);
  });
});

describe('AnthropicLlmClient — mocked fetch, offline parse', () => {
  function fetchReturning(body: unknown): typeof fetch {
    return (async () =>
      ({ json: async () => body }) as unknown as Response) as unknown as typeof fetch;
  }

  it('parses a tool_use response into { toolName, args }', async () => {
    const client = new AnthropicLlmClient({
      apiKey: 'k',
      model: 'claude-x',
      fetchImpl: fetchReturning({
        content: [
          { type: 'text', text: 'let me do that' },
          { type: 'tool_use', name: 'create_expense', input: { amount: 1500 } },
        ],
      }),
    });
    const res = await client.chooseTool({
      userMessage: 'file an expense',
      tools: [{ name: 'create_expense', description: 'x', inputSchema: {} }],
    });
    expect(res.toolName).toBe('create_expense');
    expect(res.args).toEqual({ amount: 1500 });
    expect(res.assistantMessage).toBeUndefined();
  });

  it('parses a text-only response into { assistantMessage }', async () => {
    const client = new AnthropicLlmClient({
      apiKey: 'k',
      model: 'claude-x',
      fetchImpl: fetchReturning({
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'there.' },
        ],
      }),
    });
    const res = await client.chooseTool({ userMessage: 'hi', tools: [] });
    expect(res.toolName).toBeUndefined();
    expect(res.assistantMessage).toBe('Hello there.');
  });

  it('sends the Anthropic REST shape (x-api-key, /v1/messages, input_schema)', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const spyFetch = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return { json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const client = new AnthropicLlmClient({
      apiKey: 'secret-key',
      model: 'claude-x',
      baseUrl: 'https://example.test/',
      fetchImpl: spyFetch,
    });
    await client.chooseTool({
      userMessage: 'hi',
      tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
    });

    expect(seenUrl).toBe('https://example.test/v1/messages');
    const headers = seenInit!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('secret-key');
    expect(headers['anthropic-version']).toBeTruthy();
    const body = JSON.parse(seenInit!.body as string);
    expect(body.tools[0]).toEqual({ name: 't', description: 'd', input_schema: { type: 'object' } });
    expect(body.messages[body.messages.length - 1]).toEqual({ role: 'user', content: 'hi' });
  });
});
