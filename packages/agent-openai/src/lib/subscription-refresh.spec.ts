import {
  GRANT,
  harness,
  json,
  present,
  formBody,
  initializeSubscriptionFixtures,
} from '../../test/subscription-fixtures.js';
beforeAll(initializeSubscriptionFixtures);
describe('subscription refresh', () => {
  it('serializes concurrent expired-token refreshes and atomically stores the replacement', async () => {
    const fixture = harness();
    await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
    fixture.currentTime += 3600000;
    const [first, second] = await Promise.all([
      fixture.session.resolveAccessToken(),
      fixture.session.resolveAccessToken(),
    ]);
    expect(first).toEqual(second);
    expect(first.accessToken).toBe('refreshed-access');
    const refreshed = fixture.requests.filter(
      (entry) => formBody(entry.init).get('grant_type') === 'refresh_token',
    );
    expect(refreshed).toHaveLength(1);
    expect(formBody(present(refreshed[0]).init).get('refresh_token')).toBe(
      'refresh-1',
    );
    expect(formBody(present(refreshed[0]).init).has('scope')).toBe(false);
    expect(
      present(present(fixture.store.state.accounts[0]).tokens).refreshToken,
    ).toBe('rotated-2');
    fixture.currentTime += 3600000;
    await fixture.session.resolveAccessToken();
    const last = present(fixture.requests.at(-1));
    expect(formBody(last.init).get('refresh_token')).toBe('rotated-2');
  });
  it.each([
    'invalid_grant',
    'invalid_refresh_token',
    'token_expired',
    'refresh_token_expired',
    'refresh_token_invalidated',
    'refresh_token_reused',
  ])(
    'commits terminal %s invalidation for only the selected account',
    async (error) => {
      const fixture = harness();
      const first = await fixture.session.signIn({
        openAuthorizationUrl: fixture.open,
      });
      fixture.clientId = 'issued-client-2';
      fixture.subject = 'subject-2';
      await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
      await fixture.session.selectAccount(first.key);
      fixture.currentTime += 3600000;
      fixture.refresh = () =>
        json({ error, error_description: 'secret-refresh' }, 400);
      await expect(fixture.session.resolveAccessToken()).rejects.toMatchObject({
        code: 'reauthorization_required',
      });
      expect(present(fixture.store.state.accounts[0]).tokens).toBeUndefined();
      expect(present(fixture.store.state.accounts[0]).clientId).toBe(
        'issued-client-1',
      );
      expect(present(fixture.store.state.accounts[1]).tokens).toBeDefined();
    },
  );
  it.each([500, 503, 429, 400])(
    'preserves credentials for temporary/invalid-client HTTP %i',
    async (status) => {
      const fixture = harness();
      await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
      const before = structuredClone(fixture.store.state);
      fixture.currentTime += 3600000;
      fixture.refresh = () =>
        json(
          {
            error: status === 400 ? 'invalid_client' : 'invalid_grant',
            details: 'secret-refresh',
          },
          status,
        );
      await expect(fixture.session.resolveAccessToken()).rejects.toMatchObject({
        code: 'transport_failed',
      });
      expect(fixture.store.state).toEqual(before);
    },
  );
  it('stores grant loss on refresh and fails closed before catalogue/inference', async () => {
    const fixture = harness();
    await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
    fixture.currentTime += 3600000;
    fixture.refresh = () =>
      json({
        access_token: 'identity-only-access',
        refresh_token: 'replacement',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile email',
      });
    await expect(fixture.session.listModels()).rejects.toMatchObject({
      code: 'plan_not_authorized',
    });
    expect(
      present(present(fixture.store.state.accounts[0]).tokens).refreshToken,
    ).toBe('replacement');
    expect(
      fixture.requests.some((entry) => entry.url.endsWith('/models')),
    ).toBe(false);
    expect(
      present((await fixture.session.listAccounts())[0]).planUsageAuthorized,
    ).toBe(false);
  });
  it('retains a verified replacement after a subsequent model request fails', async () => {
    const fixture = harness();
    await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
    fixture.currentTime += 3600000;
    fixture.models = () => json({ error: 'unavailable' }, 503);
    await expect(fixture.session.listModels()).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(
      present(present(fixture.store.state.accounts[0]).tokens).refreshToken,
    ).toBe('rotated-2');
    await fixture.session.resolveAccessToken();
    expect(
      fixture.requests.filter(
        (entry) => formBody(entry.init).get('grant_type') === 'refresh_token',
      ),
    ).toHaveLength(1);
  });
  it('validates new refresh ID tokens against the retained subject/client', async () => {
    const fixture = harness();
    await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
    fixture.currentTime += 3600000;
    fixture.refresh = async () =>
      json({
        access_token: 'renewed',
        refresh_token: 'replacement',
        id_token: await fixture.mint({}, undefined),
        token_type: 'Bearer',
        expires_in: 3600,
        scope: GRANT,
      });
    await expect(fixture.session.resolveAccessToken()).resolves.toMatchObject({
      accessToken: 'renewed',
    });
    fixture.currentTime += 3600000;
    fixture.subject = 'other-subject';
    fixture.refresh = async () =>
      json({
        access_token: 'wrong-identity',
        refresh_token: 'replacement-2',
        id_token: await fixture.mint(),
        token_type: 'Bearer',
        expires_in: 3600,
        scope: GRANT,
      });
    const before = structuredClone(fixture.store.state);
    await expect(fixture.session.resolveAccessToken()).rejects.toMatchObject({
      code: 'invalid_identity',
    });
    delete present(before.accounts[0]).tokens;
    expect(fixture.store.state).toEqual(before);
    const calls = fixture.requests.length;
    await expect(fixture.session.resolveAccessToken()).rejects.toMatchObject({
      code: 'reauthorization_required',
    });
    expect(fixture.requests).toHaveLength(calls);
  });
  it('requires a rotating refresh replacement', async () => {
    const fixture = harness();
    await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
    fixture.currentTime += 3600000;
    fixture.refresh = () =>
      json({
        access_token: 'renewed',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: GRANT,
      });
    await expect(fixture.session.resolveAccessToken()).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(present(fixture.store.state.accounts[0]).tokens).toBeUndefined();
    const calls = fixture.requests.length;
    await expect(fixture.session.resolveAccessToken()).rejects.toMatchObject({
      code: 'reauthorization_required',
    });
    expect(fixture.requests).toHaveLength(calls);
  });
  it('requires reauthorization for expired nonrenewable credentials and commits their removal', async () => {
    const fixture = harness();
    fixture.tokens.refresh_token = undefined;
    await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
    fixture.currentTime += 3600000;
    await expect(fixture.session.resolveAccessToken()).rejects.toMatchObject({
      code: 'reauthorization_required',
    });
    expect(present(fixture.store.state.accounts[0]).tokens).toBeUndefined();
  });
  it.each([
    () => new Response('not-json'),
    () => new Response('{}', { headers: { 'content-length': '1048577' } }),
    () => new Response('{}'.repeat(524289)),
    () => new Response(new Uint8Array([255, 255])),
  ])('rejects invalid/unbounded endpoint bodies', async (response) => {
    const fixture = harness();
    await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
    fixture.currentTime += 3600000;
    fixture.refresh = response;
    await expect(fixture.session.resolveAccessToken()).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(present(fixture.store.state.accounts[0]).tokens).toBeUndefined();
    const calls = fixture.requests.length;
    await expect(fixture.session.resolveAccessToken()).rejects.toMatchObject({
      code: 'reauthorization_required',
    });
    expect(fixture.requests).toHaveLength(calls);
  });
  describe('confirmed rotation recovery', () => {
    it('invalidates only the affected session after a successful unusable replacement', async () => {
      const fixture = harness();
      const selected = await fixture.session.signIn({
        openAuthorizationUrl: fixture.open,
      });
      fixture.clientId = 'issued-client-2';
      fixture.subject = 'subject-2';
      await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
      await fixture.session.selectAccount(selected.key);
      const before = structuredClone(fixture.store.state);
      fixture.currentTime += 3600000;
      fixture.refresh = () =>
        json({
          access_token: 'new-access',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: GRANT,
        });
      await expect(fixture.session.resolveAccessToken()).rejects.toMatchObject({
        code: 'invalid_response',
      });
      delete present(before.accounts[0]).tokens;
      expect(fixture.store.state).toEqual(before);
      const requests = fixture.requests.length;
      await expect(fixture.session.resolveAccessToken()).rejects.toMatchObject({
        code: 'reauthorization_required',
      });
      expect(fixture.requests).toHaveLength(requests);
    });
    it.each(['foreign-origin', 'redirected', 'server-error'] as const)(
      'preserves credentials for unconfirmed success: %s',
      async (kind) => {
        const fixture = harness();
        await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
        const before = structuredClone(fixture.store.state);
        fixture.currentTime += 3600000;
        fixture.refresh = () => {
          const response = new Response('unreadable body', {
            status: kind === 'server-error' ? 503 : 200,
          });
          if (kind === 'foreign-origin')
            Object.defineProperty(response, 'url', {
              value: 'https://evil.test/token',
            });
          if (kind === 'redirected')
            Object.defineProperty(response, 'redirected', { value: true });
          return response;
        };
        await expect(
          fixture.session.resolveAccessToken(),
        ).rejects.toMatchObject({
          code: 'invalid_response',
        });
        expect(fixture.store.state).toEqual(before);
      },
    );
  });
});
