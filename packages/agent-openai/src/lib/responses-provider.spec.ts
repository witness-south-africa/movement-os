import type { CompleteArgs } from '@wsa/agent-contracts';
import { z } from 'zod';
import {
  OpenAiResponsesError,
  type OpenAiAccessMode,
  type OpenAiResponsesClient,
  type OpenAiResponsesRequest,
} from './responses-client.js';
import { createOpenAiResponsesProvider } from './responses-provider.js';

const schema = z.object({ ok: z.boolean() });
const args: CompleteArgs<typeof schema> = {
  schema,
  taskKind: 'analysis',
  messages: [{ role: 'user', content: 'Return the record.' }],
};

function nativeResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'resp_test',
    object: 'response',
    model: 'gpt-explicit',
    status: 'completed',
    error: null,
    incomplete_details: null,
    output: [
      {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          { type: 'output_text', text: '{"ok":true}', annotations: [] },
        ],
      },
    ],
    usage: {
      input_tokens: 11,
      output_tokens: 5,
      total_tokens: 16,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
    ...overrides,
  };
}

function terminal(response = nativeResponse()): Record<string, unknown> {
  return { type: 'response.completed', response, sequence_number: 4 };
}

function fakeClient(
  events: readonly unknown[],
  accessMode: OpenAiAccessMode = 'api',
) {
  const calls: { request: OpenAiResponsesRequest; signal: AbortSignal }[] = [];
  const closed = jest.fn();
  const client: OpenAiResponsesClient = {
    accessMode,
    responses: {
      create: (request, options) => {
        calls.push({ request, signal: options.signal });
        return Promise.resolve({
          [Symbol.asyncIterator]: async function* () {
            try {
              for (const event of events) {
                yield await Promise.resolve(event);
              }
            } finally {
              closed();
            }
          },
        });
      },
    },
  };
  return { client, calls, closed };
}

function providerFor(
  events: readonly unknown[],
  mode: OpenAiAccessMode = 'api',
) {
  const fake = fakeClient(events, mode);
  return {
    ...fake,
    provider: createOpenAiResponsesProvider({
      client: fake.client,
      model: 'gpt-explicit',
    }),
  };
}

