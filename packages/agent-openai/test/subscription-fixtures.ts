import { webcrypto } from 'node:crypto';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JWTPayload,
} from 'jose';
import {
  createOpenAiSubscriptionSession,
  type OpenAiSubscriptionSession,
} from '../src/lib/subscription-session.js';
import {
  OpenAiSubscriptionAuthError,
  SUBSCRIPTION_ISSUER,
  SUBSCRIPTION_RESOURCE,
  type SubscriptionState,
  type SubscriptionStore,
} from '../src/lib/subscription-auth-types.js';
export const BASE_TIME = 1791024000000;
export const GRANT =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const DISCOVERY = {
  issuer: SUBSCRIPTION_ISSUER,
  authorization_endpoint: `${SUBSCRIPTION_ISSUER}/api/accounts/authorize`,
  token_endpoint: `${SUBSCRIPTION_ISSUER}/api/accounts/oauth/token`,
  jwks_uri: `${SUBSCRIPTION_ISSUER}/.well-known/jwks.json`,
  revocation_endpoint: `${SUBSCRIPTION_ISSUER}/api/accounts/oauth/revoke`,
  id_token_signing_alg_values_supported: ['RS256'],
};
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let publicKey: JWK;
let otherKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let otherPublicKey: JWK;
export async function initializeSubscriptionFixtures() {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });
  const original = await generateKeyPair('RS256');
  const rotated = await generateKeyPair('RS256');
  signingKey = original.privateKey;
  otherKey = rotated.privateKey;
  publicKey = {
    ...(await exportJWK(original.publicKey)),
    kid: 'original',
    alg: 'RS256',
    use: 'sig',
  };
  otherPublicKey = {
    ...(await exportJWK(rotated.publicKey)),
    kid: 'rotated',
    alg: 'RS256',
    use: 'sig',
  };
}
export class MemoryStore implements SubscriptionStore {
  state: SubscriptionState = {
    version: 1,
    hostId: 'ef776e35-ed24-43d9-a8dc-85e89bd774f1',
    accounts: [],
  };
  private tail = Promise.resolve();
  transaction<T>(
    operation: (state: SubscriptionState) => Promise<T>,
    options?: {
      readonly signal?: AbortSignal;
    },
  ): Promise<T> {
    const run = this.tail.then(async () => {
      if (options?.signal?.aborted)
        throw new OpenAiSubscriptionAuthError('cancelled');
      const copy = structuredClone(this.state);
      const result = await operation(copy);
      this.state = copy;
      return result;
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
interface SubscriptionFixture {
  readonly store: MemoryStore;
  readonly session: OpenAiSubscriptionSession;
  readonly transport: typeof fetch;
  readonly requests: { url: string; init?: RequestInit }[];
  readonly identityOverrides: JWTPayload;
  readonly tokens: Record<string, unknown>;
  readonly open: (
    value: string,
    callback?: Record<string, string | undefined>,
  ) => Promise<void>;
  readonly mint: (
    overrides?: JWTPayload,
    nonce?: string | null,
  ) => Promise<string>;
  readonly authorization: URL;
  clientId: string;
  subject: string;
  currentTime: number;
  discovery: unknown;
  refresh: () => Promise<Response> | Response;
  codeExchange: () => Promise<Response> | Response;
  models: () => Response;
  revoke: () => Response;
  rotate(): void;
  wrongSignature(): void;
}

export function harness(
  storeOverride?: SubscriptionStore,
): SubscriptionFixture {
  const store = new MemoryStore();
  let currentTime = BASE_TIME;
  let authorization: URL | undefined;
  let clientId = 'issued-client-1';
  let subject = 'subject-1';
  let calls = 0;
  const requests: {
    url: string;
    init?: RequestInit;
  }[] = [];
  const identityOverrides: JWTPayload = {};
  const tokens: Record<string, unknown> = {};
  let signKey = () => signingKey;
  let kid = 'original';
  let keys = () => [publicKey];
  let discoveryValue: unknown = DISCOVERY;
  let refreshResponse: (() => Promise<Response> | Response) | undefined;
  let tokenResponse: (() => Promise<Response> | Response) | undefined;
  let modelResponse = () =>
    json({
      models: [
        { slug: 'model-second', display_name: 'Second', visibility: 'list' },
        { slug: 'internal-hidden', display_name: 'Hidden', visibility: 'hide' },
        { slug: 'model-first', display_name: 'First', visibility: 'list' },
      ],
    });
  let revokeResponse = () => new Response(null, { status: 200 });
  const mint = async (
    overrides: JWTPayload = {},
    nonce = authorization?.searchParams.get('nonce'),
  ) => {
    const seconds = Math.floor(currentTime / 1000);
    return new SignJWT({ nonce, email: 'same@example.test', ...overrides })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(SUBSCRIPTION_ISSUER)
      .setAudience(clientId)
      .setSubject(subject)
      .setIssuedAt(seconds)
      .setExpirationTime(seconds + 3600)
      .sign(signKey());
  };
  const mintClaims = async () => {
    const seconds = Math.floor(currentTime / 1000);
    return new SignJWT({
      iss: SUBSCRIPTION_ISSUER,
      aud: clientId,
      sub: subject,
      iat: seconds,
      exp: seconds + 3600,
      nonce: authorization?.searchParams.get('nonce'),
      email: 'same@example.test',
      ...identityOverrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid })
      .sign(signKey());
  };
  const transport = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const target =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    requests.push({ url: target, ...(init ? { init } : {}) });
    if (target === `${SUBSCRIPTION_ISSUER}/.well-known/openid-configuration`)
      return json(discoveryValue);
    if (target === `${SUBSCRIPTION_ISSUER}/.well-known/jwks.json`)
      return json({ keys: keys() });
    if (target === `${SUBSCRIPTION_ISSUER}/api/accounts/oauth/revoke`)
      return revokeResponse();
    if (target === `${SUBSCRIPTION_RESOURCE}/models`) return modelResponse();
    if (target !== `${SUBSCRIPTION_ISSUER}/api/accounts/oauth/token`)
      throw new Error('Unexpected fixture endpoint');
    const form = formBody(init);
    if (form.get('grant_type') === 'refresh_token') {
      if (refreshResponse) return refreshResponse();
      return json({
        access_token: 'refreshed-access',
        refresh_token: `rotated-${String(++calls)}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: GRANT,
      });
    }
    if (tokenResponse) return tokenResponse();
    return json({
      access_token: `access-${String(++calls)}`,
      refresh_token: `refresh-${String(calls)}`,
      id_token: await mintClaims(),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: GRANT,
      earliest_refresh_at: Math.floor(currentTime / 1000) + 60,
      ...tokens,
    });
  };
  const session: OpenAiSubscriptionSession = createOpenAiSubscriptionSession({
    store: storeOverride ?? store,
    hosting: 'local',
    fetch: transport as typeof fetch,
    now: () => currentTime,
    timeoutMs: 2000,
  });
  const open = async (
    value: string,
    callback: Record<string, string | undefined> = {},
  ) => {
    authorization = new URL(value);
    const uri = new URL(
      present(authorization.searchParams.get('redirect_uri')),
    );
    uri.search = new URLSearchParams({
      state: present(authorization.searchParams.get('state')),
      code: 'single-use-code',
      client_id: clientId,
      ...Object.fromEntries(
        Object.entries(callback).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    }).toString();
    for (const [key, value] of Object.entries(callback)) {
      if (value === undefined) uri.searchParams.delete(key);
    }
    const response = await fetch(uri);
    await response.text();
  };
  return {
    store,
    session,
    transport,
    requests,
    identityOverrides,
    tokens,
    open,
    mint,
    get authorization() {
      return present(authorization);
    },
    set clientId(value: string) {
      clientId = value;
    },
    set subject(value: string) {
      subject = value;
    },
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
    },
    set discovery(value: unknown) {
      discoveryValue = value;
    },
    set refresh(value: () => Promise<Response> | Response) {
      refreshResponse = value;
    },
    set codeExchange(value: () => Promise<Response> | Response) {
      tokenResponse = value;
    },
    set models(value: () => Response) {
      modelResponse = value;
    },
    set revoke(value: () => Response) {
      revokeResponse = value;
    },
    rotate() {
      signKey = () => otherKey;
      kid = 'rotated';
      keys = () => [otherPublicKey];
    },
    wrongSignature() {
      signKey = () => otherKey;
    },
  };
}
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}
export function present<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error('Missing fixture value');
  return value;
}
export function formBody(init: RequestInit | undefined): URLSearchParams {
  if (init?.body instanceof URLSearchParams) return init.body;
  return new URLSearchParams();
}
