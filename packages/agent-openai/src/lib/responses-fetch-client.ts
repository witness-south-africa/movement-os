import { z } from 'zod';
import {
  OpenAiResponsesError,
  openAiInvalidResponse,
  openAiResponsesFailure,
  OpenAiSubscriptionErrorCodeSchema,
  type OpenAiResponsesDiagnostics,
  type OpenAiResponsesClient,
  type OpenAiResponsesRequest,
} from './responses-client.js';

type FetchTransport = (
  url: string,
  init: RequestInit & { readonly cache: 'no-store' },
) => Promise<Response>;

export interface OpenAiApiCredential {
  readonly accessMode: 'api';
  readonly apiKey: string;
}

export interface OpenAiSubscriptionCredential {
  readonly accessMode: 'subscription';
  readonly accessToken: string;
  /** Caller verified the selected account's identity and plan-use permission. */
  readonly planUsageAuthorized: true;
}

/** Resolve the selected account's validated, current credential per call. */
export type OpenAiResponsesFetchConfig = (
  | {
      readonly accessMode: 'api';
      readonly resolveApiKey: () => Promise<OpenAiApiCredential>;
    }
  | {
      readonly accessMode: 'subscription';
      /** This source implements the official local/self-hosted OSS route only. */
      readonly hosting: 'local' | 'self-hosted';
      readonly resolveAccessToken: () => Promise<OpenAiSubscriptionCredential>;
    }
) & {
  readonly fetch?: FetchTransport;
  /** Local memory/wire bounds, not provider output-token or spend ceilings. */
  readonly maxEventBytes?: number;
  readonly maxStreamBytes?: number;
};

