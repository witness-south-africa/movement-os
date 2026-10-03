import {
  AgentMessageSchema,
  AgentTaskKindSchema,
  type CompleteArgs,
  type ModelProvider,
  type ModelResponse,
  type TokenUsage,
} from '@wsa/agent-contracts';
import { z } from 'zod';
import type {
  AnthropicClient,
  AnthropicConversationMessage,
  AnthropicMessageRequest,
  AnthropicTextBlock,
} from './anthropic-client.js';
import { zodToAnthropicJsonSchema } from './json-schema.js';

export interface AnthropicProviderConfig {
  readonly client: AnthropicClient;
  /** Explicit operator-selected model supporting native structured output. */
  readonly model: string;
  /** Positive safe-integer fallback ceiling when the caller omits a cap. Default: 4096. */
  readonly defaultMaxOutputTokens?: number;
}

const safeCounter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const safeMetadata = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .refine(
      (value) =>
        value.trim().length > 0 &&
        !Array.from(value).some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    );
const MessageSchema = z.object({
  id: safeMetadata(512),
  type: z.literal('message'),
  role: z.literal('assistant'),
  model: safeMetadata(256),
  content: z
    .array(z.object({ type: z.literal('text'), text: z.string().min(1) }))
    .length(1),
  stop_reason: safeMetadata(128).nullable(),
  usage: z.object({
    input_tokens: safeCounter,
    output_tokens: safeCounter,
    cache_creation_input_tokens: safeCounter.nullable().optional(),
    cache_read_input_tokens: safeCounter.nullable().optional(),
  }),
});

export function createAnthropicProvider(
  config: AnthropicProviderConfig,
): ModelProvider {
  const model = safeMetadata(256).safeParse(config.model);
  if (!model.success || model.data.trim().length === 0) {
    throw new Error(
      'anthropic adapter: model must be an explicit non-empty identifier',
    );
  }
  const defaultMaxOutputTokens = configuredCeiling(
    config.defaultMaxOutputTokens,
    4096,
    'defaultMaxOutputTokens',
  );
  const client = config.client;
  if (!hasNativeClient(client)) {
    throw new Error('anthropic adapter: client.messages.create is required');
  }
  return Object.freeze({
    id: 'anthropic',
    complete: async <TSchema extends z.ZodType>(
      args: CompleteArgs<TSchema>,
    ): Promise<ModelResponse<z.infer<TSchema>>> => {
      const request = buildRequest(args, model.data, defaultMaxOutputTokens);
      const timeoutMs =
        args.timeoutMs === undefined
          ? undefined
          : positiveInteger(args.timeoutMs, 'timeoutMs');
      if (timeoutMs !== undefined && timeoutMs > 2_147_483_647) {
        throw new Error('anthropic adapter: timeoutMs exceeds the timer range');
      }
      const controller = new AbortController();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutState = { timedOut: false };
      try {
        const timeout =
          timeoutMs === undefined
            ? undefined
            : new Promise<never>((_resolve, reject) => {
                timeoutHandle = setTimeout(() => {
                  timeoutState.timedOut = true;
                  reject(new Error('anthropic adapter: request timed out'));
                  controller.abort();
                }, timeoutMs);
              });
        let raw: unknown;
        try {
          const pending = client.messages.create(request, {
            signal: controller.signal,
          });
          raw = await (timeout === undefined
            ? pending
            : Promise.race([pending, timeout]));
        } catch {
          throw new Error(
            timeoutState.timedOut
              ? 'anthropic adapter: request timed out'
              : 'anthropic adapter: transport failed',
          );
        }
        const parsed = MessageSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(
            'anthropic adapter: invalid response content or metadata',
          );
        }
        const response = parsed.data;
        const block = response.content[0];
        if (block === undefined) {
          throw new Error('anthropic adapter: expected exactly one text block');
        }
        let json: unknown;
        try {
          json = JSON.parse(block.text);
        } catch {
          throw new Error('anthropic adapter: response was not valid JSON');
        }
        const value = args.schema.safeParse(json);
        if (!value.success) {
          throw new Error(
            'anthropic adapter: response failed output schema validation',
          );
        }
        const stopReason = response.stop_reason ?? 'unknown';
        return {
          value: value.data as z.infer<TSchema>,
          usage: normaliseUsage(response.usage),
          provider: 'anthropic',
          model: response.model,
          responseId: response.id,
          rawFinishReason: stopReason,
          status:
            response.stop_reason === 'end_turn' ? 'completed' : 'incomplete',
        };
      } finally {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
      }
    },
  });
}

function buildRequest<TSchema extends z.ZodType>(
  args: CompleteArgs<TSchema>,
  model: string,
  defaultMaxOutputTokens: number,
): AnthropicMessageRequest {
  const lane = AgentTaskKindSchema.safeParse(args.taskKind);
  if (!lane.success) {
    throw new Error('anthropic adapter: invalid task kind');
  }
  if (
    args.tools !== undefined &&
    (!Array.isArray(args.tools) || args.tools.length > 0)
  ) {
    throw new Error('anthropic adapter: tool declarations are unsupported');
  }
  const parsedMessages = z
    .array(AgentMessageSchema)
    .min(1)
    .safeParse(args.messages);
  if (!parsedMessages.success) {
    throw new Error('anthropic adapter: invalid conversation');
  }
  const system: AnthropicTextBlock[] = [];
  const messages: AnthropicConversationMessage[] = [];
  for (const message of parsedMessages.data) {
    if (message.role === 'system') {
      if (messages.length !== 0) {
        throw new Error(
          'anthropic adapter: system instructions must precede conversation messages',
        );
      }
      system.push({ type: 'text', text: message.content });
    } else {
      messages.push({ role: message.role, content: message.content });
    }
  }
  if (
    messages[0]?.role !== 'user' ||
    messages[messages.length - 1]?.role !== 'user'
  ) {
    throw new Error(
      'anthropic adapter: conversation must begin and end with a user message; assistant prefill is unsupported',
    );
  }
  return {
    model,
    max_tokens: configuredCeiling(
      args.maxOutputTokens,
      defaultMaxOutputTokens,
      'maxOutputTokens',
    ),
    messages,
    ...(system.length === 0 ? {} : { system }),
    output_config: {
      format: {
        type: 'json_schema',
        schema: zodToAnthropicJsonSchema(args.schema),
      },
    },
  };
}

function normaliseUsage(
  usage: z.infer<typeof MessageSchema>['usage'],
): TokenUsage {
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const inputTokens = usage.input_tokens + cacheCreation + cacheRead;
  const totalTokens = inputTokens + usage.output_tokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(totalTokens)
  ) {
    throw new Error(
      'anthropic adapter: token usage total exceeds the safe integer range',
    );
  }
  return {
    inputTokens,
    outputTokens: usage.output_tokens,
    totalTokens,
    cachedInputTokens: cacheRead,
  };
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `anthropic adapter: ${name} must be a positive safe integer`,
    );
  }
  return value;
}

function configuredCeiling(
  value: unknown,
  defaultValue: number,
  name: string,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  return positiveInteger(value, name);
}

function hasNativeClient(value: unknown): value is AnthropicClient {
  const clientSchema = z.object({
    messages: z.object({ create: z.function() }),
  });
  return clientSchema.safeParse(value).success;
}
