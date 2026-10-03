import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createOpenAiSubscriptionFileStore } from './subscription-store.js';
import {
  createOpenAiSubscriptionSession,
  type OpenAiSubscriptionSessionOptions,
} from './subscription-session.js';
import { OpenAiSubscriptionAuthError } from './subscription-auth-types.js';
import {
  DISCOVERY,
  GRANT,
  harness,
  json,
  present,
  formBody,
  deferred,
  initializeSubscriptionFixtures,
} from '../../test/subscription-fixtures.js';
beforeAll(initializeSubscriptionFixtures);
describe('subscription lifecycle', () => {
  it('rebuilds an opener exception instead of retaining its modified message, hint or cause', async () => {
    const fixture = harness();
    const unsafe = new OpenAiSubscriptionAuthError('access_denied');
    unsafe.message =
      'https://auth.openai.com/authorize?id_token_hint=private-token-fixture';
    Object.assign(unsafe, {
      cause: new Error('private-token-fixture'),
      token: 'private-token-fixture',
    });
    let caught: unknown;
    try {
      await fixture.session.signIn({
        openAuthorizationUrl: () => {
          throw unsafe;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'access_denied',
      message: 'openai subscription authentication: access_denied',
    });
    expect(caught).not.toBe(unsafe);
    expect(caught).not.toHaveProperty('cause');
    expect(caught).not.toHaveProperty('token');
    expect(JSON.stringify(caught)).not.toContain('private-token-fixture');
  });

  it.each([
    'listAccounts',
    'selectAccount',
    'signOut',
    'resolveAccessToken',
    'listModels',
    'signIn',
  ] as const)(
    'sanitizes custom-store errors at the public %s boundary',
    async (method) => {
      for (const malformed of [
        'message-and-cause',
        'unknown-code',
        'throwing-code-getter',
      ] as const) {
        const unsafe = new OpenAiSubscriptionAuthError('storage_locked');
        unsafe.message = 'private-token-fixture';
        Object.assign(unsafe, {
          cause: new Error('private-token-fixture'),
          token: 'private-token-fixture',
        });
        if (malformed === 'unknown-code')
          Object.defineProperty(unsafe, 'code', {
            value: 'private-token-fixture',
          });
        if (malformed === 'throwing-code-getter')
          Object.defineProperty(unsafe, 'code', {
            get() {
              throw new Error('private-token-fixture');
            },
          });
        const session = createOpenAiSubscriptionSession({
          hosting: 'local',
          store: { transaction: () => Promise.reject(unsafe) },
        });
        const calls = {
          listAccounts: () => session.listAccounts(),
          selectAccount: () => session.selectAccount('opaque-key'),
          signOut: () => session.signOut(),
          resolveAccessToken: () => session.resolveAccessToken(),
          listModels: () => session.listModels(),
          signIn: () =>
            session.signIn({ openAuthorizationUrl: () => undefined }),
        };
        let caught: unknown;
        try {
          await calls[method]();
        } catch (error) {
          caught = error;
        }
        const fallback = ['listAccounts', 'selectAccount', 'signOut'].includes(
          method,
        )
          ? 'storage_unavailable'
          : 'transport_failed';
        const expected =
          malformed === 'message-and-cause'
            ? 'storage_locked'
            : malformed === 'throwing-code-getter'
              ? fallback
              : 'transport_failed';
        expect(caught).toMatchObject({
          code: expected,
          message: `openai subscription authentication: ${expected}`,
        });
        expect(caught).not.toBe(unsafe);
        expect(caught).not.toHaveProperty('cause');
        expect(caught).not.toHaveProperty('token');
        expect(JSON.stringify(caught)).not.toContain('private-token-fixture');
      }
    },
  );
  it('bounds a non-cooperative browser opener, closes its listener and preserves existing credentials', async () => {
    const fixture = harness();
    await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
    const before = structuredClone(fixture.store.state);
    const session = createOpenAiSubscriptionSession({
      store: fixture.store,
      hosting: 'self-hosted',
      fetch: fixture.transport as typeof fetch,
      now: () => fixture.currentTime,
      timeoutMs: 30,
    });
    let redirectUri = '';
    await expect(
      session.signIn({
        openAuthorizationUrl: (url) => {
          redirectUri = present(new URL(url).searchParams.get('redirect_uri'));
          return new Promise(() => undefined);
        },
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
    await expect(fetch(redirectUri)).rejects.toThrow();
    expect(fixture.store.state).toEqual(before);
  });
  it('bounds a non-cooperative fetch, redacts underlying errors, and preserves credentials', async () => {
    const fixture = harness();
    await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
    fixture.currentTime += 3600000;
    const before = structuredClone(fixture.store.state);
    const transport = jest.fn(() => new Promise<Response>(() => undefined));
    const session = createOpenAiSubscriptionSession({
      store: fixture.store,
      hosting: 'local',
      fetch: transport as typeof fetch,
      now: () => fixture.currentTime,
      timeoutMs: 30,
    });
    await expect(session.resolveAccessToken()).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(fixture.store.state).toEqual(before);
    const failed = createOpenAiSubscriptionSession({
      store: fixture.store,
      hosting: 'local',
      fetch: () => Promise.reject(new Error('secret-token-and-code')),
      now: () => fixture.currentTime,
    });
    let caught: unknown;
    try {
      await failed.resolveAccessToken();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'transport_failed' });
    expect(String(caught)).not.toContain('secret-token-and-code');
    expect(caught).not.toHaveProperty('cause');
  });
  it('bounds a stalled response body and cancels its reader', async () => {
    const fixture = harness();
    await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
    fixture.currentTime += 3600000;
    const cancel = jest.fn();
    const transport = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
            cancel,
          }),
        ),
      );
    const session = createOpenAiSubscriptionSession({
      store: fixture.store,
      hosting: 'local',
      fetch: transport as typeof fetch,
      now: () => fixture.currentTime,
      timeoutMs: 30,
    });
    await expect(session.resolveAccessToken()).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(cancel).toHaveBeenCalled();
    await fixture.store.transaction(() => Promise.resolve());
    expect(present(fixture.store.state.accounts[0]).tokens).toBeUndefined();
    await expect(session.resolveAccessToken()).rejects.toMatchObject({
      code: 'reauthorization_required',
    });
  });
  it('honors caller cancellation before touching credentials or network', async () => {
    const fixture = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fixture.session.signIn({
        openAuthorizationUrl: fixture.open,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    await expect(
      fixture.session.resolveAccessToken({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(fixture.requests).toHaveLength(0);
  });
  it.each([
    { hosting: 'hosted' },
    { timeoutMs: 0 },
    { timeoutMs: 600001 },
    { timeoutMs: 1.5 },
    { fetch: null },
    { store: null },
    { now: null },
  ])('rejects unsupported session configuration', (overrides) => {
    const fixture = harness();
    expect(() =>
      createOpenAiSubscriptionSession({
        store: fixture.store,
        hosting: 'local',
        ...overrides,
      } as unknown as OpenAiSubscriptionSessionOptions),
    ).toThrow(OpenAiSubscriptionAuthError);
  });
  it('rejects unsupported sign-in options and invalid clock values', async () => {
    const fixture = harness();
    await expect(
      fixture.session.signIn({ openAuthorizationUrl: null } as never),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    await expect(
      fixture.session.signIn({
        openAuthorizationUrl: fixture.open,
        enablePlanUsage: 'yes',
      } as never),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    fixture.currentTime = NaN;
    await expect(
      fixture.session.signIn({ openAuthorizationUrl: fixture.open }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
  });
  describe('subscription transaction races with the private filesystem store', () => {
    it.each(['sign-out', 'refresh'] as const)(
      'serializes returning authorization with concurrent %s across store instances',
      async (action) => {
        const temporary = await mkdtemp(
          join(tmpdir(), 'movement-auth-session-'),
        );
        try {
          const firstStore = createOpenAiSubscriptionFileStore({
            directory: join(temporary, 'accounts'),
          });
          const secondStore = createOpenAiSubscriptionFileStore({
            directory: join(temporary, 'accounts'),
          });
          const fixture = harness(firstStore);
          const account = await fixture.session.signIn({
            openAuthorizationUrl: fixture.open,
          });
          fixture.currentTime += 3600000;
          const second = createOpenAiSubscriptionSession({
            store: secondStore,
            hosting: 'local',
            fetch: fixture.transport as typeof fetch,
            now: () => fixture.currentTime,
            timeoutMs: 2000,
          });
          const browserStarted = deferred();
          const releaseBrowser = deferred();
          const signingIn = fixture.session.signIn({
            accountKey: account.key,
            openAuthorizationUrl: async (url) => {
              browserStarted.resolve();
              await releaseBrowser.promise;
              await fixture.open(url);
            },
          });
          await browserStarted.promise;
          let completed = false;
          const contender = (
            action === 'sign-out'
              ? second.signOut()
              : second.resolveAccessToken()
          ).then((value) => {
            completed = true;
            return value;
          });
          await new Promise<void>((resolve) => setTimeout(resolve, 40));
          expect(completed).toBe(false);
          expect(
            fixture.requests.filter(
              (entry) =>
                formBody(entry.init).get('grant_type') === 'refresh_token',
            ),
          ).toHaveLength(0);
          releaseBrowser.resolve();
          await signingIn;
          const result = await contender;
          const saved = await firstStore.transaction((state) =>
            Promise.resolve(structuredClone(state)),
          );
          if (action === 'sign-out') {
            expect(result).toEqual({ remoteRevocationConfirmed: true });
            expect(saved.accounts[0]?.tokens).toBeUndefined();
            const revocation = present(
              fixture.requests.find(
                (entry) => entry.url === DISCOVERY.revocation_endpoint,
              ),
            );
            expect(formBody(revocation.init).get('token')).toBe('refresh-2');
          } else {
            expect(result).toMatchObject({ accessToken: 'access-2' });
            expect(saved.accounts[0]?.tokens?.refreshToken).toBe('refresh-2');
            expect(
              fixture.requests.filter(
                (entry) =>
                  formBody(entry.init).get('grant_type') === 'refresh_token',
              ),
            ).toHaveLength(0);
          }
          expect(saved.activeAccountKey).toBe(account.key);
          expect(saved.accounts).toHaveLength(1);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      },
    );
    it('rejects new registration at account capacity before opening a browser or network', async () => {
      const fixture = harness();
      const account = await fixture.session.signIn({
        openAuthorizationUrl: fixture.open,
      });
      const source = present(fixture.store.state.accounts[0]);
      fixture.store.state.accounts = Array.from({ length: 32 }, (_, index) => ({
        ...structuredClone(source),
        key: `fixture-${String(index)}`,
      }));
      const open = jest.fn();
      const calls = fixture.requests.length;
      await expect(
        fixture.session.signIn({ openAuthorizationUrl: open }),
      ).rejects.toMatchObject({ code: 'invalid_configuration' });
      expect(open).not.toHaveBeenCalled();
      expect(fixture.requests).toHaveLength(calls);
      expect(fixture.store.state.activeAccountKey).toBe(account.key);
    });
    it('checks a monotonic deadline even when a synchronous custom transport starves the timer', async () => {
      const fixture = harness();
      await fixture.session.signIn({ openAuthorizationUrl: fixture.open });
      fixture.currentTime += 3600000;
      const before = structuredClone(fixture.store.state);
      const session = createOpenAiSubscriptionSession({
        store: fixture.store,
        hosting: 'local',
        now: () => fixture.currentTime,
        timeoutMs: 10,
        fetch: () => {
          const started = performance.now();
          while (performance.now() - started < 25) {
            /* Deliberately starve timer execution. */
          }
          return Promise.resolve(
            json({
              access_token: 'late-access',
              refresh_token: 'late-refresh',
              token_type: 'Bearer',
              expires_in: 3600,
              scope: GRANT,
            }),
          );
        },
      });
      await expect(session.resolveAccessToken()).rejects.toMatchObject({
        code: 'timeout',
      });
      expect(fixture.store.state).toEqual(before);
    });
  });
});
