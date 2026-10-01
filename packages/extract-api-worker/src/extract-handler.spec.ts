import type { ExtractionInput } from '@wsa/evidence-engine';
import { ArtefactIdSchema, ulid } from '@wsa/schemas';
import { AuthError } from './auth.js';
import { BudgetExhaustedError } from './budget-guard.js';
import {
  createFetchXaiClient,
  handleExtractRequest,
  type Env,
  type ExtractHandlerDeps,
} from './extract-handler.js';
import { RateLimitedError } from './rate-limiter.js';

const CURRENT_TIMESTAMP = String(
  Math.floor(new Date('2026-04-18T19:00:00.000Z').getTime() / 1000),
);

function makeEnvelope(
  overrides: Partial<ExtractionInput> = {},
): ExtractionInput {
  return {
    requestId: 'req-001',
    sourceRef: {
      kind: 'artefact',
      id: ArtefactIdSchema.parse(ulid('ARTF1')),
    },
    sourceUrl: 'https://example.org/source',
    sourceSha256: 'a'.repeat(64),
    sourceFetchedAt: '2026-04-18T19:00:00.000Z',
    sourceText: 'already-redacted source text',
    ...overrides,
  };
}

class FakeBucket {
  readonly writes: Array<{ key: string; body: string }> = [];

  put(key: string, body: string): Promise<void> {
    this.writes.push({ key, body });
    return Promise.resolve();
  }
}

