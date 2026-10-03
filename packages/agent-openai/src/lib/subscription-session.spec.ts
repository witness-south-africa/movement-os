import { createHash } from 'node:crypto';
import {
  SUBSCRIPTION_ISSUER,
  SUBSCRIPTION_RESOURCE,
} from './subscription-auth-types.js';
import {
  BASE_TIME,
  DISCOVERY,
  GRANT,
  harness,
  json,
  present,
  formBody,
  initializeSubscriptionFixtures,
} from '../../test/subscription-fixtures.js';
beforeAll(initializeSubscriptionFixtures);
describe('OpenAI subscription sign-in and identity binding', () => {
  it('runs fresh PKCE/nonce/state with a live loopback, exact exchange URI and safe metadata', async () => {
    const fixture = harness();
    const account = await fixture.session.signIn({
      openAuthorizationUrl: fixture.open,
    });
    const request = present(
      fixture.requests.find((entry) => entry.url === DISCOVERY.token_endpoint),
    );
    const form = formBody(request.init);
    expect(form.get('client_id')).toBe('issued-client-1');
    expect(form.get('redirect_uri')).toBe(
      fixture.authorization.searchParams.get('redirect_uri'),
    );
    expect(form.get('resource')).toBe(SUBSCRIPTION_RESOURCE);
    expect(form.has('client_secret')).toBe(false);
    expect(fixture.authorization.searchParams.get('client_id')).toBe(
      'dynamic_agent_client',
    );
    expect(fixture.authorization.searchParams.get('agent_name_hint')).toBe(
      'Movement OS',
    );
    expect(fixture.authorization.searchParams.get('ext_agent_host_id')).toBe(
      fixture.store.state.hostId,
    );
    expect(fixture.authorization.searchParams.get('code_challenge')).toBe(
      createHash('sha256')
        .update(present(form.get('code_verifier')))
        .digest('base64url'),
    );
    expect(
      fixture.authorization.searchParams.get('code_challenge_method'),
    ).toBe('S256');
    expect(fixture.authorization.searchParams.get('state')).not.toBe(
      fixture.authorization.searchParams.get('nonce'),
    );
    expect(account).toMatchObject({
      active: true,
      signedIn: true,
      planUsageAuthorized: true,
      email: 'same@example.test',
    });
    expect(JSON.stringify(account)).not.toMatch(
      /access-1|refresh-1|idToken|clientId|subject-1/u,
    );
    expect(fixture.store.state.pendingClientId).toBeUndefined();
    expect(
      present(present(fixture.store.state.accounts[0]).tokens)
        .earliestRefreshAt,
    ).toBe(BASE_TIME + 60000);
    await expect(fixture.session.resolveAccessToken()).resolves.toEqual({
      accessMode: 'subscription',
      accessToken: 'access-1',
      planUsageAuthorized: true,
    });
    for (const entry of fixture.requests)
      expect(entry.init).toMatchObject({
        redirect: 'error',
        cache: 'no-store',
      });
  });
  it('reuses the same account/client/host and retains hints, with fresh values and consent only when explicit', async () => {
    const fixture = harness();
    const first = await fixture.session.signIn({
      openAuthorizationUrl: fixture.open,
    });
    const initialUrl = fixture.authorization;
    const retainedToken = present(
      present(fixture.store.state.accounts[0]).tokens,
    ).idToken;
    await fixture.session.signIn({
      accountKey: first.key,
      openAuthorizationUrl: (url) =>
        fixture.open(url, { client_id: undefined }),
    });
    expect(fixture.authorization.searchParams.get('client_id')).toBe(
      'issued-client-1',
    );
    expect(
      fixture.authorization.searchParams.get('agent_name_hint'),
    ).toBeNull();
    expect(fixture.authorization.searchParams.get('id_token_hint')).toBe(
      retainedToken,
    );
    expect(fixture.authorization.searchParams.get('login_hint')).toBe(
      'same@example.test',
    );
    expect(fixture.authorization.searchParams.get('prompt')).toBeNull();
    expect(fixture.authorization.searchParams.get('state')).not.toBe(
      initialUrl.searchParams.get('state'),
    );
    expect(fixture.authorization.searchParams.get('nonce')).not.toBe(
      initialUrl.searchParams.get('nonce'),
    );
    await fixture.session.signIn({
      accountKey: first.key,
      enablePlanUsage: true,
      openAuthorizationUrl: fixture.open,
    });
    expect(fixture.authorization.searchParams.get('prompt')).toBe('consent');
    expect(fixture.authorization.searchParams.has('force_reconsent')).toBe(
      false,
    );
    expect(fixture.store.state.accounts).toHaveLength(1);
  });
  it('keeps valid identity without a direct grant and blocks credentials/catalogue before network', async () => {
    const fixture = harness();
    fixture.tokens.scope = 'openid profile email';
    const account = await fixture.session.signIn({
      openAuthorizationUrl: (url) => fixture.open(url, { scope: GRANT }),
    });
    expect(account).toMatchObject({
      signedIn: true,
      planUsageAuthorized: false,
    });
    const count = fixture.requests.length;
    await expect(fixture.session.resolveAccessToken()).rejects.toMatchObject({
      code: 'plan_not_authorized',
    });
    await expect(fixture.session.listModels()).rejects.toMatchObject({
      code: 'plan_not_authorized',
    });
    expect(fixture.requests).toHaveLength(count);
    fixture.tokens.scope = GRANT;
    await fixture.session.signIn({
      accountKey: account.key,
      enablePlanUsage: true,
      openAuthorizationUrl: fixture.open,
    });
    await expect(fixture.session.resolveAccessToken()).resolves.toMatchObject({
      planUsageAuthorized: true,
    });
  });
  it('keeps same-email registrations separate and refreshes catalogue on account switches', async () => {
    const fixture = harness();
    const first = await fixture.session.signIn({
      openAuthorizationUrl: fixture.open,
    });
    fixture.clientId = 'issued-client-2';
    fixture.subject = 'subject-2';
    const second = await fixture.session.signIn({
      openAuthorizationUrl: fixture.open,
    });
    expect(first.key).not.toBe(second.key);
    expect(first.label).not.toBe(second.label);
    const accounts = await fixture.session.listAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts.map((account) => account.email)).toEqual([
      'same@example.test',
      'same@example.test',
    ]);
    expect(accounts.map((account) => account.active)).toEqual([false, true]);
    expect(await fixture.session.listModels()).toEqual([
      { slug: 'model-second', displayName: 'Second' },
      { slug: 'model-first', displayName: 'First' },
    ]);
    await fixture.session.selectAccount(first.key);
    await fixture.session.listModels();
    const modelCalls = fixture.requests.filter((entry) =>
      entry.url.endsWith('/models'),
    );
    expect(
      modelCalls.map(
        (entry) =>
          (entry.init?.headers as Record<string, string>).authorization,
      ),
    ).toEqual(['Bearer access-2', 'Bearer access-1']);
  });
  it.each([
    ['wrong issuer', { iss: 'https://evil.test' }],
    ['wrong audience', { aud: 'other-client' }],
    ['wrong nonce', { nonce: 'other-attempt' }],
    ['expired ID token', { exp: Math.floor(BASE_TIME / 1000) - 6 }],
    ['future issued-at', { iat: Math.floor(BASE_TIME / 1000) + 6 }],
    ['missing issued-at', { iat: undefined }],
    ['missing subject', { sub: undefined }],
    ['empty subject', { sub: '' }],
    ['wrong authorized party', { azp: 'other-client' }],
    [
      'ambiguous multiple audiences',
      { aud: ['issued-client-1', 'other-client'] },
    ],
  ])('rejects signed identity with %s', async (_, claims) => {
    const fixture = harness();
    Object.assign(fixture.identityOverrides, claims);
    await expect(
      fixture.session.signIn({ openAuthorizationUrl: fixture.open }),
    ).rejects.toMatchObject({ code: 'invalid_identity' });
    expect(fixture.store.state.accounts).toEqual([]);
    expect(fixture.store.state.activeAccountKey).toBeUndefined();
  });
  it('rejects a valid-looking token with the wrong signature', async () => {
    const fixture = harness();
    fixture.wrongSignature();
    await expect(
      fixture.session.signIn({ openAuthorizationUrl: fixture.open }),
    ).rejects.toMatchObject({ code: 'invalid_identity' });
    expect(fixture.store.state.accounts).toEqual([]);
  });
  it('does not overwrite active credentials on returning wrong-subject or client callback', async () => {
    const fixture = harness();
    const original = await fixture.session.signIn({
      openAuthorizationUrl: fixture.open,
    });
    const saved = structuredClone(fixture.store.state);
    fixture.subject = 'unrelated-subject';
    await expect(
      fixture.session.signIn({
        accountKey: original.key,
        openAuthorizationUrl: fixture.open,
      }),
    ).rejects.toMatchObject({ code: 'invalid_identity' });
    expect(fixture.store.state).toEqual(saved);
    const count = fixture.requests.length;
    await expect(
      fixture.session.signIn({
        accountKey: original.key,
        openAuthorizationUrl: (url) =>
          fixture.open(url, { client_id: 'unrelated-client' }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_callback' });
    expect(fixture.requests).toHaveLength(count);
    expect(fixture.store.state).toEqual(saved);
  });
  it.each([
    ['state', { state: 'wrong' }, 'invalid_callback'],
    [
      'declined consent',
      { error: 'access_denied', code: undefined },
      'access_denied',
    ],
    ['missing issued client', { client_id: undefined }, 'invalid_callback'],
    [
      'dynamic client',
      { client_id: 'dynamic_agent_client' },
      'invalid_callback',
    ],
  ])('rejects %s before token exchange', async (_, callback, code) => {
    const fixture = harness();
    await expect(
      fixture.session.signIn({
        openAuthorizationUrl: (url) => fixture.open(url, callback),
      }),
    ).rejects.toMatchObject({ code });
    expect(fixture.requests).toHaveLength(0);
  });
  it('retains unverified issued registration after failed code exchange and reuses it without granting access', async () => {
    const fixture = harness();
    fixture.codeExchange = () =>
      json({ error: 'invalid_grant', error_description: 'secret-code' }, 400);
    await expect(
      fixture.session.signIn({ openAuthorizationUrl: fixture.open }),
    ).rejects.toMatchObject({ code: 'reauthorization_required' });
    expect(fixture.store.state.pendingClientId).toBe('issued-client-1');
    expect(await fixture.session.listAccounts()).toEqual([]);
    await expect(fixture.session.resolveAccessToken()).rejects.toMatchObject({
      code: 'account_not_found',
    });
    fixture.codeExchange = async () =>
      json({
        access_token: 'recovered',
        refresh_token: 'new-refresh',
        id_token: await fixture.mint(),
        token_type: 'Bearer',
        expires_in: 3600,
        scope: GRANT,
      });
    await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
    expect(fixture.authorization.searchParams.get('client_id')).toBe(
      'issued-client-1',
    );
    expect(fixture.authorization.searchParams.has('agent_name_hint')).toBe(
      false,
    );
    expect(fixture.authorization.searchParams.has('id_token_hint')).toBe(false);
    expect(fixture.store.state.pendingClientId).toBeUndefined();
  });
  it.each([
    ['milliseconds', BASE_TIME + 60000],
    ['relative seconds', 60],
    ['numeric string', String(BASE_TIME / 1000)],
    ['past timestamp', BASE_TIME / 1000 - 1],
    ['outside lifetime', BASE_TIME / 1000 + 3601],
    ['fractional', BASE_TIME / 1000 + 0.5],
  ])('rejects ambiguous earliest_refresh_at %s', async (_, value) => {
    const fixture = harness();
    fixture.tokens.earliest_refresh_at = value;
    await expect(
      fixture.session.signIn({ openAuthorizationUrl: fixture.open }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fixture.store.state.accounts).toEqual([]);
  });
  it.each([
    ['wrong type', { token_type: 'MAC' }],
    ['empty bearer', { access_token: '' }],
    ['header injection', { access_token: 'secret\r\nInjected:value' }],
    ['missing ID', { id_token: undefined }],
    ['nonpositive lifetime', { expires_in: 0 }],
    ['unbounded lifetime', { expires_in: 86401 }],
    ['invalid scope', { scope: 'openid\tchatgpt.tokens.use.direct' }],
    ['invalid refresh', { refresh_token: '' }],
  ])('rejects malformed token response %s', async (_, overrides) => {
    const fixture = harness();
    Object.assign(fixture.tokens, overrides);
    await expect(
      fixture.session.signIn({ openAuthorizationUrl: fixture.open }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fixture.store.state.accounts).toEqual([]);
  });
  it.each([
    ['issuer', { issuer: 'https://evil.test' }],
    [
      'authorization endpoint',
      { authorization_endpoint: 'https://evil.test/authorize' },
    ],
    ['token endpoint', { token_endpoint: 'https://evil.test/token' }],
    ['JWKS endpoint', { jwks_uri: 'https://evil.test/keys' }],
    [
      'unsigned algorithms',
      { id_token_signing_alg_values_supported: ['none', 'HS256'] },
    ],
    [
      'invalid algorithm metadata',
      { id_token_signing_alg_values_supported: 'RS256' },
    ],
    ['foreign revocation', { revocation_endpoint: 'https://evil.test/revoke' }],
    [
      'revocation query',
      { revocation_endpoint: `${SUBSCRIPTION_ISSUER}/revoke?token=secret` },
    ],
  ])('rejects untrusted discovery %s', async (_, overrides) => {
    const fixture = harness();
    fixture.discovery = { ...DISCOVERY, ...overrides };
    await expect(
      fixture.session.signIn({ openAuthorizationUrl: fixture.open }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(
      fixture.requests.every(
        (entry) => new URL(entry.url).origin === SUBSCRIPTION_ISSUER,
      ),
    ).toBe(true);
  });
  it('caches verification keys and handles unknown-kid rotation after cooldown', async () => {
    const fixture = harness();
    const account = await fixture.session.signIn({
      openAuthorizationUrl: fixture.open,
    });
    expect(
      fixture.requests.filter((entry) => entry.url === DISCOVERY.jwks_uri),
    ).toHaveLength(1);
    await fixture.session.signIn({
      accountKey: account.key,
      openAuthorizationUrl: fixture.open,
    });
    expect(
      fixture.requests.filter((entry) => entry.url === DISCOVERY.jwks_uri),
    ).toHaveLength(1);
    fixture.rotate();
    await expect(
      fixture.session.signIn({
        accountKey: account.key,
        openAuthorizationUrl: fixture.open,
      }),
    ).rejects.toMatchObject({ code: 'invalid_identity' });
    expect(
      fixture.requests.filter((entry) => entry.url === DISCOVERY.jwks_uri),
    ).toHaveLength(1);
    fixture.currentTime += 30000;
    await fixture.session.signIn({
      accountKey: account.key,
      openAuthorizationUrl: fixture.open,
    });
    expect(
      fixture.requests.filter((entry) => entry.url === DISCOVERY.jwks_uri),
    ).toHaveLength(2);
    fixture.currentTime += 300000;
    await fixture.session.signIn({
      accountKey: account.key,
      openAuthorizationUrl: fixture.open,
    });
    expect(
      fixture.requests.filter((entry) => entry.url === DISCOVERY.jwks_uri),
    ).toHaveLength(3);
  });
});
