import {
  createOpenAiSubscriptionSession,
  OpenAiSubscriptionAuthError,
  type SubscriptionStore,
  type SubscriptionState,
  type SubscriptionAccountRecord,
} from '@wsa/agent-openai/subscription-auth';
import {
  runAcceptance,
  pinAccountStore,
  type BuildProvenance,
} from './runner.js';

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture');
  return value;
}
function bodyText(body: unknown): string {
  if (typeof body !== 'string')
    throw new Error('expected fixture request JSON');
  return body;
}

const provenance: BuildProvenance = {
  sourceRevision: 'a'.repeat(40),
  sourceTree: 'b'.repeat(40),
  lockSha256: 'c'.repeat(64),
  artifactSha256: 'd'.repeat(64),
  artifactCount: 42,
  nodeVersion: 'v22.13.0',
  typescriptVersion: '5.6.3',
};
const config = {
  directory: '/unused-private-fixture',
  hosting: 'local' as const,
  acceptUncappedOutput: true as const,
};
const scopes = ['resource.invoke', 'chatgpt.tokens.use.direct'];
function account(key = 'a'.repeat(64)): SubscriptionAccountRecord {
  return {
    key,
    issuer: 'https://auth.openai.com',
    subject: 'PRIVATE-SUBJECT',
    clientId: 'PRIVATE-CLIENT',
    label: 'PRIVATE-LABEL',
    email: 'PRIVATE-EMAIL@example.test',
    tokens: {
      accessToken: 'PRIVATE-ACCESS',
      refreshToken: 'PRIVATE-REFRESH',
      idToken: 'PRIVATE-ID',
      scopes,
      expiresAt: Date.now() + 3600_000,
    },
  };
}
class MemoryStore implements SubscriptionStore {
  state: SubscriptionState = {
    version: 1,
    hostId: 'PRIVATE-HOST',
    accounts: [],
  };
  async transaction<T>(
    operation: (state: SubscriptionState) => Promise<T>,
  ): Promise<T> {
    const copy = structuredClone(this.state);
    const result = await operation(copy);
    this.state = copy;
    return result;
  }
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const DISCOVERY = {
  issuer: 'https://auth.openai.com',
  authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
  token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
  jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
  revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
  id_token_signing_alg_values_supported: ['RS256'],
};
function completed(overrides: Record<string, unknown> = {}) {
  return {
    type: 'response.completed',
    response: {
      object: 'response',
      id: 'resp-acceptance',
      model: 'visible-model-2026-10',
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'msg-acceptance',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              annotations: [],
              text: JSON.stringify({
                summary: 'PRIVATE-SUMMARY',
                claims: [
                  {
                    text: 'The fictional clerk scheduled an inspection for Monday.',
                    status: 'conclusive',
                    supports: 'supports',
                    rationale: 'PRIVATE-RATIONALE',
                  },
                ],
              }),
            },
          ],
        },
      ],
      usage: {
        input_tokens: 21,
        output_tokens: 7,
        total_tokens: 28,
        input_tokens_details: { cached_tokens: 5 },
      },
      ...overrides,
    },
  };
}
function stream(event: unknown = completed()) {
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}
function harness() {
  const store = new MemoryStore();
  const controller = new AbortController();
  const selected = account();
  let event: unknown = completed();
  let brokenStream: Response | undefined;
  let revoke = true;
  let badRefresh = false;
  let signInError: Error | undefined;
  let planAllowed = true;
  let preventClear = false;
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetch: typeof globalThis.fetch = jest.fn((input, init) => {
    const response = (() => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requests.push({ url, init });
      if (url.endsWith('/models'))
        return json({
          models: [
            {
              slug: 'visible-model',
              display_name: 'Visible',
              visibility: 'list',
            },
            {
              slug: 'hidden-model',
              display_name: 'Hidden',
              visibility: 'hide',
            },
          ],
        });
      if (url.endsWith('/openid-configuration')) return json(DISCOVERY);
      if (url.endsWith('/oauth/revoke'))
        return new Response(revoke ? null : 'PRIVATE-REVOKE-ERROR', {
          status: revoke ? 200 : 500,
        });
      if (url.endsWith('/oauth/token'))
        return json(
          badRefresh
            ? { privateError: 'PRIVATE-TOKEN-BODY' }
            : {
                access_token: 'PRIVATE-ROTATED-ACCESS',
                refresh_token: 'PRIVATE-ROTATED-REFRESH',
                token_type: 'Bearer',
                expires_in: 3600,
                scope: scopes.join(' '),
              },
        );
      if (url.endsWith('/responses')) return brokenStream ?? stream(event);
      throw new Error('PRIVATE-UNEXPECTED-URL');
    })();
    return Promise.resolve(response);
  });
  let sessionCount = 0;
  const signIn = jest.fn(async () => {
    if (signInError !== undefined) throw signInError;
    await store.transaction((state) => {
      state.accounts.push(selected);
      state.activeAccountKey = selected.key;
      return Promise.resolve();
    });
    return {
      key: selected.key,
      label: selected.label,
      email: present(selected.email),
      active: true,
      signedIn: true,
      planUsageAuthorized: planAllowed,
    };
  });
  const createSession: typeof createOpenAiSubscriptionSession = (options) => {
    const native = createOpenAiSubscriptionSession(options);
    return sessionCount++ === 0
      ? { ...native, signIn }
      : preventClear
        ? {
            ...native,
            signOut: () => Promise.resolve({ remoteRevocationConfirmed: true }),
          }
        : native;
  };
  const chooseModel = jest.fn<Promise<string | undefined>, []>(() =>
    Promise.resolve('visible-model'),
  );
  const deps = {
    store,
    fetch,
    signal: controller.signal,
    chooseModel,
    createSession,
    openAuthorizationUrl: jest.fn(() => Promise.resolve(undefined)),
  };
  return {
    store,
    selected,
    controller,
    deps,
    requests,
    signIn,
    setEvent: (value: unknown) => {
      event = value;
    },
    setStream: (value: Response) => {
      brokenStream = value;
    },
    revokeFailure: () => {
      revoke = false;
    },
    badRefresh: () => {
      badRefresh = true;
    },
    signInFailure: (error: Error) => {
      signInError = error;
    },
    denyPlan: () => {
      planAllowed = false;
    },
    preventClear: () => {
      preventClear = true;
    },
  };
}

