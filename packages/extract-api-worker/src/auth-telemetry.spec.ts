import { createHmac, createHash, randomBytes } from 'node:crypto';
import { canonicalizeSignatureInput } from './auth.js';
import { BudgetExhaustedError } from './budget-guard.js';
import { createWorker } from './index.js';
import type { Env, ExtractHandlerDeps } from './extract-handler.js';
import { RateLimitedError } from './rate-limiter.js';

const instant = new Date('2026-10-01T08:00:00Z');

function setup(deps: ExtractHandlerDeps = {}) {
  const writes = jest.fn(() => Promise.resolve());
  const lease = jest.fn(() => {
    throw new Error('auth must not acquire a lease');
  });
  const budget = jest.fn(() => {
    throw new Error('auth must not read budget');
  });
  const provider = jest.fn(() => {
    throw new Error('auth must not call provider');
  });
  const worker = createWorker({
    now: () => instant,
    acquireLease: lease,
    assertBudget: budget,
    createXaiClient: provider,
    ...deps,
  });
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
  } as ExecutionContext;
  const env = {
    WSA_TELEMETRY: { put: writes },
    OPERATOR_RATE_LIMITER: {},
  } as unknown as Env;
  const fetch = worker.fetch;
  if (fetch === undefined) throw new Error('missing worker fetch');
  return {
    writes,
    lease,
    budget,
    provider,
    pending,
    env,
    dispatch: async (request: Request) => fetch(request as never, env, context),
  };
}

function unsigned(keyId?: string) {
  return new Request('https://extract-api.witnesssouthafrica.org/v1/extract', {
    method: 'POST',
    body: '{"sourceText":"must never persist"}',
    ...(keyId === undefined ? {} : { headers: { 'X-WSA-Key-Id': keyId } }),
  });
}

describe('deployed auth telemetry path', () => {
  it('samples six concurrent failures, uses unique IDs, and never stores hostile headers or bodies', async () => {
    const harness = setup();
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        harness.dispatch(unsigned('private-user@example.org')),
      ),
    );
    expect(responses.every((response) => response.status === 401)).toBe(true);
    await Promise.all(harness.pending);
    expect(harness.writes).toHaveBeenCalledTimes(6);
    const calls = harness.writes.mock.calls as unknown as Array<
      [string, string]
    >;
    expect(new Set(calls.map(([key]) => key)).size).toBe(6);
    const records = calls.map(
      ([, body]) => JSON.parse(body) as Record<string, unknown>,
    );
    expect(new Set(records.map((record) => record.requestId)).size).toBe(6);
    expect(
      calls.every(([key]) => /^auth\/2026-10\/[a-f0-9-]{36}\.json$/.test(key)),
    ).toBe(true);
    expect(records.every((record) => record.keyId === 'provided')).toBe(true);
    expect(JSON.stringify(calls)).not.toMatch(
      /private-user|example.org|sourceText|must never persist/,
    );
    expect(harness.lease).not.toHaveBeenCalled();
    expect(harness.budget).not.toHaveBeenCalled();
    expect(harness.provider).not.toHaveBeenCalled();
  });

  it('refills sampling after a minute without allowing a clock rollback to reset admission', async () => {
    let time = instant;
    const harness = setup({ now: () => time });
    for (let i = 0; i < 6; i += 1) await harness.dispatch(unsigned());
    time = new Date(instant.getTime() - 60_000);
    await harness.dispatch(unsigned());
    expect(harness.pending).toHaveLength(6);
    time = new Date(instant.getTime() + 60_000);
    await harness.dispatch(unsigned());
    await Promise.all(harness.pending);
    expect(harness.writes).toHaveBeenCalledTimes(7);
  });

  it.each(['reject', 'throw', 'stall'])(
    'preserves401 when the telemetry sink can %s',
    async (mode) => {
      const writeTelemetry = jest.fn(() => {
        if (mode === 'throw') throw new Error('sensitive storage failure');
        return mode === 'reject'
          ? Promise.reject(new Error('sensitive storage failure'))
          : new Promise<void>(() => undefined);
      });
      const harness = setup({ writeTelemetry });
      const response = await harness.dispatch(unsigned());
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        reason: 'missing_signature_headers',
      });
      expect(harness.pending).toHaveLength(1);
      if (mode !== 'stall') await Promise.all(harness.pending);
    },
  );

  it('uses the same limiter identity for every alias of one HMAC credential', async () => {
    const acquireLease = jest.fn(() => {
      throw new RateLimitedError();
    });
    const harness = setup({ acquireLease });
    const timestamp = String(Math.floor(instant.getTime() / 1000));
    const body = JSON.stringify({
      operatorAttestation: { classification: 'lane2-redacted-or-consented' },
      extract: {
        requestId: 'alias-proof',
        sourceRef: { kind: 'artefact', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
        sourceUrl: 'https://example.org/source',
        sourceSha256: 'a'.repeat(64),
        sourceFetchedAt: instant.toISOString(),
        sourceText: 'public synthetic source',
      },
    });
    const hash = createHash('sha256').update(body).digest('hex');
    const key = randomBytes(32).toString('hex');
    const signature = createHmac('sha256', key)
      .update(
        canonicalizeSignatureInput('POST', '/v1/extract', timestamp, hash),
      )
      .digest('hex');
    Object.assign(harness.env, {
      OPERATOR_HMAC_KEY_OPS_01: key,
    });
    for (const keyId of ['OPS-01', 'OPS+01', 'OPS_01']) {
      const response = await harness.dispatch(
        new Request('https://extract-api.witnesssouthafrica.org/v1/extract', {
          method: 'POST',
          body,
          headers: {
            'X-WSA-Key-Id': keyId,
            'X-WSA-Timestamp': timestamp,
            'X-WSA-Content-SHA256': hash,
            'X-WSA-Signature': signature,
          },
        }),
      );
      expect(response.status).toBe(429);
    }
    expect(acquireLease).toHaveBeenCalledTimes(3);
    expect(
      (acquireLease.mock.calls as unknown as Array<[Env, string]>).map(
        ([, keyId]) => keyId,
      ),
    ).toEqual(['OPS_01', 'OPS_01', 'OPS_01']);
  });

  it('keeps budget429 and avoids provider calls even when failure telemetry is unavailable', async () => {
    const harness = setup({
      verifySignature: () =>
        Promise.resolve({
          keyId: 'OP01',
          timestamp: '',
          contentSha256: '',
          rawPathAndQuery: '/v1/extract',
        }),
      acquireLease: () => Promise.resolve({ release: () => Promise.resolve() }),
      assertBudget: () => {
        throw new BudgetExhaustedError({
          monthKey: '2026-10',
          monthToDateCostUsdTicks: 0,
          monthlyCapUsdTicks: 0,
        });
      },
      writeTelemetry: () => Promise.reject(new Error('private storage error')),
    });
    Object.assign(harness.env, { XAI_BUDGET_MONTHLY_CAP_USD_TICKS: '0' });
    const response = await harness.dispatch(
      new Request('https://extract-api.witnesssouthafrica.org/v1/extract', {
        method: 'POST',
        body: JSON.stringify({
          operatorAttestation: {
            classification: 'lane2-redacted-or-consented',
          },
          extract: {
            requestId: 'budget-proof',
            sourceRef: { kind: 'artefact', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
            sourceUrl: 'https://example.org/source',
            sourceSha256: 'a'.repeat(64),
            sourceFetchedAt: instant.toISOString(),
            sourceText: 'public synthetic source',
          },
        }),
      }),
    );
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      reason: 'budget_exhausted',
    });
    expect(harness.provider).not.toHaveBeenCalled();
  });
});
