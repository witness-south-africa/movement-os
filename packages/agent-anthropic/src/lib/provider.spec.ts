import { z } from 'zod';
import type {
  AgentMessage,
  CompleteArgs,
  ModelProvider,
} from '@wsa/agent-contracts';
import type {
  AnthropicClient,
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessageRequest,
  AnthropicRequestOptions,
} from './anthropic-client.js';
import { createAnthropicProvider } from './provider.js';

const OUTPUT = z.object({ ok: z.boolean() }).strict();
const USER: AgentMessage = { role: 'user', content: 'Return a record.' };
const ARGS: CompleteArgs<typeof OUTPUT> = {
  schema: OUTPUT,
  messages: [USER],
  taskKind: 'analysis',
};

function message(overrides: Partial<AnthropicMessage> = {}): AnthropicMessage {
  return {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model: 'explicit-test-model',
    content: [{ type: 'text', text: '{"ok":true}' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 11, output_tokens: 5 },
    ...overrides,
  };
}

function fakeClient(
  responder: () => AnthropicMessage | Promise<AnthropicMessage> = () =>
    message(),
) {
  const calls: {
    request: AnthropicMessageRequest;
    options: AnthropicRequestOptions | undefined;
  }[] = [];
  const client: AnthropicClient = {
    messages: {
      create: (request, options) => {
        calls.push({ request, options });
        return Promise.resolve(responder());
      },
    },
  };
  return { client, calls };
}

function providerFor(raw: unknown): ModelProvider {
  const { client } = fakeClient(() => raw as AnthropicMessage);
  return createAnthropicProvider({ client, model: 'explicit-test-model' });
}

describe('createAnthropicProvider', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('freezes its anthropic identity and uses an explicit configuration snapshot', async () => {
    const { client, calls } = fakeClient();
    const config = {
      client,
      model: 'original-model',
      defaultMaxOutputTokens: 700,
    };
    const provider = createAnthropicProvider(config);
    config.model = 'changed-model';
    config.defaultMaxOutputTokens = 1;
    expect(Object.isFrozen(provider)).toBe(true);
    expect(Reflect.set(provider, 'id', 'openai')).toBe(false);
    expect(provider.id).toBe('anthropic');
    await provider.complete(ARGS);
    expect(calls[0]?.request.model).toBe('original-model');
    expect(calls[0]?.request.max_tokens).toBe(700);
  });

  it.each(['', '  ', 'unsafe\nmodel', 'x'.repeat(257)])(
    'rejects invalid explicit model %p',
    (model) => {
      const { client, calls } = fakeClient();
      expect(() => createAnthropicProvider({ client, model })).toThrow(
        /explicit non-empty identifier/,
      );
      expect(calls).toHaveLength(0);
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid default ceiling %p',
    (defaultMaxOutputTokens) => {
      const { client } = fakeClient();
      expect(() =>
        createAnthropicProvider({
          client,
          model: 'chosen',
          defaultMaxOutputTokens,
        }),
      ).toThrow(/positive safe integer/);
    },
  );

  it('requires a callable native Messages client', () => {
    expect(() =>
      createAnthropicProvider({
        client: {} as AnthropicClient,
        model: 'chosen',
      }),
    ).toThrow(/client.messages.create/);
  });

  it('maps leading system blocks and preserves native conversation order exactly', async () => {
    const { client, calls } = fakeClient();
    const provider = createAnthropicProvider({ client, model: 'chosen' });
    const messages: AgentMessage[] = [
      { role: 'system', content: 'First instruction.\nRetain this line.' },
      { role: 'system', content: 'Second instruction.' },
      { role: 'user', content: 'First user.' },
      { role: 'assistant', content: 'Previous reply.' },
      { role: 'user', content: 'Final user.' },
    ];
    await provider.complete({
      ...ARGS,
      messages,
      requestId: 'private-identifying-trace',
    });
    expect(calls[0]?.request).toEqual({
      model: 'chosen',
      max_tokens: 4096,
      system: [
        { type: 'text', text: messages[0]?.content },
        { type: 'text', text: messages[1]?.content },
      ],
      messages: messages.slice(2),
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
      },
    });
    expect(JSON.stringify(calls[0]?.request)).not.toContain(
      'private-identifying-trace',
    );
    expect(calls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits system/metadata/tools entirely when absent and allows an empty tool list', async () => {
    const { client, calls } = fakeClient();
    await createAnthropicProvider({ client, model: 'chosen' }).complete({
      ...ARGS,
      tools: [],
    });
    expect(Object.hasOwn(calls[0]?.request ?? {}, 'system')).toBe(false);
    expect(Object.hasOwn(calls[0]?.request ?? {}, 'metadata')).toBe(false);
    expect(Object.hasOwn(calls[0]?.request ?? {}, 'tools')).toBe(false);
  });

  it('forwards the exact caller ceiling instead of clamping to the configured default', async () => {
    const { client, calls } = fakeClient();
    const provider = createAnthropicProvider({
      client,
      model: 'chosen',
      defaultMaxOutputTokens: 100,
    });
    await provider.complete({ ...ARGS, maxOutputTokens: 731 });
    expect(calls[0]?.request.max_tokens).toBe(731);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid caller ceiling %p before dispatch',
    async (maxOutputTokens) => {
      const { client, calls } = fakeClient();
      await expect(
        createAnthropicProvider({ client, model: 'chosen' }).complete({
          ...ARGS,
          maxOutputTokens,
        }),
      ).rejects.toThrow(/positive safe integer/);
      expect(calls).toHaveLength(0);
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])(
    'rejects invalid timeout %p before dispatch',
    async (timeoutMs) => {
      const { client, calls } = fakeClient();
      await expect(
        createAnthropicProvider({ client, model: 'chosen' }).complete({
          ...ARGS,
          timeoutMs,
        }),
      ).rejects.toThrow(/timeoutMs/);
      expect(calls).toHaveLength(0);
    },
  );

  const unsupportedConversations: ReadonlyArray<ReadonlyArray<AgentMessage>> = [
    [],
    [{ role: 'system', content: 'Only system.' }],
    [{ role: 'assistant', content: 'No initial user.' }, USER],
    [USER, { role: 'system', content: 'Interior instruction.' }, USER],
    [USER, { role: 'assistant', content: 'Prefill.' }],
    [{ role: 'user', content: '' }],
    [{ role: 'tool', content: 'Unsupported role.' } as unknown as AgentMessage],
  ];
  it.each(unsupportedConversations.map((messages) => ({ messages })))(
    'rejects unsupported conversation %p before dispatch',
    async ({ messages }) => {
      const { client, calls } = fakeClient();
      await expect(
        createAnthropicProvider({ client, model: 'chosen' }).complete({
          ...ARGS,
          messages,
        }),
      ).rejects.toThrow(/conversation|instructions|prefill/);
      expect(calls).toHaveLength(0);
    },
  );

  it('rejects tool declarations before dispatch instead of silently dropping them', async () => {
    const { client, calls } = fakeClient();
    await expect(
      createAnthropicProvider({ client, model: 'chosen' }).complete({
        ...ARGS,
        tools: [
          {
            name: 'lookup',
            description: 'Lookup',
            parameters: z.object({ id: z.string() }),
          },
        ],
      }),
    ).rejects.toThrow(/tool declarations/);
    expect(calls).toHaveLength(0);
  });

  it('rejects an invalid runtime task kind before dispatch', async () => {
    const { client, calls } = fakeClient();
    await expect(
      createAnthropicProvider({ client, model: 'chosen' }).complete({
        ...ARGS,
        taskKind: 'invented' as CompleteArgs<typeof OUTPUT>['taskKind'],
      }),
    ).rejects.toThrow(/task kind/);
    expect(calls).toHaveLength(0);
  });

  it('returns locally parsed output and safe native completion metadata', async () => {
    const result = await providerFor(message()).complete(ARGS);
    expect(result).toEqual({
      value: { ok: true },
      provider: 'anthropic',
      model: 'explicit-test-model',
      responseId: 'msg_fixture',
      rawFinishReason: 'end_turn',
      status: 'completed',
      usage: {
        inputTokens: 11,
        outputTokens: 5,
        totalTokens: 16,
        cachedInputTokens: 0,
      },
    });
  });

  it.each([
    'max_tokens',
    'stop_sequence',
    'tool_use',
    'pause_turn',
    'refusal',
    'model_context_window_exceeded',
    'unknown-future-stop',
    null,
  ])(
    'maps stop reason %p conservatively to incomplete',
    async (stop_reason) => {
      const result = await providerFor(message({ stop_reason })).complete(ARGS);
      expect(result.status).toBe('incomplete');
      expect(result.rawFinishReason).toBe(stop_reason ?? 'unknown');
    },
  );

  const invalidContents: ReadonlyArray<ReadonlyArray<AnthropicContentBlock>> = [
    [],
    [
      { type: 'text', text: '{"ok":true}' },
      { type: 'text', text: '{"ok":true}' },
    ],
    [{ type: 'tool_use' }],
    [{ type: 'thinking' }, { type: 'text', text: '{"ok":true}' }],
    [{ type: 'text' }],
    [{ type: 'text', text: '' }],
  ];
  it.each(invalidContents.map((content) => ({ content })))(
    'rejects missing, ambiguous or non-text response blocks %p',
    async ({ content }) => {
      await expect(
        providerFor(message({ content })).complete(ARGS),
      ).rejects.toThrow(/invalid response content or metadata/);
    },
  );

  it.each([
    undefined,
    null,
    {},
    message({ id: '' }),
    message({ id: 'x'.repeat(513) }),
    message({ id: 'unsafe\nmetadata' }),
    message({ model: '' }),
    message({ model: 'x'.repeat(257) }),
    message({ stop_reason: '' }),
    { ...message(), role: 'user' },
    { ...message(), type: 'other' },
    { ...message(), stop_reason: 42 },
    { ...message(), usage: null },
  ])('rejects malformed native response metadata %p', async (raw) => {
    await expect(providerFor(raw).complete(ARGS)).rejects.toThrow(
      /invalid response content or metadata/,
    );
  });

  it.each([
    'not-json secret-source',
    '{"ok":"secret-source"}',
    '{"ok":true,"extra":"secret-source"}',
  ])(
    'rejects invalid JSON/schema output without exposing source %p',
    async (text) => {
      const pending = providerFor(
        message({ content: [{ type: 'text', text }] }),
      ).complete(ARGS);
      await expect(pending).rejects.toThrow(
        /not valid JSON|output schema validation/,
      );
      await expect(pending).rejects.not.toThrow(/secret-source/);
    },
  );

  it('enforces original string/array/numeric constraints removed from native output schema', async () => {
    const schema = z
      .object({
        name: z.string().min(3).max(5),
        count: z.number().min(2).max(8),
        rows: z.array(z.boolean()).min(2).max(3),
      })
      .strict();
    const { client, calls } = fakeClient(() =>
      message({
        content: [
          { type: 'text', text: '{"name":"a","count":1,"rows":[true]}' },
        ],
      }),
    );
    const pending = createAnthropicProvider({
      client,
      model: 'chosen',
    }).complete({ ...ARGS, schema });
    await expect(pending).rejects.toThrow(/output schema validation/);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]?.request.output_config)).not.toContain(
      '"minLength":3,',
    );
    expect(calls[0]?.request.output_config.format.schema).toMatchObject({
      properties: {
        name: { description: expect.stringContaining('minLength') },
        count: { description: expect.stringContaining('minimum') },
        rows: { description: expect.stringContaining('minItems') },
      },
    });
  });

  it('accounts for cache write/read tokens without inventing money', async () => {
    const result = await providerFor(
      message({
        usage: {
          input_tokens: 11,
          output_tokens: 5,
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 13,
        },
      }),
    ).complete(ARGS);
    expect(result.usage).toEqual({
      inputTokens: 31,
      outputTokens: 5,
      totalTokens: 36,
      cachedInputTokens: 13,
    });
    expect(Object.hasOwn(result.usage, 'costInUsdTicks')).toBe(false);
  });

  it('normalizes nullable cache counters to zero', async () => {
    const result = await providerFor(
      message({
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      }),
    ).complete(ARGS);
    expect(result.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      cachedInputTokens: 0,
    });
  });

  it('rejects missing native usage instead of reporting an unobserved paid call as zero', async () => {
    const { usage: _usage, ...withoutUsage } = message();
    await expect(providerFor(withoutUsage).complete(ARGS)).rejects.toThrow(
      /invalid response content or metadata/,
    );
  });

  it.each([
    { input_tokens: -1, output_tokens: 1 },
    { input_tokens: 1.5, output_tokens: 1 },
    { input_tokens: NaN, output_tokens: 1 },
    { input_tokens: Infinity, output_tokens: 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 1 },
    { input_tokens: 1, output_tokens: -1 },
    { input_tokens: 1, output_tokens: 1.5 },
    { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: -1 },
    { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1.5 },
    { input_tokens: '1', output_tokens: 1 },
    { output_tokens: 1 },
  ])('rejects invalid native usage counters %p', async (usage) => {
    await expect(
      providerFor({ ...message(), usage }).complete(ARGS),
    ).rejects.toThrow(/invalid response content or metadata/);
  });

  it.each([
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    {
      input_tokens: Number.MAX_SAFE_INTEGER,
      output_tokens: 0,
      cache_creation_input_tokens: 1,
    },
    {
      input_tokens: 0,
      output_tokens: Number.MAX_SAFE_INTEGER,
      cache_read_input_tokens: 1,
    },
  ])('rejects overflowing native usage totals %p', async (usage) => {
    await expect(
      providerFor(message({ usage })).complete(ARGS),
    ).rejects.toThrow(/token usage total/);
  });

  it('rejects promptly and aborts even when the transport ignores cancellation', async () => {
    jest.useFakeTimers();
    let resolveTransport: ((value: AnthropicMessage) => void) | undefined;
    let capturedSignal: AbortSignal | undefined;
    const client: AnthropicClient = {
      messages: {
        create: (_request, options) => {
          capturedSignal = options?.signal;
          return new Promise((resolve) => {
            resolveTransport = resolve;
          });
        },
      },
    };
    const pending = createAnthropicProvider({
      client,
      model: 'chosen',
    }).complete({ ...ARGS, timeoutMs: 25 });
    const assertion = expect(pending).rejects.toThrow(/request timed out/);
    jest.advanceTimersByTime(25);
    await assertion;
    expect(capturedSignal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    resolveTransport?.(message());
    await expect(pending).rejects.toThrow(/request timed out/);
  });

  it('clears a pending timeout after a successful transport call', async () => {
    jest.useFakeTimers();
    const { client, calls } = fakeClient();
    await createAnthropicProvider({ client, model: 'chosen' }).complete({
      ...ARGS,
      timeoutMs: 50,
    });
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(100);
    expect(calls[0]?.options?.signal?.aborted).toBe(false);
  });

  it('clears timers on rejection, sanitizes transport errors and makes one call without retry', async () => {
    jest.useFakeTimers();
    const { client, calls } = fakeClient(() =>
      Promise.reject(new Error('secret credential/source')),
    );
    const pending = createAnthropicProvider({
      client,
      model: 'chosen',
    }).complete({ ...ARGS, timeoutMs: 50 });
    await expect(pending).rejects.toThrow(
      'anthropic adapter: transport failed',
    );
    await expect(pending).rejects.not.toThrow(/secret/);
    expect(calls).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not arm a timer when timeout is absent', async () => {
    jest.useFakeTimers();
    const { client } = fakeClient();
    await createAnthropicProvider({ client, model: 'chosen' }).complete(ARGS);
    expect(jest.getTimerCount()).toBe(0);
  });
});
