/** Fixed production authority for the public local/self-hosted flow. */
export const SUBSCRIPTION_ISSUER = 'https://auth.openai.com';
export const SUBSCRIPTION_RESOURCE = 'https://api.openai.com/v1';

export type SubscriptionAuthErrorCode =
  | 'invalid_configuration'
  | 'storage_unavailable'
  | 'storage_locked'
  | 'invalid_callback'
  | 'access_denied'
  | 'invalid_identity'
  | 'account_not_found'
  | 'plan_not_authorized'
  | 'reauthorization_required'
  | 'invalid_response'
  | 'transport_failed'
  | 'cancelled'
  | 'timeout';

/** Never retains endpoint responses, tokens, URLs, paths or an underlying cause. */
export class OpenAiSubscriptionAuthError extends Error {
  readonly code: SubscriptionAuthErrorCode;
  constructor(code: SubscriptionAuthErrorCode) {
    const known = [
      'invalid_configuration',
      'storage_unavailable',
      'storage_locked',
      'invalid_callback',
      'access_denied',
      'invalid_identity',
      'account_not_found',
      'plan_not_authorized',
      'reauthorization_required',
      'invalid_response',
      'transport_failed',
      'cancelled',
      'timeout',
    ].includes(code)
      ? code
      : 'transport_failed';
    super(`openai subscription authentication: ${known}`);
    this.code = known;
    this.name = 'OpenAiSubscriptionAuthError';
  }
}

/** Rebuild even caller-supplied typed exceptions; getters and causes are untrusted. */
export function sanitizeOpenAiSubscriptionAuthError(
  error: unknown,
  fallback: 'transport_failed' | 'storage_unavailable' = 'transport_failed',
): OpenAiSubscriptionAuthError {
  try {
    if (error instanceof OpenAiSubscriptionAuthError) {
      return new OpenAiSubscriptionAuthError(error.code);
    }
  } catch {
    /* A caller may attach a throwing property accessor. */
  }
  return new OpenAiSubscriptionAuthError(fallback);
}

/** Internal protected record. Account identity is issuer + issued client + sub. */
export interface SubscriptionAccountRecord {
  key: string;
  issuer: typeof SUBSCRIPTION_ISSUER;
  subject: string;
  clientId: string;
  label: string;
  email?: string | undefined;
  tokens?:
    | {
        accessToken: string;
        refreshToken?: string | undefined;
        idToken: string;
        scopes: string[];
        expiresAt: number;
        earliestRefreshAt?: number | undefined;
      }
    | undefined;
}

export interface SubscriptionState {
  version: 1;
  hostId: string;
  /** Issued but not yet identity-verified registration; never an active account. */
  pendingClientId?: string | undefined;
  activeAccountKey?: string | undefined;
  accounts: SubscriptionAccountRecord[];
}

/** A transaction holds the lock through its callback, including token rotation.
 * Successful callbacks atomically persist mutations. Throwing rolls them back.
 * Keep token-bearing state inside the callback; expose only safe metadata.
 */
export interface SubscriptionStore {
  transaction<T>(
    operation: (state: SubscriptionState) => Promise<T>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<T>;
}