const ENDPOINT = 'https://api.openai.com/v1/responses';
const positiveCounter = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const RequestSchema = z
  .object({
    model: z.string().min(1).max(256),
    input: z
      .array(
        z
          .object({
            role: z.enum(['developer', 'user', 'assistant']),
            content: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    store: z.literal(false),
    stream: z.literal(true),
    text: z
      .object({
        format: z
          .object({
            type: z.literal('json_schema'),
            name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
            strict: z.literal(true),
            schema: z.record(z.unknown()),
          })
          .strict(),
      })
      .strict(),
    max_output_tokens: positiveCounter.optional(),
  })
  .strict();

/** Fixed endpoint, zero retries, no environment or credential-store access. */
export function createOpenAiResponsesFetchClient(
  config: OpenAiResponsesFetchConfig,
): OpenAiResponsesClient {
  if (
    !z.enum(['api', 'subscription']).safeParse(config.accessMode).success ||
    (config.accessMode === 'subscription' &&
      !z.enum(['local', 'self-hosted']).safeParse(config.hosting).success)
  ) {
    throw new OpenAiResponsesError('unsupported_request');
  }
  const accessMode = config.accessMode;
  const resolveCredential =
    config.accessMode === 'api'
      ? config.resolveApiKey
      : config.resolveAccessToken;
  const fetchTransport = config.fetch ?? globalThis.fetch;
  if (
    typeof resolveCredential !== 'function' ||
    typeof fetchTransport !== 'function'
  ) {
    throw new OpenAiResponsesError('unsupported_request');
  }
  const maxEventBytes = bound(config.maxEventBytes, 1_048_576);
  const maxStreamBytes = bound(config.maxStreamBytes, 8_388_608);
  if (maxEventBytes > maxStreamBytes) {
    throw new OpenAiResponsesError('unsupported_request');
  }
  return Object.freeze({
    accessMode,
    responses: Object.freeze({
      async create(
        request: OpenAiResponsesRequest,
        options: { readonly signal: AbortSignal },
      ): Promise<AsyncIterable<unknown>> {
        const parsed = RequestSchema.safeParse(request);
        if (
          !parsed.success ||
          (accessMode === 'subscription' &&
            request.max_output_tokens !== undefined)
        ) {
          throw new OpenAiResponsesError('unsupported_request');
        }
        let body: string;
        try {
          body = JSON.stringify(parsed.data);
        } catch {
          throw new OpenAiResponsesError('unsupported_request');
        }
        let credential: string;
        try {
          options.signal.throwIfAborted();
          const resolved: unknown = await resolveCredential();
          options.signal.throwIfAborted();
          const parsedCredential = (
            accessMode === 'api'
              ? z.object({ accessMode: z.literal('api'), apiKey: z.string() })
              : z.object({
                  accessMode: z.literal('subscription'),
                  accessToken: z.string(),
                  planUsageAuthorized: z.literal(true),
                })
          ).safeParse(resolved);
          if (!parsedCredential.success) {
            throw new Error();
          }
          credential =
            'apiKey' in parsedCredential.data
              ? parsedCredential.data.apiKey
              : parsedCredential.data.accessToken;
          if (
            credential.length > 16_384 ||
            !/^[A-Za-z0-9._~+/-]+=*$/.test(credential)
          ) {
            throw new Error();
          }
        } catch {
          throw new OpenAiResponsesError('authentication_failed');
        }
        let response: Response;
        try {
          response = await fetchTransport(ENDPOINT, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${credential}`,
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
            },
            body,
            signal: options.signal,
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
          });
        } catch {
          throw new OpenAiResponsesError('transport_failed');
        }
        if (options.signal.aborted) {
          void response.body?.cancel().catch(ignoreCancellationFailure);
          throw new OpenAiResponsesError('transport_failed');
        }
        if (!response.ok) {
          throw await httpFailure(response, options.signal);
        }
        if (
          response.body === null ||
          response.headers
            .get('content-type')
            ?.split(';')[0]
            ?.trim()
            .toLowerCase() !== 'text/event-stream'
        ) {
          void response.body?.cancel().catch(ignoreCancellationFailure);
          throw openAiInvalidResponse(
            response.body === null ? 'response_body' : 'response_content_type',
          );
        }
        return readEvents(
          response.body,
          options.signal,
          maxEventBytes,
          maxStreamBytes,
        );
      },
    }),
  });
}

function bound(value: number | undefined, fallback: number): number {
  const parsed = positiveCounter.max(33_554_432).safeParse(value ?? fallback);
  if (!parsed.success) {
    throw new OpenAiResponsesError('unsupported_request');
  }
  return parsed.data;
}

async function httpFailure(
  response: Response,
  signal: AbortSignal,
): Promise<OpenAiResponsesError> {
  const requestId = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .safeParse(response.headers.get('x-request-id'));
  const base: OpenAiResponsesDiagnostics = {
    httpStatus: response.status,
    ...(requestId.success ? { requestId: requestId.data } : {}),
  };
  const fallbackCode =
    response.status === 401
      ? 'authentication_failed'
      : response.status === 403
        ? 'permission_denied'
        : response.status === 429
          ? 'rate_limited'
          : 'transport_failed';
  const fallback = new OpenAiResponsesError(fallbackCode, {
    ...base,
    bodyShape: 'unreadable',
  });
  if (response.body === null) {
    return fallback;
  }
  const errorBody: ReadableStream<Uint8Array> = response.body;
  const reader = errorBody.getReader();
  const abort = (): void => {
    void reader.cancel().catch(ignoreCancellationFailure);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8192) return fallback;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const body: unknown = JSON.parse(text);
    const parsed = z
      .object({ error: z.object({ code: z.unknown().optional() }) })
      .safeParse(body);
    const detail = z.record(z.unknown()).safeParse(body);
    const providerCode = OpenAiSubscriptionErrorCodeSchema.safeParse(
      parsed.success ? parsed.data.error.code : undefined,
    );
    const diagnostics: OpenAiResponsesDiagnostics = {
      ...base,
      bodyShape: parsed.success
        ? 'error'
        : detail.success && Object.hasOwn(detail.data, 'detail')
          ? 'detail'
          : 'other',
      ...(providerCode.success ? { providerCode: providerCode.data } : {}),
    };
    if (
      providerCode.success &&
      ((response.status === 429 &&
        providerCode.data === 'subscription_sharing_usage_limit_exceeded') ||
        (response.status === 503 &&
          providerCode.data === 'subscription_sharing_usage_unavailable') ||
        (response.status === 403 &&
          providerCode.data === 'subscription_sharing_user_not_eligible'))
    ) {
      return new OpenAiResponsesError(
        openAiResponsesFailure(providerCode.data).code,
        diagnostics,
      );
    }
    return new OpenAiResponsesError(fallbackCode, diagnostics);
  } catch {
    return fallback;
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(ignoreCancellationFailure);
    reader.releaseLock();
  }
}

/** Own the reader eagerly: abort/return must also close an unstarted stream. */
function readEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxEventBytes: number,
  maxStreamBytes: number,
): AsyncIterable<unknown> {
  const reader = body.getReader();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', close);
    void reader.cancel().catch(ignoreCancellationFailure);
    reader.releaseLock();
  };
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();
  const generator = parseEvents(
    reader,
    signal,
    maxEventBytes,
    maxStreamBytes,
    close,
  );
  const done: IteratorResult<unknown> = { done: true, value: undefined };
  const iterator: AsyncIterator<unknown> = {
    next: () => {
      if (signal.aborted)
        return Promise.reject(new OpenAiResponsesError('transport_failed'));
      return closed ? Promise.resolve(done) : generator.next();
    },
    return: () => {
      close();
      void generator.return(undefined).catch(ignoreCancellationFailure);
      return Promise.resolve(done);
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

async function* parseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  maxEventBytes: number,
  maxStreamBytes: number,
  close: () => void,
): AsyncGenerator {
  try {
    signal.throwIfAborted();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const encoder = new TextEncoder();
    const decode = (bytes?: Uint8Array): string => {
      try {
        return decoder.decode(bytes, { stream: bytes !== undefined });
      } catch {
        throw new OpenAiResponsesError('transport_failed', {
          validationFailure: 'stream_utf8',
        });
      }
    };
    let pending = '';
    let data: string[] = [];
    let eventBytes = 0;
    let totalBytes = 0;
    let doneMarker = false;
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        pending += decode();
      } else {
        totalBytes += chunk.value.byteLength;
        if (totalBytes > maxStreamBytes) {
          throw openAiInvalidResponse('stream_size');
        }
        pending += decode(chunk.value);
      }
      for (;;) {
        const separator = pending.search(/[\r\n]/);
        if (separator < 0) {
          break;
        }
        // A CR at a chunk boundary may be the start of CRLF.
        if (
          pending[separator] === '\r' &&
          separator === pending.length - 1 &&
          !chunk.done
        ) {
          break;
        }
        const line = pending.slice(0, separator);
        const width =
          pending.slice(separator, separator + 2) === '\r\n' ? 2 : 1;
        pending = pending.slice(separator + width);
        eventBytes += encoder.encode(line).byteLength + width;
        if (eventBytes > maxEventBytes) {
          throw openAiInvalidResponse('event_size');
        }
        if (line === '') {
          if (data.length > 0) {
            const eventData = data.join('\n');
            if (doneMarker) {
              throw openAiInvalidResponse('stream_after_done');
            }
            if (eventData === '[DONE]') {
              doneMarker = true;
            } else {
              let event: unknown;
              try {
                event = JSON.parse(eventData) as unknown;
              } catch {
                throw openAiInvalidResponse('event_json');
              }
              yield event;
            }
          }
          data = [];
          eventBytes = 0;
        } else if (line === 'data' || line.startsWith('data:')) {
          const value = line === 'data' ? '' : line.slice(5);
          data.push(value.startsWith(' ') ? value.slice(1) : value);
        }
      }
      if (eventBytes + encoder.encode(pending).byteLength > maxEventBytes) {
        throw openAiInvalidResponse('event_size');
      }
      if (chunk.done) {
        if (pending !== '' || data.length !== 0) {
          throw openAiInvalidResponse('stream_framing');
        }
        return;
      }
    }
  } catch (error) {
    if (error instanceof OpenAiResponsesError) {
      throw error;
    }
    throw new OpenAiResponsesError('transport_failed');
  } finally {
    close();
  }
}

function ignoreCancellationFailure(): void {
  // A cancellation failure must not replace or expose the original error.
}