describe('@wsa/extract-api-worker/extract-handler', () => {
  it('returns a 200 response with per-claim promotion data and telemetry', async () => {
    const telemetryWrites: Array<{
      monthKey: string;
      record: Record<string, unknown>;
    }> = [];
    const request = new Request(
      'https://extract-api.witnesssouthafrica.org/v1/extract',
      {
        method: 'POST',
        body: JSON.stringify({
          operatorAttestation: {
            classification: 'lane2-redacted-or-consented',
          },
          extract: makeEnvelope(),
        }),
      },
    );

    const response = await handleExtractRequest(
      request,
      {
        WSA_TELEMETRY: new FakeBucket() as unknown as R2Bucket,
        OPERATOR_RATE_LIMITER: {} as DurableObjectNamespace,
        XAI_BUDGET_MONTHLY_CAP_USD_TICKS: '100',
      } as Env,
      {
        now: () => new Date('2026-04-18T19:00:00.000Z'),
        verifySignature: () =>
          Promise.resolve({
            keyId: 'OP01',
            timestamp: '1713466800',
            contentSha256: 'a'.repeat(64),
            rawPathAndQuery: '/v1/extract',
          }),
        acquireLease: () =>
          Promise.resolve({
            release: () => Promise.resolve(),
          }),
        assertBudget: () =>
          Promise.resolve({
            monthKey: '2026-04',
            monthToDateCostUsdTicks: 0,
            monthlyCapUsdTicks: 100,
          }),
        createXaiClient: () => ({
          chat: {
            completions: {
              create: () =>
                Promise.resolve({
                  id: 'chat-001',
                  model: 'grok-4-fast-reasoning',
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: 'assistant',
                        content: JSON.stringify({
                          summary: 'One claim extracted.',
                          claims: [
                            {
                              text: 'Claim text',
                              status: 'contested',
                              supports: 'supports',
                              rationale:
                                'The source supports a contestable claim.',
                            },
                          ],
                        }),
                      },
                      finish_reason: 'stop',
                    },
                  ],
                  usage: {
                    prompt_tokens: 10,
                    completion_tokens: 3,
                    total_tokens: 13,
                    prompt_tokens_details: { cached_tokens: 2 },
                  },
                }),
            },
          },
        }),
        writeTelemetry: (_bucket, monthKey, record) => {
          telemetryWrites.push({
            monthKey,
            record: record as unknown as Record<string, unknown>,
          });
          return Promise.resolve();
        },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      claims: Array<{ promotionDecision: { ok: boolean } }>;
    };
    expect(body.claims[0]?.promotionDecision.ok).toBe(true);
    expect(JSON.stringify(body)).not.toContain('xai');
    expect(telemetryWrites[0]?.monthKey).toBe('2026-04');
    expect(telemetryWrites[0]?.record.outcome).toBe('success');
  });

  it('returns 401 on auth failure', async () => {
    const telemetryWrites: Array<{
      monthKey: string;
      record: Record<string, unknown>;
    }> = [];
    const response = await handleExtractRequest(
      new Request('https://extract-api.witnesssouthafrica.org/v1/extract', {
        method: 'POST',
        body: '{}',
      }),
      {
        WSA_TELEMETRY: new FakeBucket() as unknown as R2Bucket,
        OPERATOR_RATE_LIMITER: {} as DurableObjectNamespace,
      } as Env,
      {
        now: () => new Date('2026-04-18T19:00:00.000Z'),
        verifySignature: () => {
          throw new AuthError('signature_mismatch');
        },
        writeTelemetry: (_bucket, monthKey, record) => {
          telemetryWrites.push({
            monthKey,
            record: record as unknown as Record<string, unknown>,
          });
          return Promise.resolve();
        },
      },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      reason: 'signature_mismatch',
    });
    expect(telemetryWrites).toHaveLength(1);
    expect(telemetryWrites[0]?.monthKey).toBe('2026-04');
    expect(telemetryWrites[0]?.record).toMatchObject({
      keyId: 'missing',
      outcome: 'error',
      errorReason: 'signature_mismatch',
      httpStatus: 401,
      stage: 'auth',
      inputTokens: 0,
      totalTokens: 0,
    });
    expect(telemetryWrites[0]?.record.requestId).toEqual(
      expect.stringMatching(/^auth-[a-f0-9-]{36}$/),
    );
    expect(telemetryWrites[0]?.record.sourceRef).toBeUndefined();
    expect(telemetryWrites[0]?.record.sourceSha256).toBeUndefined();
  });

  it('returns 429 when rate limited', async () => {
    const response = await handleExtractRequest(
      new Request('https://extract-api.witnesssouthafrica.org/v1/extract', {
        method: 'POST',
        body: JSON.stringify({
          operatorAttestation: {
            classification: 'lane2-redacted-or-consented',
          },
          extract: makeEnvelope(),
        }),
      }),
      {
        WSA_TELEMETRY: new FakeBucket() as unknown as R2Bucket,
        OPERATOR_RATE_LIMITER: {} as DurableObjectNamespace,
      } as Env,
      {
        verifySignature: () =>
          Promise.resolve({
            keyId: 'OP01',
            timestamp: '1713466800',
            contentSha256: 'a'.repeat(64),
            rawPathAndQuery: '/v1/extract',
          }),
        acquireLease: () => {
          throw new RateLimitedError();
        },
      },
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      reason: 'rate_limited',
    });
  });

  it('returns 429 and skips the provider when the budget is exhausted', async () => {
    let providerCalled = false;
    const response = await handleExtractRequest(
      new Request('https://extract-api.witnesssouthafrica.org/v1/extract', {
        method: 'POST',
        body: JSON.stringify({
          operatorAttestation: {
            classification: 'lane2-redacted-or-consented',
          },
          extract: makeEnvelope(),
        }),
      }),
      {
        WSA_TELEMETRY: new FakeBucket() as unknown as R2Bucket,
        OPERATOR_RATE_LIMITER: {} as DurableObjectNamespace,
        XAI_BUDGET_MONTHLY_CAP_USD_TICKS: '25',
      } as Env,
      {
        verifySignature: () =>
          Promise.resolve({
            keyId: 'OP01',
            timestamp: '1713466800',
            contentSha256: 'a'.repeat(64),
            rawPathAndQuery: '/v1/extract',
          }),
        acquireLease: () =>
          Promise.resolve({
            release: () => Promise.resolve(),
          }),
        assertBudget: () => {
          throw new BudgetExhaustedError({
            monthKey: '2026-04',
            monthToDateCostUsdTicks: 25,
            monthlyCapUsdTicks: 25,
          });
        },
        createXaiClient: () => {
          providerCalled = true;
          return {
            chat: {
              completions: {
                create: () => {
                  throw new Error('should not be called');
                },
              },
            },
          };
        },
      },
    );

    expect(response.status).toBe(429);
    expect(providerCalled).toBe(false);
  });

  it('returns 500 for unexpected provider failures', async () => {
    const response = await handleExtractRequest(
      new Request('https://extract-api.witnesssouthafrica.org/v1/extract', {
        method: 'POST',
        body: JSON.stringify({
          operatorAttestation: {
            classification: 'lane2-redacted-or-consented',
          },
          extract: makeEnvelope(),
        }),
      }),
      {
        WSA_TELEMETRY: new FakeBucket() as unknown as R2Bucket,
        OPERATOR_RATE_LIMITER: {} as DurableObjectNamespace,
      } as Env,
      {
        verifySignature: () =>
          Promise.resolve({
            keyId: 'OP01',
            timestamp: '1713466800',
            contentSha256: 'a'.repeat(64),
            rawPathAndQuery: '/v1/extract',
          }),
        acquireLease: () =>
          Promise.resolve({
            release: () => Promise.resolve(),
          }),
        assertBudget: () =>
          Promise.resolve({
            monthKey: '2026-04',
            monthToDateCostUsdTicks: 0,
            monthlyCapUsdTicks: 25,
          }),
        createXaiClient: () => ({
          chat: {
            completions: {
              create: () => {
                throw new Error('boom');
              },
            },
          },
        }),
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      reason: 'internal_error',
    });
  });

  it('returns 400 without telemetry when the body is not valid JSON', async () => {
    const bucket = new FakeBucket();
    const response = await handleExtractRequest(
      new Request('https://extract-api.witnesssouthafrica.org/v1/extract', {
        method: 'POST',
        body: '{',
      }),
      {
        WSA_TELEMETRY: bucket as unknown as R2Bucket,
        OPERATOR_RATE_LIMITER: {} as DurableObjectNamespace,
      } as Env,
      {
        verifySignature: () =>
          Promise.resolve({
            keyId: 'OP01',
            timestamp: CURRENT_TIMESTAMP,
            contentSha256: 'a'.repeat(64),
            rawPathAndQuery: '/v1/extract',
          }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      reason: 'invalid_request',
    });
    expect(bucket.writes).toHaveLength(0);
  });

  it('returns 400 without telemetry when signed JSON fails request validation', async () => {
    const bucket = new FakeBucket();
    const response = await handleExtractRequest(
      new Request('https://extract-api.witnesssouthafrica.org/v1/extract', {
        method: 'POST',
        body: JSON.stringify({
          operatorAttestation: {
            classification: 'lane2-redacted-or-consented',
          },
          extract: {
            requestId: 'req-001',
          },
        }),
      }),
      {
        WSA_TELEMETRY: bucket as unknown as R2Bucket,
        OPERATOR_RATE_LIMITER: {} as DurableObjectNamespace,
      } as Env,
      {
        verifySignature: () =>
          Promise.resolve({
            keyId: 'OP01',
            timestamp: CURRENT_TIMESTAMP,
            contentSha256: 'a'.repeat(64),
            rawPathAndQuery: '/v1/extract',
          }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      reason: 'invalid_request',
    });
    expect(bucket.writes).toHaveLength(0);
  });

  it('passes a custom replay window to signature verification', async () => {
    const bucket = new FakeBucket();
    const verifySignature = jest.fn<
      ReturnType<NonNullable<ExtractHandlerDeps['verifySignature']>>,
      Parameters<NonNullable<ExtractHandlerDeps['verifySignature']>>
    >();
    verifySignature.mockResolvedValue({
      keyId: 'OP01',
      timestamp: CURRENT_TIMESTAMP,
      contentSha256: 'a'.repeat(64),
      rawPathAndQuery: '/v1/extract',
    });

    await handleExtractRequest(
      new Request('https://extract-api.witnesssouthafrica.org/v1/extract', {
        method: 'POST',
        body: JSON.stringify({
          operatorAttestation: {
            classification: 'lane2-redacted-or-consented',
          },
          extract: makeEnvelope(),
        }),
      }),
      {
        WSA_TELEMETRY: bucket as unknown as R2Bucket,
        OPERATOR_RATE_LIMITER: {} as DurableObjectNamespace,
        AUTH_REPLAY_WINDOW_SECONDS: '120',
        XAI_BUDGET_MONTHLY_CAP_USD_TICKS: '100',
      } as Env,
      {
        verifySignature,
        acquireLease: () =>
          Promise.resolve({
            release: () => Promise.resolve(),
          }),
        assertBudget: () =>
          Promise.resolve({
            monthKey: '2026-04',
            monthToDateCostUsdTicks: 0,
            monthlyCapUsdTicks: 100,
          }),
        createXaiClient: () => ({
          chat: {
            completions: {
              create: () =>
                Promise.resolve({
                  id: 'chat-001',
                  model: 'grok-4-fast-reasoning',
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: 'assistant',
                        content: JSON.stringify({
                          summary: 'One claim extracted.',
                          claims: [],
                        }),
                      },
                      finish_reason: 'stop',
                    },
                  ],
                  usage: {
                    prompt_tokens: 1,
                    completion_tokens: 1,
                    total_tokens: 2,
                  },
                }),
            },
          },
        }),
        writeTelemetry: () => Promise.resolve(),
      },
    );

    expect(verifySignature).toHaveBeenCalledWith(
      expect.any(Request),
      expect.any(Object),
      expect.any(Date),
      120,
    );
  });

  it('falls back to the default replay window when the env value is invalid', async () => {
    const verifySignature = jest.fn<
      ReturnType<NonNullable<ExtractHandlerDeps['verifySignature']>>,
      Parameters<NonNullable<ExtractHandlerDeps['verifySignature']>>
    >();
    verifySignature.mockRejectedValue(new AuthError('stale_timestamp'));

    const response = await handleExtractRequest(
      new Request('https://extract-api.witnesssouthafrica.org/v1/extract', {
        method: 'POST',
        body: '{}',
      }),
      {
        WSA_TELEMETRY: new FakeBucket() as unknown as R2Bucket,
        OPERATOR_RATE_LIMITER: {} as DurableObjectNamespace,
        AUTH_REPLAY_WINDOW_SECONDS: 'invalid',
      } as Env,
      {
        verifySignature,
      },
    );

    expect(response.status).toBe(401);
    expect(verifySignature).toHaveBeenCalledWith(
      expect.any(Request),
      expect.any(Object),
      expect.any(Date),
      300,
    );
  });

  it('creates fetch requests against the configured API base URL and forwards the signal', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    try {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'chat-001',
            model: 'grok-4-fast-reasoning',
            choices: [],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
          }),
          { status: 200 },
        ),
      );

      const signal = new AbortController().signal;
      const client = createFetchXaiClient({
        WSA_TELEMETRY: new FakeBucket() as unknown as R2Bucket,
        OPERATOR_RATE_LIMITER: {} as DurableObjectNamespace,
        XAI_API_KEY: 'secret',
        XAI_API_BASE_URL: 'https://api.example.test///',
      } as Env);

      await client.chat.completions.create(
        {
          model: 'grok-4-fast-reasoning',
          messages: [],
        },
        { signal },
      );

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.example.test/chat/completions',
        expect.objectContaining({
          method: 'POST',
          signal,
          headers: expect.objectContaining({
            authorization: 'Bearer secret',
            'content-type': 'application/json',
          }),
        }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('throws when the provider responds with a non-ok status', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    try {
      fetchSpy.mockResolvedValue(new Response('bad', { status: 502 }));
      const client = createFetchXaiClient({
        WSA_TELEMETRY: new FakeBucket() as unknown as R2Bucket,
        OPERATOR_RATE_LIMITER: {} as DurableObjectNamespace,
        XAI_API_KEY: 'secret',
      } as Env);

      await expect(
        client.chat.completions.create({
          model: 'grok-4-fast-reasoning',
          messages: [],
        }),
      ).rejects.toThrow('provider_request_failed:502');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('throws when the API key is missing', () => {
    expect(() =>
      createFetchXaiClient({
        WSA_TELEMETRY: new FakeBucket() as unknown as R2Bucket,
        OPERATOR_RATE_LIMITER: {} as DurableObjectNamespace,
      } as Env),
    ).toThrow('missing XAI_API_KEY');
  });
});
