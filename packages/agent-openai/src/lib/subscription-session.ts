import { createHash, randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { performance } from 'node:perf_hooks';
import type { ReadableStreamReadResult } from 'node:stream/web';
import {
  createLocalJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';
import type { OpenAiSubscriptionCredential } from './responses-fetch-client.js';
import {
  OpenAiSubscriptionAuthError,
  sanitizeOpenAiSubscriptionAuthError,
  SUBSCRIPTION_ISSUER,
  SUBSCRIPTION_RESOURCE,
  type SubscriptionAccountRecord,
  type SubscriptionState,
  type SubscriptionStore,
} from './subscription-auth-types.js';
import { openSubscriptionLoopback } from './subscription-loopback.js';
import { subscriptionAccountKey } from './subscription-store.js';

export interface SubscriptionAccountInfo {
  readonly key: string;
  readonly label: string;
  readonly email?: string;
  readonly active: boolean;
  readonly signedIn: boolean;
  readonly planUsageAuthorized: boolean;
}

export interface SubscriptionModelInfo {
  readonly slug: string;
  readonly displayName: string;
}

export interface OpenAiSubscriptionSessionOptions {
  readonly store: SubscriptionStore;
  readonly hosting: 'local' | 'self-hosted';
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Bounds a complete attempt, including browser, network and body reads. */
  readonly timeoutMs?: number;
}

export interface OpenAiSubscriptionSignInOptions {
  /** Open on the listener's host. This URL may contain an ID-token hint: do not log it. */
  readonly openAuthorizationUrl: (url: string) => Promise<void> | void;
  readonly accountKey?: string;
  /** An explicit operator choice; ordinary sign-in never forces consent. */
  readonly enablePlanUsage?: boolean;
  readonly signal?: AbortSignal;
}

interface RequestOptions {
  readonly signal?: AbortSignal;
}
interface Discovery {
  readonly algorithms: string[];
  readonly revocationEndpoint?: string;
}
interface Operation {
  readonly signal: AbortSignal;
  check(): void;
  wait<T>(promise: Promise<T>): Promise<T>;
}
type TokenSet = NonNullable<SubscriptionAccountRecord['tokens']>;
type AccessOutcome =
  | { readonly credential: OpenAiSubscriptionCredential }
  | { readonly error: OpenAiSubscriptionAuthError };

const AUTHORIZE_ENDPOINT = `${SUBSCRIPTION_ISSUER}/api/accounts/authorize`;
const TOKEN_ENDPOINT = `${SUBSCRIPTION_ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_ENDPOINT = `${SUBSCRIPTION_ISSUER}/.well-known/openid-configuration`;
const JWKS_ENDPOINT = `${SUBSCRIPTION_ISSUER}/.well-known/jwks.json`;
const MODEL_ENDPOINT = `${SUBSCRIPTION_RESOURCE}/models`;
const SCOPES =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const SECURE_ALGORITHMS = new Set(['RS256', 'PS256', 'ES256', 'EdDSA']);
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);
const MAX_BODY_BYTES = 1_048_576;

/** Official public-client flow only. No credential discovery, paid fallback or model choice. */
export function createOpenAiSubscriptionSession(
  config: OpenAiSubscriptionSessionOptions,
) {
  const transport = config.fetch ?? globalThis.fetch;
  const now = config.now ?? Date.now;
  const timeoutMs = config.timeoutMs ?? 300_000;
  if (
    !['local', 'self-hosted'].includes(config.hosting) ||
    typeof object(config.store)?.transaction !== 'function' ||
    (config.fetch !== undefined && typeof config.fetch !== 'function') ||
    (config.now !== undefined && typeof config.now !== 'function') ||
    typeof transport !== 'function' ||
    typeof now !== 'function' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 600_000
  )
    throw new OpenAiSubscriptionAuthError('invalid_configuration');
  let discoveryCache: { value: Discovery; expiresAt: number } | undefined;
  let keyCache:
    | {
        resolver: ReturnType<typeof createLocalJWKSet>;
        fetchedAt: number;
      }
    | undefined;

  async function request(
    url: string,
    init: RequestInit,
    operation: Operation,
    observeStatus?: (status: number) => void,
  ) {
    operation.check();
    let response: Response;
    try {
      const transportOptions: RequestInit & { readonly cache: 'no-store' } = {
        ...init,
        redirect: 'error',
        cache: 'no-store',
        signal: operation.signal,
      };
      const pending = transport(url, transportOptions);
      // A custom transport can ignore AbortSignal and resolve after the deadline.
      void pending.then(
        (late) => {
          if (operation.signal.aborted)
            void late.body?.cancel().catch(() => undefined);
        },
        () => undefined,
      );
      response = await operation.wait(pending);
    } catch {
      operation.check();
      throw new OpenAiSubscriptionAuthError('transport_failed');
    }
    if (response.redirected || (response.url !== '' && response.url !== url)) {
      void response.body?.cancel().catch(() => undefined);
      throw new OpenAiSubscriptionAuthError('invalid_response');
    }
    // Refresh can rotate at HTTP 200 even if the replacement body is unusable.
    // Observe only a response that passed the fixed-origin/redirect guards.
    observeStatus?.(response.status);
    const declared = response.headers.get('content-length');
    if (
      declared !== null &&
      (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new OpenAiSubscriptionAuthError('invalid_response');
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      if (reader) {
        for (;;) {
          const next: ReadableStreamReadResult<unknown> = await operation.wait(
            reader.read(),
          );
          if (next.done) break;
          if (!(next.value instanceof Uint8Array))
            throw new OpenAiSubscriptionAuthError('invalid_response');
          length += next.value.byteLength;
          if (length > MAX_BODY_BYTES)
            throw new OpenAiSubscriptionAuthError('invalid_response');
          chunks.push(next.value);
        }
      }
      operation.check();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      const value: unknown = text === '' ? undefined : JSON.parse(text);
      operation.check();
      return { status: response.status, value, empty: text === '' };
    } catch (error) {
      operation.check();
      if (error instanceof OpenAiSubscriptionAuthError) throw error;
      throw new OpenAiSubscriptionAuthError('invalid_response');
    } finally {
      if (reader) {
        void reader.cancel().catch(() => undefined);
        try {
          reader.releaseLock();
        } catch {
          /* A non-cooperative read may still be pending. */
        }
      }
    }
  }

  async function discovery(operation: Operation): Promise<Discovery> {
    if (discoveryCache && discoveryCache.expiresAt > time())
      return discoveryCache.value;
    const response = await request(
      DISCOVERY_ENDPOINT,
      { headers: { accept: 'application/json' } },
      operation,
    );
    const value = object(response.value);
    if (
      response.status !== 200 ||
      value?.issuer !== SUBSCRIPTION_ISSUER ||
      value.authorization_endpoint !== AUTHORIZE_ENDPOINT ||
      value.token_endpoint !== TOKEN_ENDPOINT ||
      value.jwks_uri !== JWKS_ENDPOINT
    ) {
      throw new OpenAiSubscriptionAuthError('invalid_response');
    }
    const offered = value.id_token_signing_alg_values_supported;
    if (
      !Array.isArray(offered) ||
      offered.length > 16 ||
      !offered.every((algorithm) => typeof algorithm === 'string')
    ) {
      throw new OpenAiSubscriptionAuthError('invalid_response');
    }
    const algorithms = [
      ...new Set(
        offered.filter((algorithm) => SECURE_ALGORITHMS.has(algorithm)),
      ),
    ];
    if (algorithms.length === 0)
      throw new OpenAiSubscriptionAuthError('invalid_response');
    const endpoint = value.revocation_endpoint;
    if (endpoint !== undefined && !officialRevocationEndpoint(endpoint)) {
      throw new OpenAiSubscriptionAuthError('invalid_response');
    }
    const result: Discovery = {
      algorithms,
      ...(typeof endpoint === 'string' ? { revocationEndpoint: endpoint } : {}),
    };
    operation.check();
    discoveryCache = { value: result, expiresAt: time() + 300_000 };
    return result;
  }

  async function loadKeys(operation: Operation) {
    const response = await request(
      JWKS_ENDPOINT,
      { headers: { accept: 'application/json' } },
      operation,
    );
    const value = object(response.value);
    if (
      response.status !== 200 ||
      !Array.isArray(value?.keys) ||
      value.keys.length === 0 ||
      value.keys.length > 32 ||
      !value.keys.every((key: unknown) => object(key) !== undefined)
    ) {
      throw new OpenAiSubscriptionAuthError('invalid_identity');
    }
    operation.check();
    keyCache = {
      resolver: createLocalJWKSet(value as unknown as JSONWebKeySet),
      fetchedAt: time(),
    };
    return keyCache;
  }

  async function verifyIdentity(
    token: string,
    clientId: string,
    operation: Operation,
    nonce?: string,
  ): Promise<JWTPayload> {
    const metadata = await discovery(operation);
    let keys =
      keyCache && keyCache.fetchedAt + 300_000 > time()
        ? keyCache
        : await loadKeys(operation);
    const verify = async () =>
      operation.wait(
        jwtVerify(token, keys.resolver, {
          issuer: SUBSCRIPTION_ISSUER,
          audience: clientId,
          algorithms: metadata.algorithms,
          requiredClaims: ['sub', 'exp', 'iat'],
          clockTolerance: 5,
          currentDate: new Date(time()),
        }),
      );
    try {
      let verified;
      try {
        verified = await verify();
      } catch (error) {
        if (
          !(error instanceof joseErrors.JWKSNoMatchingKey) ||
          keys.fetchedAt + 30_000 > time()
        )
          throw error;
        // Cooldown bounds requests triggered by attacker-supplied unfamiliar kids.
        keys = await loadKeys(operation);
        verified = await verify();
      }
      const identity = verified.payload;
      if (
        !safeText(identity.sub, 512) ||
        typeof identity.iat !== 'number' ||
        !Number.isSafeInteger(identity.iat) ||
        identity.iat > Math.floor(time() / 1000) + 5 ||
        typeof identity.exp !== 'number' ||
        !Number.isSafeInteger(identity.exp) ||
        identity.exp <= identity.iat ||
        (nonce !== undefined && identity.nonce !== nonce) ||
        (identity.azp !== undefined && identity.azp !== clientId) ||
        (Array.isArray(identity.aud) &&
          identity.aud.length > 1 &&
          identity.azp !== clientId)
      ) {
        throw new OpenAiSubscriptionAuthError('invalid_identity');
      }
      operation.check();
      return identity;
    } catch {
      operation.check();
      throw new OpenAiSubscriptionAuthError('invalid_identity');
    }
  }

  async function exchange(
    body: URLSearchParams,
    operation: Operation,
    observeStatus?: (status: number) => void,
  ) {
    return request(
      TOKEN_ENDPOINT,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
      },
      operation,
      observeStatus,
    );
  }

  async function resolveInside(
    state: SubscriptionState,
    operation: Operation,
  ): Promise<AccessOutcome> {
    const account = selectedAccount(state);
    let tokens = account.tokens;
    if (!tokens)
      return {
        error: new OpenAiSubscriptionAuthError('reauthorization_required'),
      };
    if (!planGrant(tokens))
      return { error: new OpenAiSubscriptionAuthError('plan_not_authorized') };
    if (tokens.expiresAt <= time()) {
      if (!tokens.refreshToken) {
        delete account.tokens;
        return {
          error: new OpenAiSubscriptionAuthError('reauthorization_required'),
        };
      }
      const refreshStatus: { succeeded: boolean } = { succeeded: false };
      try {
        const response = await exchange(
          new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: account.clientId,
            refresh_token: tokens.refreshToken,
            resource: SUBSCRIPTION_RESOURCE,
          }),
          operation,
          (status) => {
            refreshStatus.succeeded = status === 200;
          },
        );
        if (response.status !== 200) {
          const code = object(response.value)?.error;
          if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 429 &&
            typeof code === 'string' &&
            TERMINAL_REFRESH_ERRORS.has(code)
          ) {
            // Return successfully so invalidation commits before the public method throws.
            operation.check();
            delete account.tokens;
            return {
              error: new OpenAiSubscriptionAuthError(
                'reauthorization_required',
              ),
            };
          }
          throw new OpenAiSubscriptionAuthError('transport_failed');
        }
        const value = object(response.value);
        const next = parseTokens(value, time(), tokens.idToken, true);
        if (next.refreshToken === tokens.refreshToken)
          throw new OpenAiSubscriptionAuthError('invalid_response');
        if (value?.id_token !== undefined) {
          const identity = await verifyIdentity(
            next.idToken,
            account.clientId,
            operation,
          );
          if (identity.sub !== account.subject)
            throw new OpenAiSubscriptionAuthError('invalid_identity');
        }
        operation.check();
        account.tokens = next;
        tokens = next;
        if (!planGrant(tokens))
          return {
            error: new OpenAiSubscriptionAuthError('plan_not_authorized'),
          };
      } catch (error) {
        if (!refreshStatus.succeeded) throw error;
        // The provider confirmed a successful exchange. Reusing the previous
        // refresh token after an unreadable/unverified replacement is unsafe.
        // Return so this selected-registration invalidation is committed.
        delete account.tokens;
        return {
          error: sanitizeOpenAiSubscriptionAuthError(error),
        };
      }
    }
    operation.check();
    return {
      credential: {
        accessMode: 'subscription',
        accessToken: tokens.accessToken,
        planUsageAuthorized: true,
      },
    };
  }

  function time(): number {
    const value = now();
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > Number.MAX_SAFE_INTEGER - 86_400_000
    ) {
      throw new OpenAiSubscriptionAuthError('invalid_configuration');
    }
    return value;
  }

  return Object.freeze({
    async signIn(
      options: OpenAiSubscriptionSignInOptions,
    ): Promise<SubscriptionAccountInfo> {
      if (
        typeof object(options)?.openAuthorizationUrl !== 'function' ||
        (options.enablePlanUsage !== undefined &&
          typeof options.enablePlanUsage !== 'boolean')
      ) {
        throw new OpenAiSubscriptionAuthError('invalid_configuration');
      }
      return withOperation(timeoutMs, options.signal, async (operation) => {
        // Persist a newly generated host ID before exposing any authorization URL.
        await operation.wait(
          config.store.transaction(
            () => {
              operation.check();
              return Promise.resolve();
            },
            { signal: operation.signal },
          ),
        );
        const outcome = await operation.wait(
          config.store.transaction(
            async (saved) => {
              let listener:
                | Awaited<ReturnType<typeof openSubscriptionLoopback>>
                | undefined;
              try {
                operation.check();
                time();
                const selected =
                  options.accountKey !== undefined
                    ? findAccount(saved, options.accountKey)
                    : undefined;
                if (!selected && saved.accounts.length >= 32)
                  throw new OpenAiSubscriptionAuthError(
                    'invalid_configuration',
                  );
                const client = selected?.clientId ?? saved.pendingClientId;
                const state = randomBytes(32).toString('base64url');
                const nonce = randomBytes(32).toString('base64url');
                const verifier = randomBytes(32).toString('base64url');
                listener = await operation.wait(
                  openSubscriptionLoopback({ state, signal: operation.signal }),
                );
                const url = new URL(AUTHORIZE_ENDPOINT);
                url.search = new URLSearchParams({
                  client_id: client ?? 'dynamic_agent_client',
                  ...(client === undefined
                    ? { agent_name_hint: 'Movement OS' }
                    : {}),
                  ext_agent_host_id: saved.hostId,
                  response_type: 'code',
                  redirect_uri: listener.redirectUri,
                  scope: SCOPES,
                  resource: SUBSCRIPTION_RESOURCE,
                  state,
                  nonce,
                  code_challenge_method: 'S256',
                  code_challenge: createHash('sha256')
                    .update(verifier)
                    .digest('base64url'),
                  ...(selected?.tokens?.idToken
                    ? { id_token_hint: selected.tokens.idToken }
                    : {}),
                  ...(selected?.email ? { login_hint: selected.email } : {}),
                  ...(options.enablePlanUsage ? { prompt: 'consent' } : {}),
                }).toString();
                await operation.wait(
                  Promise.resolve().then(() =>
                    options.openAuthorizationUrl(url.toString()),
                  ),
                );
                const callback = await operation.wait(listener.callback);
                const clientId = callback.clientId ?? client;
                if (
                  !clientId ||
                  clientId === 'dynamic_agent_client' ||
                  (client !== undefined && client !== clientId)
                ) {
                  throw new OpenAiSubscriptionAuthError('invalid_callback');
                }
                // A returned issued client is unverified registration metadata until
                // the ID token validates. Error outcomes preserve this mapping only.
                if (!selected) saved.pendingClientId = clientId;
                const response = await exchange(
                  new URLSearchParams({
                    grant_type: 'authorization_code',
                    client_id: clientId,
                    code: callback.code,
                    code_verifier: verifier,
                    redirect_uri: listener.redirectUri,
                    resource: SUBSCRIPTION_RESOURCE,
                  }),
                  operation,
                );
                if (response.status !== 200)
                  throw new OpenAiSubscriptionAuthError(
                    'reauthorization_required',
                  );
                const tokens = parseTokens(object(response.value), time());
                const identity = await verifyIdentity(
                  tokens.idToken,
                  clientId,
                  operation,
                  nonce,
                );
                if (selected && identity.sub !== selected.subject)
                  throw new OpenAiSubscriptionAuthError('invalid_identity');
                operation.check();
                const subject = identity.sub;
                if (typeof subject !== 'string')
                  throw new OpenAiSubscriptionAuthError('invalid_identity');
                const key = subscriptionAccountKey(clientId, subject);
                let account = saved.accounts.find((item) => item.key === key);
                if (selected && account?.key !== selected.key)
                  throw new OpenAiSubscriptionAuthError('invalid_identity');
                if (!account) {
                  account = {
                    key,
                    issuer: SUBSCRIPTION_ISSUER,
                    clientId,
                    subject,
                    label: `ChatGPT account ${key.slice(0, 12)}`,
                  };
                  saved.accounts.push(account);
                }
                if (safeText(identity.email, 320))
                  account.email = identity.email;
                account.tokens = tokens;
                saved.activeAccountKey = key;
                if (saved.pendingClientId === clientId)
                  delete saved.pendingClientId;
                return { account: accountInfo(account, key) };
              } catch (error) {
                // Returning commits valid pending registration metadata; no account
                // credentials are touched until the entire identity check succeeds.
                return {
                  error:
                    error instanceof OpenAiSubscriptionAuthError
                      ? error
                      : new OpenAiSubscriptionAuthError('transport_failed'),
                };
              } finally {
                listener?.close();
              }
            },
            { signal: operation.signal },
          ),
        );
        if ('error' in outcome) throw outcome.error;
        return outcome.account;
      });
    },

    async listAccounts(): Promise<readonly SubscriptionAccountInfo[]> {
      try {
        return await config.store.transaction((state) =>
          Promise.resolve(
            state.accounts.map((account) =>
              accountInfo(account, state.activeAccountKey),
            ),
          ),
        );
      } catch (error) {
        throw sanitizeOpenAiSubscriptionAuthError(error, 'storage_unavailable');
      }
    },

    async selectAccount(key: string): Promise<SubscriptionAccountInfo> {
      try {
        return await config.store.transaction((state) => {
          const account = findAccount(state, key);
          state.activeAccountKey = key;
          return Promise.resolve(accountInfo(account, key));
        });
      } catch (error) {
        throw sanitizeOpenAiSubscriptionAuthError(error, 'storage_unavailable');
      }
    },

    async resolveAccessToken(
      options: RequestOptions = {},
    ): Promise<OpenAiSubscriptionCredential> {
      return withOperation(timeoutMs, options.signal, async (operation) => {
        const outcome = await operation.wait(
          config.store.transaction((state) => resolveInside(state, operation), {
            signal: operation.signal,
          }),
        );
        if ('error' in outcome) throw outcome.error;
        return outcome.credential;
      });
    },

    async listModels(
      options: RequestOptions = {},
    ): Promise<readonly SubscriptionModelInfo[]> {
      const outcome = await withOperation(
        timeoutMs,
        options.signal,
        async (operation) =>
          operation.wait(
            config.store.transaction(
              async (state) => {
                const resolved = await resolveInside(state, operation);
                if ('error' in resolved) return resolved;
                try {
                  const response = await request(
                    MODEL_ENDPOINT,
                    {
                      headers: {
                        accept: 'application/json',
                        authorization: `Bearer ${resolved.credential.accessToken}`,
                      },
                    },
                    operation,
                  );
                  const models = object(response.value)?.models;
                  if (
                    response.status !== 200 ||
                    !Array.isArray(models) ||
                    models.length > 1000
                  ) {
                    throw new OpenAiSubscriptionAuthError('invalid_response');
                  }
                  const visible: SubscriptionModelInfo[] = [];
                  for (const item of models) {
                    const model = object(item);
                    if (!model)
                      throw new OpenAiSubscriptionAuthError('invalid_response');
                    if (model.visibility !== 'list') continue;
                    if (
                      !safeText(model.slug, 256) ||
                      !safeText(model.display_name, 512)
                    ) {
                      throw new OpenAiSubscriptionAuthError('invalid_response');
                    }
                    visible.push({
                      slug: model.slug,
                      displayName: model.display_name,
                    });
                  }
                  return { models: visible };
                } catch (error) {
                  // A completed rotation must persist even if catalogue retrieval fails.
                  return {
                    error:
                      error instanceof OpenAiSubscriptionAuthError
                        ? error
                        : new OpenAiSubscriptionAuthError('transport_failed'),
                  };
                }
              },
              { signal: operation.signal },
            ),
          ),
      );
      if ('error' in outcome)
        throw sanitizeOpenAiSubscriptionAuthError(outcome.error);
      return outcome.models;
    },

    async signOut(
      options: RequestOptions & { readonly accountKey?: string } = {},
    ): Promise<{
      readonly remoteRevocationConfirmed: boolean;
    }> {
      // Hold the selected registration lock through revocation and local clearing.
      try {
        return await config.store.transaction(async (state) => {
          const account =
            options.accountKey !== undefined
              ? findAccount(state, options.accountKey)
              : selectedAccount(state);
          let remoteRevocationConfirmed = false;
          const refreshToken = account.tokens?.refreshToken;
          if (refreshToken) {
            try {
              remoteRevocationConfirmed = await withOperation(
                timeoutMs,
                options.signal,
                async (operation) => {
                  const metadata = await discovery(operation);
                  if (!metadata.revocationEndpoint) return false;
                  const response = await request(
                    metadata.revocationEndpoint,
                    {
                      method: 'POST',
                      headers: {
                        'content-type': 'application/x-www-form-urlencoded',
                      },
                      body: new URLSearchParams({
                        token: refreshToken,
                        token_type_hint: 'refresh_token',
                        client_id: account.clientId,
                      }),
                    },
                    operation,
                  );
                  return response.status === 200 && response.empty;
                },
              );
            } catch {
              /* Local sign-out must still complete; never claim unconfirmed remote revocation. */
            }
          }
          delete account.tokens;
          return { remoteRevocationConfirmed };
        });
      } catch (error) {
        throw sanitizeOpenAiSubscriptionAuthError(error, 'storage_unavailable');
      }
    },
  });
}

export type OpenAiSubscriptionSession = ReturnType<
  typeof createOpenAiSubscriptionSession
>;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeText(value: unknown, maximum: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum)
    return false;
  for (const character of value) {
    if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      return false;
  }
  return true;
}

function tokenValue(value: unknown): value is string {
  return safeText(value, 32_768) && /^[!-~]+$/u.test(value);
}

function parseTokens(
  value: Record<string, unknown> | undefined,
  savedAt: number,
  retainedIdToken?: string,
  refreshing = false,
): TokenSet {
  if (
    !value ||
    !(
      typeof value.access_token === 'string' &&
      value.access_token.length <= 16_384 &&
      /^[A-Za-z0-9._~+/-]+=*$/u.test(value.access_token)
    ) ||
    typeof value.token_type !== 'string' ||
    value.token_type.toLowerCase() !== 'bearer' ||
    !Number.isSafeInteger(value.expires_in) ||
    (value.expires_in as number) < 1 ||
    (value.expires_in as number) > 86_400 ||
    !safeText(value.scope, 4096) ||
    (value.refresh_token !== undefined && !tokenValue(value.refresh_token)) ||
    (refreshing && !tokenValue(value.refresh_token))
  ) {
    throw new OpenAiSubscriptionAuthError('invalid_response');
  }
  const idToken = value.id_token ?? retainedIdToken;
  if (!tokenValue(idToken))
    throw new OpenAiSubscriptionAuthError('invalid_response');
  const expiresAt = savedAt + (value.expires_in as number) * 1000;
  const earliest = value.earliest_refresh_at;
  // Official docs name the field without defining its units. Accept only a
  // plausible absolute Unix-seconds timestamp inside this access-token lifetime.
  if (
    earliest !== undefined &&
    (!Number.isSafeInteger(earliest) ||
      (earliest as number) < Math.floor(savedAt / 1000) ||
      (earliest as number) > Math.floor(expiresAt / 1000))
  ) {
    throw new OpenAiSubscriptionAuthError('invalid_response');
  }
  const scopes = [...new Set(value.scope.split(/ +/u))];
  if (
    scopes.length > 64 ||
    scopes.some((scope) => !/^[A-Za-z0-9._:-]{1,128}$/u.test(scope))
  ) {
    throw new OpenAiSubscriptionAuthError('invalid_response');
  }
  return {
    accessToken: value.access_token,
    idToken,
    ...(typeof value.refresh_token === 'string'
      ? { refreshToken: value.refresh_token }
      : {}),
    scopes,
    expiresAt,
    ...(typeof earliest === 'number'
      ? { earliestRefreshAt: earliest * 1000 }
      : {}),
  };
}

function planGrant(tokens: TokenSet): boolean {
  return (
    tokens.scopes.includes('chatgpt.tokens.use.direct') &&
    tokens.scopes.includes('resource.invoke')
  );
}

function accountInfo(
  account: SubscriptionAccountRecord,
  active: string | undefined,
): SubscriptionAccountInfo {
  return {
    key: account.key,
    label: account.label,
    ...(account.email ? { email: account.email } : {}),
    active: account.key === active,
    signedIn: account.tokens !== undefined,
    planUsageAuthorized:
      account.tokens !== undefined && planGrant(account.tokens),
  };
}

function findAccount(
  state: SubscriptionState,
  key: string,
): SubscriptionAccountRecord {
  const account = state.accounts.find((item) => item.key === key);
  if (!account) throw new OpenAiSubscriptionAuthError('account_not_found');
  return account;
}

function selectedAccount(state: SubscriptionState): SubscriptionAccountRecord {
  if (state.activeAccountKey === undefined)
    throw new OpenAiSubscriptionAuthError('account_not_found');
  return findAccount(state, state.activeAccountKey);
}

function officialRevocationEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === SUBSCRIPTION_ISSUER &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.pathname !== '/'
    );
  } catch {
    return false;
  }
}

async function withOperation<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  action: (operation: Operation) => Promise<T>,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  let failure: OpenAiSubscriptionAuthError | undefined;
  const fail = (code: 'cancelled' | 'timeout') => {
    failure ??= new OpenAiSubscriptionAuthError(code);
    controller.abort();
  };
  const abort = () => fail('cancelled');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => fail('timeout'), timeoutMs);
  const check = () => {
    if (!failure && performance.now() >= deadline) fail('timeout');
    if (failure) throw failure;
  };
  const operation: Operation = {
    signal: controller.signal,
    check,
    async wait<TValue>(promise: Promise<TValue>): Promise<TValue> {
      try {
        check();
      } catch (error) {
        void promise.catch(() => undefined);
        throw error;
      }
      let rejectAbort!: (reason: OpenAiSubscriptionAuthError) => void;
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      });
      const onAbort = () =>
        rejectAbort(failure ?? new OpenAiSubscriptionAuthError('cancelled'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await Promise.race([promise, cancelled]);
        check();
        return result;
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
      }
    },
  };
  try {
    check();
    const result = await action(operation);
    check();
    return result;
  } catch (error) {
    throw sanitizeOpenAiSubscriptionAuthError(error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    // Dispose any transport/listener still pending after a failed action.
    controller.abort();
  }
}
