import {
  createOpenAiResponsesFetchClient,
  type OpenAiResponsesFetchConfig,
} from './responses-fetch-client.js';
import {
  OpenAiResponsesError,
  sanitizeOpenAiResponsesError,
  type OpenAiResponsesRequest,
} from './responses-client.js';
import { createOpenAiResponsesProvider } from './responses-provider.js';
import { z } from 'zod';

const request: OpenAiResponsesRequest = {
  model: 'operator-selected-model',
  input: [{ role: 'user', content: 'Return JSON.' }],
  store: false,
  stream: true,
  text: {
    format: {
      type: 'json_schema',
      name: 'output',
      strict: true,
      schema: { type: 'object', additionalProperties: false },
    },
  },
};
const signal = (): AbortSignal => new AbortController().signal;
const encoder = new TextEncoder();

function sse(chunks: ReadonlyArray<string | Uint8Array>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(
            typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
          );
        }
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );
}

async function collect(config: OpenAiResponsesFetchConfig): Promise<unknown[]> {
  const client = createOpenAiResponsesFetchClient(config);
  const events = await client.responses.create(request, { signal: signal() });
  const result: unknown[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

function apiConfig(response: Response): OpenAiResponsesFetchConfig {
  return {
    accessMode: 'api',
    resolveApiKey: () =>
      Promise.resolve({ accessMode: 'api', apiKey: 'unit-token' }),
    fetch: () => Promise.resolve(response),
  };
}

describe('authenticated Responses fetch transport', () => {
  it.each(['abort', 'return'] as const)(
    'cancels an unopened body on %s',
    async (action) => {
      const cancel = jest.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const client = createOpenAiResponsesFetchClient(
        apiConfig(
          new Response(body, {
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
      );
      const controller = new AbortController();
      const stream = await client.responses.create(request, {
        signal: controller.signal,
      });
      const iterator = stream[Symbol.asyncIterator]();
      if (action === 'abort') controller.abort();
      await iterator.return?.();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    },
  );

  it('preserves finite diagnostics through sanitization and drops malicious properties', () => {
    const error = new OpenAiResponsesError('permission_denied', {
      httpStatus: 403,
      bodyShape: 'detail',
      requestId: 'req_safe',
    });
    error.message = 'private-unit-value';
    Object.defineProperty(error, 'cause', {
      value: new Error('private-unit-cause'),
    });
    const sanitized = sanitizeOpenAiResponsesError(error);
    expect(sanitized).toMatchObject({
      code: 'permission_denied',
      message: 'openai responses adapter: permission_denied',
      diagnostics: {
        httpStatus: 403,
        bodyShape: 'detail',
        requestId: 'req_safe',
      },
    });
    expect(sanitized).not.toHaveProperty('cause');
    Object.defineProperty(error, 'code', {
      get() {
        throw new Error('private-unit-getter');
      },
    });
    expect(sanitizeOpenAiResponsesError(error)).toMatchObject({
      code: 'transport_failed',
    });
  });

  it('drops malformed diagnostic fields', () => {
    const error = new OpenAiResponsesError('quota_exhausted', {
      requestId: 'safe',
    });
    Object.defineProperty(error, 'diagnostics', {
      value: {
        requestId: 'Bearer private-unit-value',
        bodyShape: 'error',
        extra: 'private-unit-extra',
      },
    });
    expect(sanitizeOpenAiResponsesError(error).diagnostics).toBeUndefined();
  });

  it('accepts only locally enumerated validation failures, never provider strings or extra fields', () => {
    const error = new OpenAiResponsesError('invalid_response', {
      validationFailure: 'event_type',
    });
    expect(sanitizeOpenAiResponsesError(error).diagnostics).toEqual({
      validationFailure: 'event_type',
    });
    for (const diagnostics of [
      { validationFailure: 'PRIVATE-PROVIDER-EVENT' },
      { validationFailure: 'event_type', event: 'PRIVATE-PROVIDER-EVENT' },
    ]) {
      Object.defineProperty(error, 'diagnostics', {
        value: diagnostics,
        configurable: true,
      });
      expect(sanitizeOpenAiResponsesError(error).diagnostics).toBeUndefined();
      expect(JSON.stringify(sanitizeOpenAiResponsesError(error))).not.toContain(
        'PRIVATE-',
      );
    }
  });

  it.each([
    [
      { detail: 'private-unit-policy' },
      'detail',
      'permission_denied',
      undefined,
    ],
    [
      {
        error: {
          code: 'subscription_sharing_user_not_eligible',
          message: 'private-unit-policy',
        },
      },
      'error',
      'subscription_ineligible',
      'subscription_sharing_user_not_eligible',
    ],
    [
      { arbitrary: 'private-unit-value' },
      'other',
      'permission_denied',
      undefined,
    ],
  ])(
    'preserves sanitized HTTP403 diagnostic shape',
    async (body, bodyShape, code, providerCode) => {
      const response = new Response(JSON.stringify(body), {
        status: 403,
        headers: { 'x-request-id': 'req_safe' },
      });
      const failure = collect(apiConfig(response));
      await expect(failure).rejects.toMatchObject({
        code,
        diagnostics: {
          httpStatus: 403,
          bodyShape,
          requestId: 'req_safe',
          ...(providerCode === undefined ? {} : { providerCode }),
        },
      });
      await expect(failure).rejects.not.toHaveProperty('cause');
    },
  );

  it.each(['api', 'subscription'] as const)(
    'returns validated output, native usage and explicit %s mode over real SSE parsing',
    async (mode) => {
      const completed = {
        type: 'response.completed',
        response: {
          object: 'response',
          id: 'resp-local',
          model: 'selected-model',
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'msg-local',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: '{"answer":"yes"}',
                  annotations: [],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
            input_tokens_details: { cached_tokens: 3 },
          },
        },
      };
      const fetch = jest.fn(() =>
        Promise.resolve(
          sse([`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`]),
        ),
      );
      const client = createOpenAiResponsesFetchClient(
        mode === 'api'
          ? {
              accessMode: mode,
              resolveApiKey: () =>
                Promise.resolve({ accessMode: mode, apiKey: 'unit-api-token' }),
              fetch,
            }
          : {
              accessMode: mode,
              hosting: 'local',
              resolveAccessToken: () =>
                Promise.resolve({
                  accessMode: mode,
                  accessToken: 'unit-sub-token',
                  planUsageAuthorized: true,
                }),
              fetch,
            },
      );
      const provider = createOpenAiResponsesProvider({
        client,
        model: 'selected-model',
      });
      const result = await provider.complete({
        schema: z.object({ answer: z.string() }).strict(),
        messages: [
          { role: 'system', content: 'Reply with JSON.' },
          { role: 'user', content: 'Can this work?' },
        ],
        taskKind: 'analysis',
        requestId: 'local-only-trace',
      });
      expect(result).toMatchObject({
        value: { answer: 'yes' },
        provider: 'openai',
        accessMode: mode,
        status: 'completed',
        responseId: 'resp-local',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          cachedInputTokens: 3,
        },
      });
      expect(result.usage).not.toHaveProperty('costInUsdTicks');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('uses global fetch only when explicitly constructing the transport', async () => {
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(sse(['data: {}\n\n']));
    try {
      await expect(
        collect({
          accessMode: 'api',
          resolveApiKey: () =>
            Promise.resolve({ accessMode: 'api', apiKey: 'unit-token' }),
        }),
      ).resolves.toEqual([{}]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    {
      accessMode: 'unexpected',
      resolveApiKey: () =>
        Promise.resolve({ accessMode: 'api', apiKey: 'unit-token' }),
    },
    {
      accessMode: 'subscription',
      hosting: 'shared',
      resolveAccessToken: () =>
        Promise.resolve({
          accessMode: 'subscription',
          accessToken: 'unit-token',
          planUsageAuthorized: true,
        }),
    },
    { accessMode: 'api', resolveApiKey: null },
    {
      accessMode: 'api',
      resolveApiKey: () =>
        Promise.resolve({ accessMode: 'api', apiKey: 'unit-token' }),
      fetch: false,
    },
  ])('rejects malformed runtime construction', (config) => {
    expect(() =>
      createOpenAiResponsesFetchClient(
        config as unknown as OpenAiResponsesFetchConfig,
      ),
    ).toThrow();
  });

  it('rejects event bounds greater than the stream bound', () => {
    expect(() =>
      createOpenAiResponsesFetchClient({
        ...apiConfig(sse([])),
        maxEventBytes: 64,
        maxStreamBytes: 32,
      }),
    ).toThrow();
  });

  it('sanitizes reader failure and cancellation failure', async () => {
    const cancel = jest.fn(() =>
      Promise.reject(new Error('private-unit-cancel')),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: invalid\n\n'));
      },
      cancel,
    });
    await expect(
      collect(
        apiConfig(
          new Response(body, {
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    const errored = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('private-unit-stream'));
      },
    });
    await expect(
      collect(apiConfig(new Response(errored, { status: 500 }))),
    ).rejects.toMatchObject({ code: 'transport_failed' });
  });

  it.each(['api', 'subscription'] as const)(
    'uses explicit %s auth and fixed endpoint',
    async (mode) => {
      const fetch = jest.fn(() =>
        Promise.resolve(sse(['data: {"type":"response.created"}\n\n'])),
      );
      const client = createOpenAiResponsesFetchClient(
        mode === 'api'
          ? {
              accessMode: mode,
              resolveApiKey: () =>
                Promise.resolve({ accessMode: mode, apiKey: 'unit-api-token' }),
              fetch,
            }
          : {
              accessMode: mode,
              hosting: 'local',
              resolveAccessToken: () =>
                Promise.resolve({
                  accessMode: mode,
                  accessToken: 'unit-sub-token',
                  planUsageAuthorized: true,
                }),
              fetch,
            },
      );
      expect(client.accessMode).toBe(mode);
      const events = await client.responses.create(request, {
        signal: signal(),
      });
      for await (const event of events) {
        expect(event).toEqual({ type: 'response.created' });
      }
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/responses',
        expect.objectContaining({
          method: 'POST',
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          headers: expect.objectContaining({
            Authorization:
              mode === 'api'
                ? 'Bearer unit-api-token'
                : 'Bearer unit-sub-token',
          }),
          body: JSON.stringify(request),
        }),
      );
    },
  );

  it('resolves refreshed credentials separately for every call', async () => {
    const resolveApiKey = jest
      .fn()
      .mockResolvedValueOnce({ accessMode: 'api', apiKey: 'unit-one' })
      .mockResolvedValueOnce({ accessMode: 'api', apiKey: 'unit-two' });
    const fetch = jest.fn(() => Promise.resolve(sse(['data: {}\n\n'])));
    const client = createOpenAiResponsesFetchClient({
      accessMode: 'api',
      resolveApiKey,
      fetch,
    });
    for (let index = 0; index < 2; index++) {
      for await (const event of await client.responses.create(request, {
        signal: signal(),
      })) {
        expect(event).toEqual({});
      }
    }
    expect(resolveApiKey).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer unit-two' }),
      }),
    );
  });

  it('rejects a subscription cap before resolving credentials', async () => {
    const resolveAccessToken = jest.fn();
    const fetch = jest.fn();
    const client = createOpenAiResponsesFetchClient({
      accessMode: 'subscription',
      hosting: 'self-hosted',
      resolveAccessToken,
      fetch,
    });
    await expect(
      client.responses.create(
        { ...request, max_output_tokens: 40 },
        { signal: signal() },
      ),
    ).rejects.toMatchObject({ code: 'unsupported_request' });
    expect(resolveAccessToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'user',
    'metadata',
    'previous_response_id',
    'background',
    'tools',
    'temperature',
  ])('rejects unsupported direct field %s before auth', async (field) => {
    const resolveApiKey = jest.fn();
    const client = createOpenAiResponsesFetchClient({
      accessMode: 'api',
      resolveApiKey,
    });
    await expect(
      client.responses.create(
        { ...request, [field]: 'unexpected' },
        { signal: signal() },
      ),
    ).rejects.toMatchObject({ code: 'unsupported_request' });
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it.each([
    { accessMode: 'api', apiKey: '' },
    { accessMode: 'api', apiKey: 'unit-token\r\nInjected: header' },
    { accessMode: 'api', apiKey: 'unit token' },
    {
      accessMode: 'subscription',
      accessToken: 'unit-token',
      planUsageAuthorized: true,
    },
  ])(
    'rejects invalid or wrong-mode API credentials without fetch',
    async (credential) => {
      const fetch = jest.fn();
      const resolveApiKey = jest.fn().mockResolvedValue(credential);
      const client = createOpenAiResponsesFetchClient({
        accessMode: 'api',
        resolveApiKey,
        fetch,
      });
      await expect(
        client.responses.create(request, { signal: signal() }),
      ).rejects.toMatchObject({ code: 'authentication_failed' });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('requires caller-verified subscription permission', async () => {
    const fetch = jest.fn();
    const resolveAccessToken = jest.fn().mockResolvedValue({
      accessMode: 'subscription',
      accessToken: 'unit-token',
      planUsageAuthorized: false,
    });
    const client = createOpenAiResponsesFetchClient({
      accessMode: 'subscription',
      hosting: 'local',
      resolveAccessToken,
      fetch,
    });
    await expect(
      client.responses.create(request, { signal: signal() }),
    ).rejects.toMatchObject({ code: 'authentication_failed' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sanitizes credential and fetch failures without retry', async () => {
    const fetch = jest
      .fn()
      .mockRejectedValue(new Error('Bearer private-unit-value'));
    const client = createOpenAiResponsesFetchClient({
      ...apiConfig(sse([])),
      fetch,
    });
    const failure = client.responses.create(request, { signal: signal() });
    await expect(failure).rejects.toMatchObject({
      code: 'transport_failed',
      message: 'openai responses adapter: transport_failed',
    });
    await expect(failure).rejects.not.toHaveProperty('cause');
    expect(fetch).toHaveBeenCalledTimes(1);
    const resolveApiKey = jest
      .fn()
      .mockRejectedValue(new Error('private-unit-value'));
    await expect(
      createOpenAiResponsesFetchClient({
        accessMode: 'api',
        resolveApiKey,
      }).responses.create(request, { signal: signal() }),
    ).rejects.toMatchObject({ code: 'authentication_failed' });
  });

  it.each([
    [429, 'subscription_sharing_usage_limit_exceeded', 'quota_exhausted'],
    [503, 'subscription_sharing_usage_unavailable', 'subscription_unavailable'],
    [429, 'subscription_sharing_usage_unavailable', 'rate_limited'],
    [503, 'subscription_sharing_usage_limit_exceeded', 'transport_failed'],
    [429, 'rate_limit_exceeded', 'rate_limited'],
    [401, 'anything', 'authentication_failed'],
    [403, 'anything', 'permission_denied'],
    [403, 'subscription_sharing_user_not_eligible', 'subscription_ineligible'],
    [500, 'anything', 'transport_failed'],
  ])('maps structured HTTP %s / %s to %s', async (status, code, expected) => {
    const response = new Response(
      JSON.stringify({ error: { code, message: 'private-unit-value' } }),
      { status: status as number },
    );
    await expect(collect(apiConfig(response))).rejects.toMatchObject({
      code: expected,
    });
  });

  it.each(['not JSON', 'x'.repeat(8193)])(
    'bounds and sanitizes HTTP error bodies',
    async (body) => {
      await expect(
        collect(apiConfig(new Response(body, { status: 429 }))),
      ).rejects.toMatchObject({ code: 'rate_limited' });
    },
  );

  it('rejects wrong MIME on an otherwise successful response', async () => {
    await expect(
      collect(
        apiConfig(
          new Response('{}', {
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'invalid_response',
      diagnostics: {
        validationFailure: 'response_content_type',
        httpStatus: 200,
        contentTypeCategory: 'json',
      },
    });
  });

  it('distinguishes an absent body from an unexpected content type', async () => {
    await expect(collect(apiConfig(new Response(null)))).rejects.toMatchObject({
      code: 'invalid_response',
      diagnostics: {
        validationFailure: 'response_body',
        httpStatus: 200,
        contentTypeCategory: 'missing',
      },
    });
  });

  it.each([
    [undefined, 'missing', 200],
    ['', 'missing', 200],
    [' ; PRIVATE-PARAMETER', 'missing', 200],
    ['APPLICATION/JSON; PRIVATE-PARAMETER', 'json', 201],
    ['application/problem+json', 'json', 202],
    ['application/vnd.PRIVATE-VENDOR+json', 'json', 206],
    ['text/html; PRIVATE-PARAMETER', 'html', 200],
    ['application/xhtml+xml', 'html', 200],
    ['text/plain; PRIVATE-PARAMETER', 'text', 200],
    ['text/PRIVATE-SUBTYPE', 'text', 200],
    ['application/octet-stream', 'other', 200],
    ['PRIVATE-MIME', 'other', 200],
    ['application/invalid type+json', 'other', 200],
    ['text/invalid type', 'other', 200],
    [`application/${'x'.repeat(257)}+json`, 'other', 200],
    ['text/event-stream,application/json', 'other', 200],
  ])(
    'classifies rejected header %s without pulling its body',
    async (contentType, contentTypeCategory, status) => {
      const pull = jest.fn();
      const cancel = jest.fn();
      const body = new ReadableStream<Uint8Array>(
        { pull, cancel },
        { highWaterMark: 0 },
      );
      const response = new Response(body, {
        status: status as number,
        headers:
          contentType === undefined
            ? {}
            : { 'content-type': contentType as string },
      });
      const fetch = jest.fn(() => Promise.resolve(response));
      try {
        await collect({ ...apiConfig(response), fetch });
        throw new Error('expected header rejection');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'invalid_response',
          diagnostics: {
            validationFailure: 'response_content_type',
            httpStatus: status,
            contentTypeCategory,
          },
        });
        expect(JSON.stringify(error)).not.toMatch(/PRIVATE-|PARAMETER|VENDOR/);
      }
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    },
  );

  it.each([
    [undefined, 'missing', 204],
    ['text/event-stream; PRIVATE-PARAMETER', 'event_stream', 205],
    ['application/json', 'json', 200],
  ])(
    'keeps absent-body precedence for header %s',
    async (header, category, status) => {
      const response = new Response(null, {
        status: status as number,
        headers:
          header === undefined ? {} : { 'content-type': header as string },
      });
      await expect(collect(apiConfig(response))).rejects.toMatchObject({
        code: 'invalid_response',
        diagnostics: {
          validationFailure: 'response_body',
          httpStatus: status,
          contentTypeCategory: category,
        },
      });
    },
  );

  it('retains header diagnostics when rejected-body cancellation fails', async () => {
    const pull = jest.fn();
    const cancel = jest.fn(() => Promise.reject(new Error('PRIVATE-CANCEL')));
    const body = new ReadableStream<Uint8Array>(
      { pull, cancel },
      { highWaterMark: 0 },
    );
    await expect(collect(apiConfig(new Response(body)))).rejects.toMatchObject({
      code: 'invalid_response',
      diagnostics: {
        validationFailure: 'response_content_type',
        httpStatus: 200,
        contentTypeCategory: 'missing',
      },
    });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ' Text/Event-Stream ; charset=utf-8',
    'TEXT/EVENT-STREAM',
    'text/event-stream',
  ])(
    'continues consuming valid normalized SSE headers (%s)',
    async (header) => {
      const response = sse(['data: {"ok":true}\n\n']);
      response.headers.set('content-type', header);
      await expect(collect(apiConfig(response))).resolves.toEqual([
        { ok: true },
      ]);
    },
  );

  it.each(['PRIVATE-MIME', 'JSON', { type: 'PRIVATE-TYPE' }])(
    'drops an injected nonfinite content-type category (%s)',
    (contentTypeCategory) => {
      const error = new OpenAiResponsesError('invalid_response');
      Object.defineProperty(error, 'diagnostics', {
        value: { httpStatus: 201, contentTypeCategory },
      });
      const sanitized = sanitizeOpenAiResponsesError(error);
      expect(sanitized.code).toBe('invalid_response');
      expect(sanitized.diagnostics).toBeUndefined();
      expect(JSON.stringify(sanitized)).not.toMatch(/PRIVATE-|JSON|TYPE/);
    },
  );

  it('parses split UTF-8, comments, CRLF and multiline data', async () => {
    const bytes = encoder.encode(
      ': keepalive\r\nevent: output\r\ndata: {"value":\r\ndata: "café"}\r\n\r\ndata: [DONE]\r\n\r\n',
    );
    const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
    await expect(collect(apiConfig(sse(chunks)))).resolves.toEqual([
      { value: 'café' },
    ]);
  });

  it('supports lone CR frame delimiters', async () => {
    await expect(collect(apiConfig(sse(['data: {}\r\r'])))).resolves.toEqual([
      {},
    ]);
  });

  it.each([
    ['data: not-json\n\n', 'event_json'],
    ['data: {"unfinished":true}', 'stream_framing'],
    ['data: {}\n', 'stream_framing'],
    ['data: [DONE]\n\ndata: {}\n\n', 'stream_after_done'],
    ['data: [DONE]\n\ndata: [DONE]\n\n', 'stream_after_done'],
  ])(
    'rejects malformed or unfinished framing (%s)',
    async (body, validationFailure) => {
      await expect(collect(apiConfig(sse([body])))).rejects.toMatchObject({
        code: 'invalid_response',
        diagnostics: { validationFailure },
      });
    },
  );

  it('rejects invalid UTF-8', async () => {
    await expect(
      collect(apiConfig(sse([new Uint8Array([0xc3, 0x28])]))),
    ).rejects.toMatchObject({
      code: 'transport_failed',
      diagnostics: { validationFailure: 'stream_utf8' },
    });
  });

  it.each(['event', 'stream'] as const)('bounds the %s bytes', async (kind) => {
    const body =
      kind === 'event' ? 'data: ' + 'x'.repeat(40) : 'data: {}\n\n'.repeat(10);
    const config = {
      ...apiConfig(sse([body])),
      maxEventBytes: 32,
      maxStreamBytes: kind === 'event' ? 128 : 64,
    };
    await expect(collect(config)).rejects.toMatchObject({
      code: 'invalid_response',
      diagnostics: {
        validationFailure: kind === 'event' ? 'event_size' : 'stream_size',
      },
    });
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, 33_554_433])(
    'rejects invalid buffer bound %s',
    (maxEventBytes) => {
      expect(() =>
        createOpenAiResponsesFetchClient({
          ...apiConfig(sse([])),
          maxEventBytes,
        }),
      ).toThrow();
    },
  );

  it('cancels an open reader on abort and rejects the stream', async () => {
    const cancelled = jest.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const client = createOpenAiResponsesFetchClient(
      apiConfig(
        new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );
    const controller = new AbortController();
    const stream = await client.responses.create(request, {
      signal: controller.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'transport_failed' });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('does not fetch after a non-cooperative credential resolver returns late', async () => {
    let release:
      | ((value: { accessMode: 'api'; apiKey: string }) => void)
      | undefined;
    const resolveApiKey = () =>
      new Promise<{ accessMode: 'api'; apiKey: string }>((resolve) => {
        release = resolve;
      });
    const fetch = jest.fn();
    const client = createOpenAiResponsesFetchClient({
      accessMode: 'api',
      resolveApiKey,
      fetch,
    });
    const controller = new AbortController();
    const pending = client.responses.create(request, {
      signal: controller.signal,
    });
    controller.abort();
    release?.({ accessMode: 'api', apiKey: 'unit-token' });
    await expect(pending).rejects.toMatchObject({
      code: 'authentication_failed',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