describe('fresh account subscription acceptance', () => {
  it('uses native session/catalogue, exactly one native SSE engine analysis, real usage and targeted revocation', async () => {
    const h = harness();
    const result = await runAcceptance(config, provenance, h.deps);
    expect(result).toMatchObject({
      analysisAccepted: true,
      localCredentialsCleared: true,
      remoteRevocationConfirmed: true,
      responsesDispatches: 1,
      requestedModel: 'visible-model',
      refresh: { attempts: 0, persistedRotations: 0, status: 'not_observed' },
      response: {
        id: 'resp-acceptance',
        model: 'visible-model-2026-10',
        usage: {
          inputTokens: 21,
          outputTokens: 7,
          totalTokens: 28,
          cachedInputTokens: 5,
        },
        claims: 1,
        promotionBlocked: 1,
        promotionRules: expect.arrayContaining(['R7']),
      },
    });
    expect(h.store.state.accounts[0]?.tokens).toBeUndefined();
    expect(h.store.state.accounts[0]?.key).toBe(h.selected.key);
    expect(h.store.state.hostId).toBe('PRIVATE-HOST');
    const dispatched = h.requests.filter((entry) =>
      entry.url.endsWith('/responses'),
    );
    expect(dispatched).toHaveLength(1);
    expect(JSON.parse(bodyText(dispatched[0]?.init?.body))).toMatchObject({
      model: 'visible-model',
      store: false,
      stream: true,
    });
    expect(JSON.parse(bodyText(dispatched[0]?.init?.body))).not.toHaveProperty(
      'max_output_tokens',
    );
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE-|fictional clerk|unused-private|authorization|accessToken|refreshToken|rationale/,
    );
  });
  it('pins original registration after active account changes and preserves the other account on sign-out', async () => {
    const h = harness();
    const other = account('b'.repeat(64));
    present(other.tokens).accessToken = 'OTHER-ACCESS';
    h.deps.chooseModel.mockImplementation(async () => {
      await h.store.transaction((state) => {
        state.accounts.push(other);
        state.activeAccountKey = other.key;
        return Promise.resolve();
      });
      return 'visible-model';
    });
    const result = await runAcceptance(config, provenance, h.deps);
    expect(result.analysisAccepted).toBe(true);
    expect(
      h.requests.find((r) => r.url.endsWith('/responses'))?.init?.headers,
    ).toMatchObject({ Authorization: 'Bearer PRIVATE-ACCESS' });
    expect(h.store.state.activeAccountKey).toBe(other.key);
    expect(h.store.state.accounts[1]?.tokens?.accessToken).toBe('OTHER-ACCESS');
  });
  it.each(['missing', 'signed_out', 'grant_revoked'])(
    'does not dispatch when chosen registration becomes %s',
    async (change) => {
      const h = harness();
      h.deps.chooseModel.mockImplementation(async () => {
        await h.store.transaction((state) => {
          if (change === 'missing') state.accounts = [];
          else if (change === 'signed_out')
            delete present(state.accounts[0]).tokens;
          else present(present(state.accounts[0]).tokens).scopes = ['openid'];
          return Promise.resolve();
        });
        return 'visible-model';
      });
      const result = await runAcceptance(config, provenance, h.deps);
      expect(result.analysisAccepted).toBe(false);
      expect(result.responsesDispatches).toBe(0);
      expect(result.failure?.stage).toBe('inference');
    },
  );
  it.each([
    'hidden-model',
    'not-in-catalogue',
    undefined,
    'visible-model\u202e',
  ])('rejects unusable model %s before dispatch', async (model) => {
    const h = harness();
    h.deps.chooseModel.mockResolvedValue(model);
    const result = await runAcceptance(config, provenance, h.deps);
    expect(result.failure).toEqual({
      stage: 'models',
      code: 'invalid_configuration',
    });
    expect(result.responsesDispatches).toBe(0);
    expect(result.localCredentialsCleared).toBe(true);
  });
  it('checks an explicit model against live catalogue without choosing another', async () => {
    const h = harness();
    const result = await runAcceptance(
      { ...config, model: 'hidden-model' },
      provenance,
      h.deps,
    );
    expect(result.responsesDispatches).toBe(0);
    expect(h.deps.chooseModel).not.toHaveBeenCalled();
  });
  it('records only a real native rotating exchange committed in the selected transaction', async () => {
    const h = harness();
    present(h.selected.tokens).expiresAt = Date.now() - 1;
    const result = await runAcceptance(config, provenance, h.deps);
    expect(result.refresh).toEqual({
      attempts: 1,
      persistedRotations: 1,
      status: 'completed',
    });
    expect(result.analysisAccepted).toBe(true);
    expect(
      h.requests.find((r) => r.url.endsWith('/responses'))?.init?.headers,
    ).toMatchObject({ Authorization: 'Bearer PRIVATE-ROTATED-ACCESS' });
    expect(
      h.requests.filter((r) => r.url.endsWith('/oauth/token')),
    ).toHaveLength(1);
  });
  it('does not count HTTP200 with invalid replacement as a persisted rotation', async () => {
    const h = harness();
    present(h.selected.tokens).expiresAt = Date.now() - 1;
    h.badRefresh();
    const result = await runAcceptance(config, provenance, h.deps);
    expect(result.refresh).toEqual({
      attempts: 1,
      persistedRotations: 0,
      status: 'pending',
    });
    expect(result.failure).toEqual({
      stage: 'models',
      code: 'invalid_response',
    });
    expect(result.responsesDispatches).toBe(0);
    expect(result.localCredentialsCleared).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-TOKEN-BODY');
  });
  it('keeps remote revocation uncertainty distinct from local clearing', async () => {
    const h = harness();
    h.revokeFailure();
    const result = await runAcceptance(config, provenance, h.deps);
    expect(result).toMatchObject({
      analysisAccepted: true,
      localCredentialsCleared: true,
      remoteRevocationConfirmed: false,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-REVOKE-ERROR');
  });
  it.each([
    [
      {
        type: 'response.failed',
        response: {
          error: {
            code: 'subscription_sharing_usage_limit_exceeded',
            message: 'PRIVATE-PROVIDER',
          },
        },
      },
      'quota_exhausted',
    ],
    [
      {
        type: 'response.failed',
        response: { error: { code: 'subscription_sharing_user_not_eligible' } },
      },
      'subscription_ineligible',
    ],
    [completed({ output: [] }), 'invalid_response'],
    [completed({ usage: undefined }), 'invalid_response'],
    [completed({ model: 'PRIVATE-MODEL@example.test' }), 'invalid_response'],
    [completed({ id: 'PRIVATE-ID@example.test' }), 'invalid_response'],
  ])(
    'stops one failed native response without retry/fallback (%s)',
    async (event, code) => {
      const h = harness();
      h.setEvent(event);
      const result = await runAcceptance(config, provenance, h.deps);
      expect(result.failure).toEqual({ stage: 'inference', code });
      expect(result.responsesDispatches).toBe(1);
      expect(result.analysisAccepted).toBe(false);
      expect(result.response).toBeUndefined();
      expect(result.localCredentialsCleared).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE-|costInUsdTicks/);
    },
  );
  it.each(['data: {broken}\n\n', 'data: [DONE]\n\n'])(
    'rejects corrupt/interrupted SSE, retaining cleanup and partial stages',
    async (body) => {
      const h = harness();
      h.setStream(
        new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
      const result = await runAcceptance(config, provenance, h.deps);
      expect(result.stages).toEqual({
        signIn: 'completed',
        models: 'completed',
        inference: 'failed',
        signOut: 'completed',
      });
      expect(result.responsesDispatches).toBe(1);
      expect(result.analysisAccepted).toBe(false);
    },
  );
  it('cleans up a freshly created registration when plan authorization was declined', async () => {
    const h = harness();
    h.denyPlan();
    const result = await runAcceptance(config, provenance, h.deps);
    expect(result.failure).toEqual({
      stage: 'signIn',
      code: 'plan_not_authorized',
    });
    expect(result.localCredentialsCleared).toBe(true);
    expect(result.remoteRevocationConfirmed).toBe(true);
    expect(result.responsesDispatches).toBe(0);
  });
  it('rejects a sign-out success claim unless local clearing actually persisted', async () => {
    const h = harness();
    h.preventClear();
    const result = await runAcceptance(config, provenance, h.deps);
    expect(result.analysisAccepted).toBe(true);
    expect(result.localCredentialsCleared).toBe(false);
    expect(result.stages.signOut).toBe('failed');
    expect(result.cleanupFailure).toBe('storage_unavailable');
    expect(h.store.state.accounts[0]?.tokens?.accessToken).toBe(
      'PRIVATE-ACCESS',
    );
  });
  it('rejects a populated store before sign-in, leaving existing tokens untouched', async () => {
    const h = harness();
    h.store.state.accounts.push(account());
    const result = await runAcceptance(config, provenance, h.deps);
    expect(result.failure?.code).toBe('invalid_configuration');
    expect(h.signIn).not.toHaveBeenCalled();
    expect(h.store.state.accounts[0]?.tokens?.accessToken).toBe(
      'PRIVATE-ACCESS',
    );
    expect(h.requests).toHaveLength(0);
  });
  it.each([
    new OpenAiSubscriptionAuthError('access_denied'),
    new Error('PRIVATE-ERROR'),
    Object.defineProperty(new OpenAiSubscriptionAuthError('timeout'), 'code', {
      get() {
        throw new Error('PRIVATE-GETTER');
      },
    }),
  ])(
    'sanitizes sign-in failures and skips accountless cleanup',
    async (error) => {
      const h = harness();
      h.signInFailure(error);
      const result = await runAcceptance(config, provenance, h.deps);
      expect(result.stages.signOut).toBe('skipped');
      expect(result.failure?.stage).toBe('signIn');
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE-|stack|cause/);
    },
  );
  it('handles cancellation before any effect', async () => {
    const h = harness();
    h.controller.abort();
    const result = await runAcceptance(config, provenance, h.deps);
    expect(result.responsesDispatches).toBe(0);
    expect(h.signIn).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(0);
  });
  it('cancelled model selection clears only its newly created registration', async () => {
    const h = harness();
    h.deps.chooseModel.mockImplementation(() => {
      h.controller.abort();
      return Promise.resolve('visible-model');
    });
    const result = await runAcceptance(config, provenance, h.deps);
    expect(result.analysisAccepted).toBe(false);
    expect(result.responsesDispatches).toBe(0);
    expect(result.localCredentialsCleared).toBe(true);
    expect(result.remoteRevocationConfirmed).toBe(true);
  });
});

describe('transaction pinning', () => {
  it('rolls back failed rotation and preserves original selection', async () => {
    const store = new MemoryStore();
    const selected = account();
    store.state.accounts = [selected, account('b'.repeat(64))];
    store.state.activeAccountKey = 'b'.repeat(64);
    const refresh = {
      attempts: 1,
      persistedRotations: 0,
      status: 'pending' as const,
    };
    const pinned = pinAccountStore(store, selected.key, refresh, () => 1);
    await expect(
      pinned.transaction((state) => {
        expect(state.activeAccountKey).toBe(selected.key);
        present(present(state.accounts[0]).tokens).refreshToken =
          'PRIVATE-FAILED-ROTATION';
        return Promise.reject(new Error('PRIVATE-ROLLBACK'));
      }),
    ).rejects.toThrow('PRIVATE-ROLLBACK');
    expect(store.state.activeAccountKey).toBe('b'.repeat(64));
    expect(store.state.accounts[0]?.tokens?.refreshToken).toBe(
      'PRIVATE-REFRESH',
    );
    expect(refresh.persistedRotations).toBe(0);
  });
});
