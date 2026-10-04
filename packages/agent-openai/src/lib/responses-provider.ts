import {
  AgentMessageSchema,
  AgentTaskKindSchema,
  type CompleteArgs,
  type ModelProvider,
  type ModelResponse,
  type TokenUsage,
} from '@wsa/agent-contracts';
import { z } from 'zod';
import {
  OpenAiResponsesError,
  openAiInvalidResponse,
  openAiResponsesFailure,
  sanitizeOpenAiResponsesError,
  type OpenAiAccessMode,
  type OpenAiResponsesClient,
  type OpenAiResponsesRequest,
  type OpenAiResponsesValidationFailure,
} from './responses-client.js';
import { zodToOpenAiResponsesJsonSchema } from './responses-json-schema.js';

export interface OpenAiResponsesProviderConfig {
  readonly client: OpenAiResponsesClient;
  readonly model: string;
  readonly responseSchemaName?: string;
  /** Positive timer-range ceiling; default 30 seconds. */
  readonly defaultTimeoutMs?: number;
}

export interface OpenAiResponsesProvider extends ModelProvider {
  readonly accessMode: OpenAiAccessMode;
}

const MAX_EVENT_BYTES = 1_048_576;
const MAX_STREAM_BYTES = 4_194_304;
const MAX_EVENTS = 10_000;
const safeCounter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const safeMetadata = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        value.trim().length > 0 &&
        !Array.from(value).some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    );
const AssistantSchema = z.object({
  type: z.literal('message'),
  id: safeMetadata(512),
  role: z.literal('assistant'),
  status: z.literal('completed'),
  content: z
    .array(
      z.object({
        type: z.literal('output_text'),
        text: z.string().min(1),
        annotations: z.array(z.unknown()).max(256),
      }),
    )
    .length(1),
});
const ReasoningSchema = z.object({
  type: z.literal('reasoning'),
  id: safeMetadata(512),
  summary: z
    .array(z.object({ type: z.literal('summary_text'), text: z.string() }))
    .max(256),
  status: z.literal('completed').optional(),
});
const CompletedSchema = z.object({
  id: safeMetadata(512),
  object: z.literal('response'),
  model: safeMetadata(256),
  status: z.literal('completed'),
  error: z.null().optional(),
  incomplete_details: z.null().optional(),
  output: z
    .array(z.union([AssistantSchema, ReasoningSchema]))
    .min(1)
    .max(64),
  usage: z.object({
    input_tokens: safeCounter,
    output_tokens: safeCounter,
    total_tokens: safeCounter,
    input_tokens_details: z.object({ cached_tokens: safeCounter }).optional(),
    output_tokens_details: z
      .object({ reasoning_tokens: safeCounter })
      .optional(),
  }),
});
const INTERMEDIATE_TYPES = new Set([
  'response.created',
  'response.in_progress',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
]);

/** A bounded streaming Responses adapter. Authentication belongs to its transport. */
export function createOpenAiResponsesProvider(
  config: OpenAiResponsesProviderConfig,
): OpenAiResponsesProvider {
  const model = safeMetadata(256).safeParse(config.model);
  const name = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .safeParse(config.responseSchemaName ?? 'output');
  const client = config.client;
  const validClient = z
    .object({
      accessMode: z.enum(['api', 'subscription']),
      responses: z.object({ create: z.function() }),
    })
    .safeParse(client);
  if (!model.success || !name.success || !validClient.success) {
    throw new OpenAiResponsesError('unsupported_request');
  }
  const accessMode = validClient.data.accessMode;
  const defaultTimeoutMs = configuredDuration(config.defaultTimeoutMs, 30_000);
  return Object.freeze({
    id: 'openai',
    accessMode,
    complete: async <TSchema extends z.ZodType>(
      args: CompleteArgs<TSchema>,
    ): Promise<ModelResponse<z.infer<TSchema>>> => {
      const request = buildRequest(args, model.data, name.data, accessMode);
      const timeoutMs = configuredDuration(args.timeoutMs, defaultTimeoutMs);
      const controller = new AbortController();
      const startedAt = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let iterator: AsyncIterator<unknown> | undefined;
      let iteratorClosed = false;
      const close = () => {
        if (iterator !== undefined && !iteratorClosed) {
          iteratorClosed = true;
          closeIterator(iterator);
        }
      };
      const checkDeadline = () => {
        if (
          controller.signal.aborted ||
          performance.now() - startedAt >= timeoutMs
        ) {
          controller.abort();
          close();
          throw new OpenAiResponsesError('timeout');
        }
      };
      const execute = async (): Promise<ModelResponse<z.infer<TSchema>>> => {
        let finished = false;
        try {
          checkDeadline();
          const stream: unknown = await client.responses.create(request, {
            signal: controller.signal,
          });
          if (!isAsyncIterable(stream)) {
            checkDeadline();
            throw openAiInvalidResponse('stream_interface');
          }
          iterator = stream[Symbol.asyncIterator]();
          checkDeadline();
          const response = await consume(iterator, checkDeadline);
          finished = true;
          checkDeadline();
          let json: unknown;
          try {
            json = JSON.parse(response.text);
          } catch {
            checkDeadline();
            throw openAiInvalidResponse('output_json');
          }
          checkDeadline();
          const validated = args.schema.safeParse(json);
          checkDeadline();
          if (!validated.success) throw openAiInvalidResponse('output_schema');
          if (!sameJsonValue(json, validated.data))
            throw openAiInvalidResponse('output_extra_fields');
          checkDeadline();
          return {
            value: validated.data as z.infer<TSchema>,
            provider: 'openai',
            accessMode,
            model: response.model,
            responseId: response.id,
            status: 'completed',
            rawFinishReason: 'completed',
            usage: response.usage,
          };
        } catch (error: unknown) {
          checkDeadline();
          throw sanitizeOpenAiResponsesError(error);
        } finally {
          if (!finished) {
            close();
          }
        }
      };
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new OpenAiResponsesError('timeout'));
            controller.abort();
            close();
          }, timeoutMs);
        });
        const pending = execute();
        return await Promise.race([pending, timeout]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  });
}

