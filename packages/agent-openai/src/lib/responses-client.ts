import { z } from 'zod';

/** Explicit authentication/billing mode; never inferred from credentials. */
export type OpenAiAccessMode = 'api' | 'subscription';

export interface OpenAiResponsesRequest {
  readonly model: string;
  readonly input: ReadonlyArray<{
    readonly role: 'developer' | 'user' | 'assistant';
    readonly content: string;
  }>;
  readonly store: false;
  readonly stream: true;
  readonly text: {
    readonly format: {
      readonly type: 'json_schema';
      readonly name: string;
      readonly strict: true;
      readonly schema: Record<string, unknown>;
    };
  };
  /** API mode only. Subscription preview rejects this field. */
  readonly max_output_tokens?: number;
}

/** Authenticated streaming transport; emitted events still require validation. */
export interface OpenAiResponsesClient {
  readonly accessMode: OpenAiAccessMode;
  readonly responses: {
    create(
      request: OpenAiResponsesRequest,
      options: { readonly signal: AbortSignal },
    ): Promise<AsyncIterable<unknown>>;
  };
}

export type OpenAiResponsesErrorCode =
  | 'quota_exhausted'
  | 'subscription_unavailable'
  | 'rate_limited'
  | 'authentication_failed'
  | 'permission_denied'
  | 'subscription_ineligible'
  | 'transport_failed'
  | 'invalid_response'
  | 'unsupported_request'
  | 'timeout';

const ErrorCodeSchema = z.enum([
  'quota_exhausted',
  'subscription_unavailable',
  'rate_limited',
  'authentication_failed',
  'permission_denied',
  'subscription_ineligible',
  'transport_failed',
  'invalid_response',
  'unsupported_request',
  'timeout',
]);
export const OpenAiSubscriptionErrorCodeSchema = z.enum([
  'subscription_sharing_usage_limit_exceeded',
  'subscription_sharing_usage_unavailable',
  'subscription_sharing_user_not_eligible',
]);
/** Local rejection points, never values or paths copied from provider output. */
export const OpenAiResponsesValidationFailureSchema = z.enum([
  'response_body',
  'response_content_type',
  'stream_interface',
  'stream_size',
  'event_size',
  'event_json',
  'stream_framing',
  'stream_after_done',
  'stream_utf8',
  'event_serialization',
  'event_count',
  'event_shape',
  'event_type',
  'event_sequence',
  'response_incomplete',
  'response_refusal',
  'response_identity',
  'output_item',
  'content_part',
  'text_delta',
  'completion_missing',
  'completion_shape',
  'completion_usage',
  'completion_output',
  'completion_message',
  'completion_reasoning',
  'usage_totals',
  'usage_details',
  'output_json',
  'output_schema',
  'output_extra_fields',
]);
export type OpenAiResponsesValidationFailure = z.infer<
  typeof OpenAiResponsesValidationFailureSchema
>;
export const OpenAiResponsesDiagnosticsSchema = z
  .object({
    httpStatus: z.number().int().min(100).max(599).optional(),
    /** Header classification only; never the raw MIME value or body format. */
    contentTypeCategory: z
      .enum(['missing', 'event_stream', 'json', 'html', 'text', 'other'])
      .optional(),
    bodyShape: z.enum(['error', 'detail', 'other', 'unreadable']).optional(),
    providerCode: OpenAiSubscriptionErrorCodeSchema.optional(),
    validationFailure: OpenAiResponsesValidationFailureSchema.optional(),
    requestId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
  })
  .strict();
export type OpenAiResponsesDiagnostics = z.infer<
  typeof OpenAiResponsesDiagnosticsSchema
>;

/** Finite, safe errors: no raw body, token, provider message or cause retained. */
export class OpenAiResponsesError extends Error {
  constructor(
    readonly code: OpenAiResponsesErrorCode,
    readonly diagnostics?: OpenAiResponsesDiagnostics,
  ) {
    super(`openai responses adapter: ${code}`);
    this.name = 'OpenAiResponsesError';
  }
}

export function openAiInvalidResponse(
  validationFailure: OpenAiResponsesValidationFailure,
): OpenAiResponsesError {
  return new OpenAiResponsesError('invalid_response', { validationFailure });
}

/** Recognize only documented subscription errors; never inspect message text. */
export function openAiResponsesFailure(code: unknown): OpenAiResponsesError {
  const parsed = OpenAiSubscriptionErrorCodeSchema.safeParse(code);
  const diagnostics = parsed.success
    ? { providerCode: parsed.data }
    : undefined;
  if (code === 'subscription_sharing_usage_limit_exceeded') {
    return new OpenAiResponsesError('quota_exhausted', diagnostics);
  }
  if (code === 'subscription_sharing_usage_unavailable') {
    return new OpenAiResponsesError('subscription_unavailable', diagnostics);
  }
  if (code === 'subscription_sharing_user_not_eligible') {
    return new OpenAiResponsesError('subscription_ineligible', diagnostics);
  }
  return new OpenAiResponsesError('transport_failed');
}

/** Copy only validated finite fields, even from a mutated injected exception. */
export function sanitizeOpenAiResponsesError(
  error: unknown,
): OpenAiResponsesError {
  try {
    if (!(error instanceof OpenAiResponsesError)) {
      return new OpenAiResponsesError('transport_failed');
    }
    const code = ErrorCodeSchema.safeParse(error.code);
    const diagnostics = OpenAiResponsesDiagnosticsSchema.safeParse(
      error.diagnostics,
    );
    return new OpenAiResponsesError(
      code.success ? code.data : 'transport_failed',
      diagnostics.success ? diagnostics.data : undefined,
    );
  } catch {
    return new OpenAiResponsesError('transport_failed');
  }
}
