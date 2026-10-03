/**
 * Normalized provider response.
 *
 * `status` mirrors xAI Responses API values (`completed`, `in_progress`,
 * `incomplete`). Adapters for providers that use different vocabulary
 * MUST map onto this set — e.g. an OpenAI `finish_reason: "length"`
 * return becomes `status: "incomplete"` because the caller's output
 * schema almost certainly did not fit inside the truncated response.
 *
 * `rawFinishReason` preserves the provider's original string so audit
 * logs can retain it; it's opaque to the contract.
 *
 * `ModelResponse<T>` is a TypeScript interface rather than a Zod schema
 * because the generic `value: T` carries the caller's schema-inferred
 * type, which a parent Zod schema cannot express without losing that
 * information.
 */

import { z } from 'zod';
import type { LlmProviderId } from './provider-id.js';
import type { TokenUsage } from './usage.js';

export const ResponseStatusSchema = z.enum([
  'completed',
  'in_progress',
  'incomplete',
]);
export type ResponseStatus = z.infer<typeof ResponseStatusSchema>;

export interface ModelResponse<T> {
  readonly value: T;
  readonly usage: TokenUsage;
  readonly provider: LlmProviderId;
  readonly model: string;
  /** Explicit access/billing mode when reported by an adapter; never inferred. */
  readonly accessMode?: 'api' | 'subscription';
  readonly responseId?: string | undefined;
  readonly rawFinishReason: string;
  readonly status: ResponseStatus;
}