function buildRequest<TSchema extends z.ZodType>(
  args: CompleteArgs<TSchema>,
  model: string,
  name: string,
  accessMode: OpenAiAccessMode,
): OpenAiResponsesRequest {
  if (
    !AgentTaskKindSchema.safeParse(args.taskKind).success ||
    (args.tools !== undefined &&
      (!Array.isArray(args.tools) || args.tools.length !== 0)) ||
    (accessMode === 'subscription' && args.maxOutputTokens !== undefined)
  ) {
    throw new OpenAiResponsesError('unsupported_request');
  }
  const messages = z
    .array(AgentMessageSchema)
    .min(1)
    .max(128)
    .safeParse(args.messages);
  if (
    !messages.success ||
    !messages.data.some((message) => message.role === 'user') ||
    messages.data.at(-1)?.role !== 'user'
  ) {
    throw new OpenAiResponsesError('unsupported_request');
  }
  const input: OpenAiResponsesRequest['input'] = messages.data.map(
    (message) => ({
      role: message.role === 'system' ? 'developer' : message.role,
      content: message.content,
    }),
  );
  if (
    input.some(
      (message) => Buffer.byteLength(message.content, 'utf8') > MAX_EVENT_BYTES,
    ) ||
    input.reduce(
      (total, message) => total + Buffer.byteLength(message.content, 'utf8'),
      0,
    ) > MAX_STREAM_BYTES
  ) {
    throw new OpenAiResponsesError('unsupported_request');
  }
  return {
    model,
    input,
    store: false,
    stream: true,
    text: {
      format: {
        type: 'json_schema',
        name,
        strict: true,
        schema: zodToOpenAiResponsesJsonSchema(args.schema),
      },
    },
    ...(args.maxOutputTokens === undefined
      ? {}
      : {
          max_output_tokens: positiveInteger(args.maxOutputTokens),
        }),
  };
}

interface CertifiedResponse {
  readonly id: string;
  readonly model: string;
  readonly text: string;
  readonly usage: TokenUsage;
}