describe('createOpenAiResponsesProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each(['api', 'subscription'] as const)(
    'reports validated native output and actual token usage in %s mode',
    async (mode) => {
      const { provider, calls } = providerFor([terminal()], mode);
      const result = await provider.complete(args);
      expect(provider.id).toBe('openai');
      expect(provider.accessMode).toBe(mode);
      expect(Object.isFrozen(provider)).toBe(true);
      expect(result).toEqual({
        value: { ok: true },
        provider: 'openai',
        accessMode: mode,
        model: 'gpt-explicit',
        responseId: 'resp_test',
        status: 'completed',
        rawFinishReason: 'completed',
        usage: {
          inputTokens: 11,
          outputTokens: 5,
          totalTokens: 16,
          cachedInputTokens: 3,
        },
      });
      expect(result.usage).not.toHaveProperty('costInUsdTicks');
      expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    },
  );

  it('sends strict schema and preserves conversation order while mapping system to developer', async () => {
    const fake = fakeClient([terminal()]);
    const provider = createOpenAiResponsesProvider({
      client: fake.client,
      model: 'gpt-explicit',
      responseSchemaName: 'record',
    });
    await provider.complete({
      ...args,
      requestId: 'trace-only',
      maxOutputTokens: 42,
      messages: [
        { role: 'system', content: 'Produce JSON.' },
        { role: 'user', content: 'Earlier request.' },
        { role: 'assistant', content: 'Earlier answer.' },
        { role: 'user', content: 'Current request.' },
      ],
    });
    expect(fake.calls[0]?.request).toEqual({
      model: 'gpt-explicit',
      store: false,
      stream: true,
      max_output_tokens: 42,
      input: [
        { role: 'developer', content: 'Produce JSON.' },
        { role: 'user', content: 'Earlier request.' },
        { role: 'assistant', content: 'Earlier answer.' },
        { role: 'user', content: 'Current request.' },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'record',
          strict: true,
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
      },
    });
    expect(fake.calls[0]?.request).not.toHaveProperty('user');
    expect(fake.calls[0]?.request).not.toHaveProperty('metadata');
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid API cap %s before transport', async (maxOutputTokens) => {
    const { provider, calls } = providerFor([terminal()]);
    await expect(
      provider.complete({ ...args, maxOutputTokens }),
    ).rejects.toMatchObject({ code: 'unsupported_request' });
    expect(calls).toHaveLength(0);
  });

  it.each([1, 100, 0, -1, Number.NaN])(
    'rejects every supplied subscription cap %s before transport',
    async (maxOutputTokens) => {
      const { provider, calls } = providerFor([terminal()], 'subscription');
      await expect(
        provider.complete({ ...args, maxOutputTokens }),
      ).rejects.toMatchObject({ code: 'unsupported_request' });
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    [
      'tools',
      {
        tools: [
          { name: 'tool', description: 'tool', parameters: z.object({}) },
        ],
      },
    ],
    ['invalid lane', { taskKind: 'invalid' }],
    ['empty conversation', { messages: [] }],
    ['empty text', { messages: [{ role: 'user', content: '' }] }],
    ['invalid role', { messages: [{ role: 'tool', content: 'data' }] }],
    ['system only', { messages: [{ role: 'system', content: 'data' }] }],
    [
      'assistant prefill',
      {
        messages: [
          { role: 'user', content: 'data' },
          { role: 'assistant', content: 'prefix' },
        ],
      },
    ],
    ['optional schema', { schema: z.object({ value: z.string().optional() }) }],
    ['timeout zero', { timeoutMs: 0 }],
    ['timeout above range', { timeoutMs: 2_147_483_648 }],
  ])('rejects %s before transport', async (_label, overrides) => {
    const { provider, calls } = providerFor([terminal()]);
    await expect(
      provider.complete({ ...args, ...overrides } as CompleteArgs<
        typeof schema
      >),
    ).rejects.toMatchObject({ code: 'unsupported_request' });
    expect(calls).toHaveLength(0);
  });

  it('ignores provisional text and uses only the completed snapshot, including native reasoning', async () => {
    const { provider } = providerFor([
      { type: 'response.created', response: { id: 'resp_test' } },
      { type: 'response.in_progress', response: { id: 'resp_test' } },
      { type: 'response.output_text.delta', delta: '{"ok":false}' },
      terminal(
        nativeResponse({
          output: [
            { id: 'rs_test', type: 'reasoning', summary: [] },
            ...(nativeResponse().output as unknown[]),
          ],
        }),
      ),
    ]);
    expect((await provider.complete(args)).value).toEqual({ ok: true });
  });

  it('requires clean EOF after completion instead of returning early', async () => {
    let allowEnd: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      allowEnd = resolve;
    });
    const client: OpenAiResponsesClient = {
      accessMode: 'api',
      responses: {
        create: () =>
          Promise.resolve({
            [Symbol.asyncIterator]: async function* () {
              yield terminal();
              await waiting;
            },
          }),
      },
    };
    const provider = createOpenAiResponsesProvider({
      client,
      model: 'gpt-explicit',
    });
    let settled = false;
    const result = provider.complete(args).then((value) => {
      settled = true;
      return value;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    allowEnd?.();
    expect((await result).status).toBe('completed');
  });

  it.each([
    [
      'EOF without terminal',
      [{ type: 'response.output_text.delta', delta: '{"ok":true}' }],
    ],
    ['empty stream', []],
    ['duplicate terminal', [terminal(), terminal()]],
    [
      'incomplete',
      [
        {
          type: 'response.incomplete',
          response: nativeResponse({ status: 'incomplete' }),
        },
      ],
    ],
    [
      'refusal event',
      [{ type: 'response.refusal.delta', delta: 'no' }, terminal()],
    ],
    [
      'tool event',
      [
        { type: 'response.output_item.added', item: { type: 'function_call' } },
        terminal(),
      ],
    ],
    [
      'refusal part',
      [
        {
          type: 'response.content_part.added',
          part: { type: 'refusal', refusal: 'no' },
        },
        terminal(),
      ],
    ],
    [
      'refusal item',
      [
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            content: [{ type: 'refusal', refusal: 'no' }],
          },
        },
        terminal(),
      ],
    ],
    [
      'incomplete item',
      [
        {
          type: 'response.output_item.done',
          item: { type: 'message', status: 'incomplete' },
        },
        terminal(),
      ],
    ],
    ['unknown event', [{ type: 'unknown' }, terminal()]],
    ['malformed event', [null, terminal()]],
    [
      'malformed delta',
      [{ type: 'response.output_text.delta', delta: 7 }, terminal()],
    ],
    [
      'mismatched response ID',
      [
        { type: 'response.created', response: { id: 'resp_other' } },
        terminal(),
      ],
    ],
    [
      'late event',
      [terminal(), { type: 'response.output_text.delta', delta: 'extra' }],
    ],
  ])('rejects %s and closes the iterator', async (_label, events) => {
    const { provider, closed } = providerFor(events as readonly unknown[]);
    await expect(provider.complete(args)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    await Promise.resolve();
    expect(closed).toHaveBeenCalled();
  });

  it.each([
    ['subscription_sharing_usage_limit_exceeded', 'quota_exhausted'],
    ['subscription_sharing_usage_unavailable', 'subscription_unavailable'],
    ['unknown-sensitive-code', 'transport_failed'],
  ])(
    'sanitizes structured failure %s even after completion',
    async (nativeCode, code) => {
      const { provider } = providerFor([
        terminal(),
        {
          type: 'response.failed',
          response: {
            error: {
              code: nativeCode,
              message: 'private token and source text',
            },
          },
        },
      ]);
      let caught: unknown;
      try {
        await provider.complete(args);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OpenAiResponsesError);
      expect(caught).toMatchObject({
        code,
        message: `openai responses adapter: ${code}`,
      });
      expect(caught).not.toHaveProperty('cause');
      expect(String(caught)).not.toMatch(/private|sensitive/);
    },
  );

  it('recognizes an explicit top-level quota error', async () => {
    const { provider } = providerFor([
      { type: 'error', code: 'subscription_sharing_usage_limit_exceeded' },
    ]);
    await expect(provider.complete(args)).rejects.toMatchObject({
      code: 'quota_exhausted',
    });
  });

  it.each([
    ['missing usage', { usage: undefined }],
    [
      'negative input',
      { usage: { input_tokens: -1, output_tokens: 5, total_tokens: 4 } },
    ],
    [
      'fractional output',
      { usage: { input_tokens: 1, output_tokens: 1.5, total_tokens: 2.5 } },
    ],
    [
      'unsafe total',
      {
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    ],
    [
      'overflow sum',
      {
        usage: {
          input_tokens: Number.MAX_SAFE_INTEGER,
          output_tokens: 1,
          total_tokens: Number.MAX_SAFE_INTEGER,
        },
      },
    ],
    [
      'inconsistent total',
      { usage: { input_tokens: 11, output_tokens: 5, total_tokens: 15 } },
    ],
    [
      'invalid cache',
      {
        usage: {
          input_tokens: 11,
          output_tokens: 5,
          total_tokens: 16,
          input_tokens_details: { cached_tokens: 12 },
        },
      },
    ],
    [
      'invalid reasoning usage',
      {
        usage: {
          input_tokens: 11,
          output_tokens: 5,
          total_tokens: 16,
          output_tokens_details: { reasoning_tokens: 6 },
        },
      },
    ],
    ['blank ID', { id: ' ' }],
    ['unsafe model', { model: 'model\nprivate' }],
    ['oversized ID', { id: 'x'.repeat(513) }],
    ['non-completed snapshot', { status: 'in_progress' }],
    ['failed snapshot', { error: { code: 'bad' } }],
    [
      'incomplete details',
      { incomplete_details: { reason: 'max_output_tokens' } },
    ],
    ['empty output', { output: [] }],
    ['tool output', { output: [{ type: 'function_call', arguments: '{}' }] }],
    [
      'duplicate messages',
      {
        output: [
          ...(nativeResponse().output as unknown[]),
          ...(nativeResponse().output as unknown[]),
        ],
      },
    ],
    [
      'refusal output',
      {
        output: [
          {
            id: 'msg',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'refusal', refusal: 'no' }],
          },
        ],
      },
    ],
    [
      'unfinished message',
      {
        output: [
          {
            id: 'msg',
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: [
              { type: 'output_text', text: '{"ok":true}', annotations: [] },
            ],
          },
        ],
      },
    ],
  ])('rejects native %s', async (_label, overrides) => {
    const { provider } = providerFor([terminal(nativeResponse(overrides))]);
    await expect(provider.complete(args)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it.each(['not-json', '{"ok":"yes"}', '{"ok":true,"extra":"unrequested"}'])(
    'rejects invalid or non-closed output %s',
    async (text) => {
      const { provider } = providerFor([
        terminal(
          nativeResponse({
            output: [
              {
                id: 'msg',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text, annotations: [] }],
              },
            ],
          }),
        ),
      ]);
      await expect(provider.complete(args)).rejects.toMatchObject({
        code: 'invalid_response',
      });
    },
  );

  it('does not invent absent cached usage', async () => {
    const { provider } = providerFor([
      terminal(
        nativeResponse({
          usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
        }),
      ),
    ]);
    expect((await provider.complete(args)).usage).toEqual({
      inputTokens: 11,
      outputTokens: 5,
      totalTokens: 16,
    });
  });

  it('retains the original Zod value constraints during local validation', async () => {
    const { provider } = providerFor([
      terminal(
        nativeResponse({
          output: [
            {
              id: 'msg',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                { type: 'output_text', text: '{"text":"x"}', annotations: [] },
              ],
            },
          ],
        }),
      ),
    ]);
    await expect(
      provider.complete({
        ...args,
        schema: z.object({ text: z.string().min(3) }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([
    [
      'event bytes',
      [
        { type: 'response.output_text.delta', delta: 'x'.repeat(1_048_576) },
        terminal(),
      ],
    ],
    [
      'aggregate bytes',
      [
        ...Array.from({ length: 5 }, () => ({
          type: 'response.output_text.delta',
          delta: 'x'.repeat(900_000),
        })),
        terminal(),
      ],
    ],
    [
      'event count',
      [
        ...Array.from({ length: 10_001 }, () => ({
          type: 'response.output_text.delta',
          delta: '',
        })),
        terminal(),
      ],
    ],
  ])('bounds injected stream %s', async (_label, events) => {
    const { provider } = providerFor(events);
    await expect(provider.complete(args)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('sanitizes a transport rejection and never retains its message or cause', async () => {
    const client: OpenAiResponsesClient = {
      accessMode: 'api',
      responses: {
        create: () =>
          Promise.reject(
            new Error('private credential', { cause: 'private source' }),
          ),
      },
    };
    const provider = createOpenAiResponsesProvider({
      client,
      model: 'gpt-explicit',
    });
    await expect(provider.complete(args)).rejects.toMatchObject({
      code: 'transport_failed',
      message: 'openai responses adapter: transport_failed',
    });
  });

  it('rejects a transport error after a completed snapshot', async () => {
    const client: OpenAiResponsesClient = {
      accessMode: 'api',
      responses: {
        create: () =>
          Promise.resolve({
            [Symbol.asyncIterator]: async function* () {
              yield await Promise.resolve(terminal());
              throw new Error('private');
            },
          }),
      },
    };
    await expect(
      createOpenAiResponsesProvider({ client, model: 'gpt-explicit' }).complete(
        args,
      ),
    ).rejects.toMatchObject({ code: 'transport_failed' });
  });

  it('rebuilds typed transport errors without retaining mutated messages or causes', async () => {
    const error = new OpenAiResponsesError('quota_exhausted');
    error.message = 'private credential';
    error.cause = 'private source';
    const client: OpenAiResponsesClient = {
      accessMode: 'subscription',
      responses: {
        create: () => Promise.reject(error),
      },
    };
    const provider = createOpenAiResponsesProvider({
      client,
      model: 'gpt-explicit',
    });
    try {
      await provider.complete(args);
      throw new Error('expected failure');
    } catch (caught) {
      expect(caught).toMatchObject({
        code: 'quota_exhausted',
        message: 'openai responses adapter: quota_exhausted',
      });
      expect(caught).not.toHaveProperty('cause');
    }
  });

  it('preserves validated operational diagnostics without retaining a provider message', async () => {
    const diagnostics = {
      httpStatus: 403,
      bodyShape: 'detail' as const,
      requestId: 'req_safe',
    };
    const error = new OpenAiResponsesError('permission_denied', diagnostics);
    error.message = 'private credential';
    const client: OpenAiResponsesClient = {
      accessMode: 'api',
      responses: {
        create: () => Promise.reject(error),
      },
    };
    const provider = createOpenAiResponsesProvider({
      client,
      model: 'gpt-explicit',
    });
    await expect(provider.complete(args)).rejects.toMatchObject({
      code: 'permission_denied',
      message: 'openai responses adapter: permission_denied',
      diagnostics,
    });
  });

  it('times out a noncooperative stream, aborts and does not wait for blocked cleanup', async () => {
    jest.useFakeTimers();
    const close = jest.fn(
      () => new Promise<IteratorResult<unknown>>(() => undefined),
    );
    let signal: AbortSignal | undefined;
    const client: OpenAiResponsesClient = {
      accessMode: 'subscription',
      responses: {
        create: (_request, options) => {
          signal = options.signal;
          return Promise.resolve({
            [Symbol.asyncIterator]: () => ({
              next: () => new Promise<IteratorResult<unknown>>(() => undefined),
              return: close,
            }),
          });
        },
      },
    };
    const provider = createOpenAiResponsesProvider({
      client,
      model: 'gpt-explicit',
    });
    const pending = provider.complete({ ...args, timeoutMs: 10 });
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'timeout',
    });
    await jest.advanceTimersByTimeAsync(11);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('uses a finite default timeout and closes an iterator arriving after timeout', async () => {
    jest.useFakeTimers();
    let resolveStream: ((stream: AsyncIterable<unknown>) => void) | undefined;
    const close = jest.fn(() =>
      Promise.resolve({
        done: true as const,
        value: undefined,
      }),
    );
    const next = jest.fn(() =>
      Promise.resolve({
        done: false as const,
        value: terminal(),
      }),
    );
    const client: OpenAiResponsesClient = {
      accessMode: 'api',
      responses: {
        create: () =>
          new Promise<AsyncIterable<unknown>>((resolve) => {
            resolveStream = resolve;
          }),
      },
    };
    const pending = createOpenAiResponsesProvider({
      client,
      model: 'gpt-explicit',
    }).complete(args);
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'timeout',
    });
    await jest.advanceTimersByTimeAsync(30_001);
    await assertion;
    resolveStream?.({
      [Symbol.asyncIterator]: () => ({ next, return: close }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('times out after completion when EOF never arrives', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const client: OpenAiResponsesClient = {
      accessMode: 'api',
      responses: {
        create: () =>
          Promise.resolve({
            [Symbol.asyncIterator]: () => ({
              next: () => {
                calls += 1;
                return calls === 1
                  ? Promise.resolve({ done: false as const, value: terminal() })
                  : new Promise<IteratorResult<unknown>>(() => undefined);
              },
            }),
          }),
      },
    };
    const pending = createOpenAiResponsesProvider({
      client,
      model: 'gpt-explicit',
      defaultTimeoutMs: 10,
    }).complete(args);
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'timeout',
    });
    await jest.advanceTimersByTimeAsync(11);
    await assertion;
    expect(calls).toBe(2);
  });

  it('enforces elapsed time when immediate iterator reads starve the timeout callback', async () => {
    let elapsed = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => elapsed);
    let signal: AbortSignal | undefined;
    const close = jest.fn(() =>
      Promise.resolve({ done: true as const, value: undefined }),
    );
    const next = jest.fn(() => {
      // Synchronous work has crossed the deadline; resolving next immediately
      // does not give the timer queue a chance to run.
      elapsed = 25;
      return Promise.resolve({ done: false as const, value: terminal() });
    });
    const client: OpenAiResponsesClient = {
      accessMode: 'api',
      responses: {
        create: (_request, options) => {
          signal = options.signal;
          return Promise.resolve({
            [Symbol.asyncIterator]: () => ({ next, return: close }),
          });
        },
      },
    };
    const provider = createOpenAiResponsesProvider({
      client,
      model: 'gpt-explicit',
    });
    await expect(
      provider.complete({ ...args, timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(signal?.aborted).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('enforces elapsed time after original local schema validation', async () => {
    let elapsed = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => elapsed);
    jest.spyOn(schema, 'safeParse').mockImplementation(() => {
      elapsed = 25;
      return { success: true, data: { ok: true } };
    });
    const { provider, calls } = providerFor([terminal()]);
    await expect(
      provider.complete({ ...args, timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(calls[0]?.signal.aborted).toBe(true);
  });

  it('enforces elapsed time after an immediately resolved transport call', async () => {
    let elapsed = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const close = jest.fn(() =>
      Promise.resolve({ done: true as const, value: undefined }),
    );
    const next = jest.fn(() =>
      Promise.resolve({ done: false as const, value: terminal() }),
    );
    const client: OpenAiResponsesClient = {
      accessMode: 'api',
      responses: {
        create: () => {
          elapsed = 25;
          return Promise.resolve({
            [Symbol.asyncIterator]: () => ({ next, return: close }),
          });
        },
      },
    };
    await expect(
      createOpenAiResponsesProvider({ client, model: 'gpt-explicit' }).complete(
        { ...args, timeoutMs: 10 },
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(next).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['empty model', { model: '' }],
    ['unsafe model', { model: 'bad\nmodel' }],
    ['schema name', { responseSchemaName: 'not valid' }],
    ['default timeout zero', { defaultTimeoutMs: 0 }],
    ['default timeout range', { defaultTimeoutMs: 2_147_483_648 }],
  ])('rejects invalid configuration: %s', (_label, overrides) => {
    const { client } = fakeClient([terminal()]);
    expect(() =>
      createOpenAiResponsesProvider({
        client,
        model: 'gpt-explicit',
        ...overrides,
      }),
    ).toThrow('unsupported_request');
  });
});
