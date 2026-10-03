import { OpenAiSubscriptionAuthError } from './subscription-auth-types.js';
import {
  DISCOVERY,
  harness,
  json,
  present,
  formBody,
  initializeSubscriptionFixtures,
} from '../../test/subscription-fixtures.js';
beforeAll(initializeSubscriptionFixtures);
describe('subscription models', () => {
  it('rebuilds a decorated catalogue body error at the public boundary', async () => {
    const fixture = harness();
    await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
    const before = structuredClone(fixture.store.state);
    const unsafe = new OpenAiSubscriptionAuthError('invalid_response');
    unsafe.message = 'catalogue-private-token-fixture';
    Object.assign(unsafe, {
      cause: new Error('catalogue-private-token-fixture'),
      token: 'catalogue-private-token-fixture',
    });
    fixture.models = () => {
      const response = json({ models: [] });
      Object.defineProperty(response, 'body', {
        get() {
          throw unsafe;
        },
      });
      return response;
    };
    let caught: unknown;
    try {
      await fixture.session.listModels();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'invalid_response',
      message: 'openai subscription authentication: invalid_response',
    });
    expect(caught).not.toBe(unsafe);
    expect(caught).not.toHaveProperty('cause');
    expect(caught).not.toHaveProperty('token');
    expect(JSON.stringify(caught)).not.toContain(
      'catalogue-private-token-fixture',
    );
    expect(fixture.store.state).toEqual(before);
  });
  it.each([
    { models: 'wrong-shape' },
    { models: [null] },
    { models: [{ visibility: 'list', slug: '', display_name: 'Name' }] },
    {
      models: [
        { visibility: 'list', slug: 'model', display_name: 'Bad\nLabel' },
      ],
    },
  ])('rejects malformed model catalogue', async (response) => {
    const fixture = harness();
    await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
    fixture.models = () => json(response);
    await expect(fixture.session.listModels()).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
  it('revokes the renewable session before clearing tokens while retaining mapping and host', async () => {
    const fixture = harness();
    const account = await fixture.session.signIn({
      openAuthorizationUrl: fixture.open,
    });
    await expect(fixture.session.signOut()).resolves.toEqual({
      remoteRevocationConfirmed: true,
    });
    const revoke = present(
      fixture.requests.find(
        (entry) => entry.url === DISCOVERY.revocation_endpoint,
      ),
    );
    expect(formBody(revoke.init)).toEqual(
      new URLSearchParams({
        token: 'refresh-1',
        token_type_hint: 'refresh_token',
        client_id: 'issued-client-1',
      }),
    );
    expect(present(fixture.store.state.accounts[0]).tokens).toBeUndefined();
    expect((await fixture.session.listAccounts())[0]).toMatchObject({
      key: account.key,
      active: true,
      signedIn: false,
      planUsageAuthorized: false,
    });
    await expect(fixture.session.resolveAccessToken()).rejects.toMatchObject({
      code: 'reauthorization_required',
    });
    await fixture.session.signIn({
      accountKey: account.key,
      openAuthorizationUrl: fixture.open,
    });
    expect(fixture.authorization.searchParams.get('client_id')).toBe(
      'issued-client-1',
    );
    expect(fixture.authorization.searchParams.has('id_token_hint')).toBe(false);
  });
  it.each([500, 503, 400, 204])(
    'finishes local sign-out and truthfully reports unconfirmed revocation for HTTP %i',
    async (status) => {
      const fixture = harness();
      await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
      fixture.revoke = () => new Response(null, { status });
      await expect(fixture.session.signOut()).resolves.toEqual({
        remoteRevocationConfirmed: false,
      });
      expect(present(fixture.store.state.accounts[0]).tokens).toBeUndefined();
    },
  );
  it('can sign out one inactive account without affecting another', async () => {
    const fixture = harness();
    const first = await fixture.session.signIn({
      openAuthorizationUrl: fixture.open,
    });
    fixture.clientId = 'issued-client-2';
    fixture.subject = 'subject-2';
    const second = await fixture.session.signIn({
      openAuthorizationUrl: fixture.open,
    });
    await fixture.session.signOut({ accountKey: first.key });
    expect(fixture.store.state.activeAccountKey).toBe(second.key);
    expect(
      present(present(fixture.store.state.accounts[1]).tokens).accessToken,
    ).toBe('access-2');
  });
  it('clears locally even when revocation is missing or cancelled', async () => {
    const fixture = harness();
    fixture.discovery = { ...DISCOVERY, revocation_endpoint: undefined };
    await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
    await expect(fixture.session.signOut()).resolves.toEqual({
      remoteRevocationConfirmed: false,
    });
    await fixture.session.signIn({
      accountKey: present(fixture.store.state.accounts[0]).key,
      openAuthorizationUrl: fixture.open,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      fixture.session.signOut({ signal: controller.signal }),
    ).resolves.toEqual({ remoteRevocationConfirmed: false });
    expect(present(fixture.store.state.accounts[0]).tokens).toBeUndefined();
  });
  it('rejects missing/unknown accounts without changing selection', async () => {
    const fixture = harness();
    await expect(fixture.session.listModels()).rejects.toMatchObject({
      code: 'account_not_found',
    });
    await expect(
      fixture.session.selectAccount('missing'),
    ).rejects.toMatchObject({ code: 'account_not_found' });
    await expect(
      fixture.session.signIn({
        accountKey: 'missing',
        openAuthorizationUrl: fixture.open,
      }),
    ).rejects.toMatchObject({ code: 'account_not_found' });
    expect(fixture.requests).toHaveLength(0);
  });
});