async function consume(
  iterator: AsyncIterator<unknown>,
  checkDeadline: () => void,
): Promise<CertifiedResponse> {
  let completed: CertifiedResponse | undefined;
  let responseId: string | undefined;
  let eventCount = 0;
  let streamBytes = 0;
  for (;;) {
    checkDeadline();
    const step = await iterator.next();
    checkDeadline();
    if (step.done === true) {
      if (completed === undefined) {
        throw openAiInvalidResponse('completion_missing');
      }
      return completed;
    }
    eventCount += 1;
    const event: unknown = step.value;
    let bytes: number;
    try {
      const serialised: unknown = JSON.stringify(event);
      if (typeof serialised !== 'string') {
        throw openAiInvalidResponse('event_serialization');
      }
      bytes = Buffer.byteLength(serialised, 'utf8');
    } catch {
      throw openAiInvalidResponse('event_serialization');
    }
    checkDeadline();
    streamBytes += bytes;
    if (eventCount > MAX_EVENTS) throw openAiInvalidResponse('event_count');
    if (bytes > MAX_EVENT_BYTES) throw openAiInvalidResponse('event_size');
    if (streamBytes > MAX_STREAM_BYTES)
      throw openAiInvalidResponse('stream_size');
    if (!isRecord(event) || typeof event.type !== 'string')
      throw openAiInvalidResponse('event_shape');
    if (event.type === 'response.failed') {
      const error = isRecord(event.response) ? event.response.error : undefined;
      throw openAiResponsesFailure(isRecord(error) ? error.code : undefined);
    }
    if (event.type === 'error') {
      throw openAiResponsesFailure(event.code);
    }
    if (completed !== undefined) throw openAiInvalidResponse('event_sequence');
    if (event.type === 'response.incomplete')
      throw openAiInvalidResponse('response_incomplete');
    if (event.type.startsWith('response.refusal.'))
      throw openAiInvalidResponse('response_refusal');
    if (event.type === 'response.completed') {
      completed = certify(event.response);
      checkDeadline();
      if (responseId !== undefined && completed.id !== responseId) {
        throw openAiInvalidResponse('response_identity');
      }
    } else {
      if (!INTERMEDIATE_TYPES.has(event.type)) {
        throw openAiInvalidResponse('event_type');
      }
      if (
        event.type === 'response.created' ||
        event.type === 'response.in_progress'
      ) {
        const snapshot = z
          .object({ id: safeMetadata(512) })
          .safeParse(event.response);
        if (
          !snapshot.success ||
          (responseId !== undefined && responseId !== snapshot.data.id)
        ) {
          throw openAiInvalidResponse('response_identity');
        }
        responseId = snapshot.data.id;
      }
      if (event.type.startsWith('response.output_item.')) {
        if (
          !isRecord(event.item) ||
          (event.item.type !== 'message' && event.item.type !== 'reasoning')
        ) {
          throw openAiInvalidResponse('output_item');
        }
        if (
          event.item.status === 'incomplete' ||
          (event.item.type === 'message' &&
            Array.isArray(event.item.content) &&
            event.item.content.some(
              (part: unknown) => !isRecord(part) || part.type !== 'output_text',
            ))
        ) {
          throw openAiInvalidResponse('output_item');
        }
      }
      if (event.type.startsWith('response.content_part.')) {
        if (!isRecord(event.part) || event.part.type !== 'output_text') {
          throw openAiInvalidResponse('content_part');
        }
      }
      if (event.type.endsWith('.delta') && typeof event.delta !== 'string') {
        throw openAiInvalidResponse('text_delta');
      }
    }
  }
}

function certify(raw: unknown): CertifiedResponse {
  const parsed = CompletedSchema.safeParse(raw);
  if (!parsed.success) {
    // Choose from local names only. Never retain Zod paths, issues or output.
    let failure: OpenAiResponsesValidationFailure = 'completion_shape';
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === 'usage') failure = 'completion_usage';
    else if (issue?.path[0] === 'output') {
      failure = 'completion_output';
      const index = issue.path[1];
      const item =
        isRecord(raw) && Array.isArray(raw.output) && typeof index === 'number'
          ? (raw.output[index] as unknown)
          : undefined;
      if (isRecord(item) && item.type === 'message')
        failure = 'completion_message';
      else if (isRecord(item) && item.type === 'reasoning')
        failure = 'completion_reasoning';
    }
    throw openAiInvalidResponse(failure);
  }
  const response = parsed.data;
  const messages = response.output.filter((item) => item.type === 'message');
  const message = messages[0];
  const text = message?.content[0]?.text;
  const nativeUsage = response.usage;
  const cached = nativeUsage.input_tokens_details?.cached_tokens;
  if (messages.length !== 1 || text === undefined)
    throw openAiInvalidResponse('completion_message');
  if (
    !Number.isSafeInteger(
      nativeUsage.input_tokens + nativeUsage.output_tokens,
    ) ||
    nativeUsage.total_tokens !==
      nativeUsage.input_tokens + nativeUsage.output_tokens
  ) {
    throw openAiInvalidResponse('usage_totals');
  }
  if (
    (cached !== undefined && cached > nativeUsage.input_tokens) ||
    (nativeUsage.output_tokens_details !== undefined &&
      nativeUsage.output_tokens_details.reasoning_tokens >
        nativeUsage.output_tokens)
  ) {
    throw openAiInvalidResponse('usage_details');
  }
  return {
    id: response.id,
    model: response.model,
    text,
    usage: {
      inputTokens: nativeUsage.input_tokens,
      outputTokens: nativeUsage.output_tokens,
      totalTokens: nativeUsage.total_tokens,
      ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    },
  };
}

function closeIterator(iterator: AsyncIterator<unknown> | undefined): void {
  try {
    if (iterator?.return !== undefined) {
      void Promise.resolve(iterator.return()).catch(() => undefined);
    }
  } catch {
    // Cleanup cannot retain transport errors or block timeout rejection.
  }
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new OpenAiResponsesError('unsupported_request');
  }
  return value;
}

function timerDuration(value: unknown): number {
  const result = positiveInteger(value);
  if (result > 2_147_483_647) {
    throw new OpenAiResponsesError('unsupported_request');
  }
  return result;
}

function configuredDuration(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return timerDuration(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

/** Disallow keys that a stripping Zod object would silently discard. */
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const a = left as unknown[];
    const b = right as unknown[];
    return (
      a.length === b.length &&
      a.every((value, index) => sameJsonValue(value, b[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const names = Object.keys(left);
    return (
      names.length === Object.keys(right).length &&
      names.every(
        (name) =>
          Object.hasOwn(right, name) && sameJsonValue(left[name], right[name]),
      )
    );
  }
  return false;
}
