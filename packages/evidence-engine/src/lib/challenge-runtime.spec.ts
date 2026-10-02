import type {
  CompleteArgs,
  ModelProvider,
  ModelResponse,
} from '@wsa/agent-contracts';
import type { XaiClient } from '@wsa/agent-xai';
import { ArtefactIdSchema, ulid } from '@wsa/schemas';
import type { z } from 'zod';
import {
  createEvidenceEngine,
  createXaiEvidenceEngine,
  extractClaimsWithProvider,
  type ExtractionInput,
} from './runtime.js';

const NOW = new Date('2026-10-02T12:00:00Z');
const TEXT = 'The clerk refused to release the requested record.';
const USAGE = { inputTokens: 17, outputTokens: 9, totalTokens: 26 };

function input(overrides: Partial<ExtractionInput> = {}): ExtractionInput {
  return {
    requestId: 'req-challenge',
    sourceRef: { kind: 'artefact', id: ArtefactIdSchema.parse(ulid('SOURCE')) },
    sourceUrl: 'https://example.org/record',
    sourceSha256: 'a'.repeat(64),
    sourceFetchedAt: NOW.toISOString(),
    sourceText: 'The clerk refused to release the requested record on Monday.',
    ...overrides,
  };
}

function analysisValue(status = 'conclusive') {
  return {
    summary: 'One extracted claim.',
    claims: [
      {
        text: TEXT,
        status,
        supports: 'supports',
        rationale: 'The source describes a refusal.',
      },
    ],
  };
}

function assessment(args: CompleteArgs<z.ZodType>) {
  const payload = JSON.parse(args.messages[1]?.content ?? '{}');
  return {
    claimId: payload.claimId,
    claimText: payload.claimText,
    sourceRef: payload.sourceRef,
    sourceSha256: payload.sourceSha256,
    supports: 'supports',
    rationale: 'The supplied source explicitly describes a refusal.',
  };
}

function provider(args: {
  id: ModelProvider['id'];
  produce?: (call: CompleteArgs<z.ZodType>) => unknown;
  overrides?: Readonly<Record<string, unknown>>;
  error?: string;
}) {
  const calls: CompleteArgs<z.ZodType>[] = [];
  const model: ModelProvider = {
    id: args.id,
    complete: <TSchema extends z.ZodType>(
      call: CompleteArgs<TSchema>,
    ): Promise<ModelResponse<z.infer<TSchema>>> => {
      calls.push(call);
      if (args.error !== undefined) throw new Error(args.error);
      // Intentionally bypass adapter parsing to exercise the runtime's own boundary.
      return Promise.resolve({
        value: args.produce?.(call) ?? analysisValue(),
        provider: args.id,
        model: `${args.id}-test-model`,
        status: 'completed',
        rawFinishReason: 'stop',
        responseId: `${args.id}-response`,
        usage: USAGE,
        ...args.overrides,
      } as ModelResponse<z.infer<TSchema>>);
    },
  };
  return { model, calls };
}

describe('claim-bound challenge orchestration', () => {
  it('can challenge valid maximum-length claims and rationales within the evidence note limit', async () => {
    const analysis = provider({
      id: 'xai',
      overrides: { model: 'm'.repeat(256) },
      produce: () => ({
        ...analysisValue(),
        claims: [
          {
            ...analysisValue().claims[0],
            text: 'c'.repeat(600),
            rationale: 'r'.repeat(500),
          },
        ],
      }),
    });
    const challenge = provider({ id: 'openai', produce: assessment });
    const result = await createEvidenceEngine({
      provider: analysis.model,
      challengeProvider: challenge.model,
      now: () => NOW,
    }).extractClaims(input({ requestId: 'q'.repeat(128) }));
    expect(challenge.calls).toHaveLength(1);
    expect(result.items[0]?.challenge?.outcome).toBe('completed');
    expect(result.items[0]?.evidence.evidence.note?.length).toBeLessThanOrEqual(
      500,
    );
    expect(result.items[0]?.providerRuns?.[0]?.model).toBe('m'.repeat(256));
    expect(result.items[0]?.providerRuns?.[0]?.requestId).toBe('q'.repeat(128));
  });

  it('dispatches a distinct challenge, records completion identity and keeps primary-source rules intact', async () => {
    const analysis = provider({ id: 'xai' });
    const challenge = provider({ id: 'openai', produce: assessment });
    let tick = 0;
    const engine = createEvidenceEngine({
      provider: analysis.model,
      challengeProvider: challenge.model,
      now: () => new Date(NOW.getTime() + tick++ * 1_000),
    });
    const result = await engine.extractClaims(
      input({
        sourceSha256: 'A'.repeat(64),
        maxOutputTokens: 321,
        timeoutMs: 4_321,
      }),
    );
    const item = result.items[0];
    const call = challenge.calls[0];

    expect(analysis.calls).toHaveLength(1);
    expect(challenge.calls).toHaveLength(1);
    expect(call).toMatchObject({
      taskKind: 'challenge',
      maxOutputTokens: 321,
      timeoutMs: 4_321,
    });
    expect(call?.requestId).toBe(
      `req-challenge:challenge:${String(item?.claim.id)}`,
    );
    expect(JSON.parse(call?.messages[1]?.content ?? '{}')).toEqual({
      claimId: item?.claim.id,
      claimText: TEXT,
      sourceRef: input().sourceRef,
      sourceSha256: 'a'.repeat(64),
      sourceText: input().sourceText,
    });
    expect(item?.challenge).toMatchObject({
      outcome: 'completed',
      provider: 'openai',
      usage: USAGE,
      assessment: { supports: 'supports' },
    });
    expect(item?.providerRuns).toHaveLength(2);
    expect(item?.providerRuns?.map((r) => r.taskKind)).toEqual([
      'analysis',
      'challenge',
    ]);
    expect(
      item?.providerRuns?.every(
        (r) => r.claimId === item.claim.id && r.sourceSha256 === 'a'.repeat(64),
      ),
    ).toBe(true);
    expect(item?.providerRuns?.[1]?.at).not.toBe(item?.providerRuns?.[0]?.at);
    expect(item?.providerRuns?.[1]).toMatchObject({
      provider: 'openai',
      model: 'openai-test-model',
      responseId: 'openai-response',
      rawFinishReason: 'stop',
    });
    expect(item?.claim.status).toBe('contested');
    expect(item?.promotion.reasons.map((r) => r.code)).toEqual([
      'R2',
      'R3',
      'R4',
    ]);
    expect(item?.evidence.provenance.providerIds).toEqual(['xai']);
    expect(item?.promotion.activeEvidence).toHaveLength(1);
    expect(item?.evidence.evidence.kind).toBe('other');
    expect(item?.auditTrail[0]?.detail.promotionRuleCodes).toEqual([
      'R2',
      'R3',
      'R4',
    ]);
    const audit = item?.auditTrail.find((r) => r.action === 'claim.challenged');
    expect(audit?.detail).toMatchObject({
      claimId: item?.claim.id,
      sourceSha256: 'a'.repeat(64),
      outcome: 'completed',
      supports: 'supports',
      responseStatus: 'completed',
      usage: USAGE,
    });
    expect(audit?.detail).not.toHaveProperty('sourceText');
    expect(audit?.detail).not.toHaveProperty('rationale');
    expect(result.usage).toEqual(USAGE);
  });

  it.each(['contradicts', 'inconclusive'] as const)(
    'reports a %s assessment without inventing supporting evidence',
    async (supports) => {
      const analysis = provider({ id: 'xai' });
      const challenge = provider({
        id: 'openai',
        produce: (call) => ({ ...assessment(call), supports }),
      });
      const result = await extractClaimsWithProvider({
        provider: analysis.model,
        challengeProvider: challenge.model,
        input: input(),
        now: () => NOW,
      });
      expect(result.items[0]?.challenge).toMatchObject({
        outcome: 'completed',
        assessment: { supports },
      });
      expect(result.items[0]?.claim.status).toBe('contested');
      expect(result.items[0]?.promotion.ok).toBe(false);
      expect(result.items[0]?.evidence.provenance.providerIds).toEqual(['xai']);
    },
  );

  it('requires no challenger and retains the single-provider fallback', async () => {
    const analysis = provider({ id: 'xai' });
    const result = await createEvidenceEngine({
      provider: analysis.model,
      now: () => NOW,
    }).extractClaims(input());
    expect(analysis.calls).toHaveLength(1);
    expect(result.items[0]?.challenge).toBeUndefined();
    expect(result.items[0]?.providerRuns?.map((r) => r.taskKind)).toEqual([
      'analysis',
    ]);
    expect(
      result.items[0]?.promotion.reasons.some((r) => r.code === 'R7'),
    ).toBe(true);
    expect(result.items[0]?.claim.status).toBe('contested');
    expect(result.items[0]?.auditTrail).toHaveLength(2);
  });

  it.each([
    'contested',
    'insufficient-record',
    'destroyed-or-missing-record-suspected',
  ])('does not pay for a challenge of %s', async (status) => {
    const analysis = provider({
      id: 'xai',
      produce: () => analysisValue(status),
    });
    const challenge = provider({ id: 'openai', produce: assessment });
    const result = await createEvidenceEngine({
      provider: analysis.model,
      challengeProvider: challenge.model,
      now: () => NOW,
    }).extractClaims(input());
    expect(challenge.calls).toHaveLength(0);
    expect(result.items[0]?.challenge).toBeUndefined();
    expect(result.items[0]?.claim.status).toBe(status);
  });

  it('rejects same-provider configuration before either provider is called', async () => {
    const analysis = provider({ id: 'xai' });
    const challenge = provider({ id: 'xai', produce: assessment });
    await expect(
      createEvidenceEngine({
        provider: analysis.model,
        challengeProvider: challenge.model,
      }).extractClaims(input()),
    ).rejects.toThrow('must differ');
    expect(analysis.calls).toHaveLength(0);
    expect(challenge.calls).toHaveLength(0);
  });

  it.each([
    { status: 'incomplete', rawFinishReason: 'length' },
    { status: 'in_progress', rawFinishReason: 'stop' },
    { status: 'completed', rawFinishReason: 'content_filter' },
    { status: 'completed', rawFinishReason: 'length' },
  ])(
    'never challenges or records completed analysis for $status/$rawFinishReason',
    async (overrides) => {
      const analysis = provider({ id: 'xai', overrides });
      const challenge = provider({ id: 'openai', produce: assessment });
      const result = await createEvidenceEngine({
        provider: analysis.model,
        challengeProvider: challenge.model,
        now: () => NOW,
      }).extractClaims(input());
      expect(challenge.calls).toHaveLength(0);
      expect(result.items[0]?.providerRuns).toEqual([]);
      expect(result.items[0]?.challenge).toMatchObject({
        outcome: 'skipped',
        reason: 'analysis-incomplete',
      });
      expect(result.items[0]?.claim.status).toBe('contested');
      expect(
        result.items[0]?.promotion.reasons.some((r) => r.code === 'R7'),
      ).toBe(true);
    },
  );

  it.each([
    ['provider identity', { provider: 'openai' }],
    ['invalid metadata', { model: '' }],
    [
      'invalid candidate',
      {
        value: {
          ...analysisValue(),
          claims: [{ ...analysisValue().claims[0], text: 'short' }],
        },
      },
    ],
  ])(
    'rejects analysis with %s before challenge dispatch',
    async (_label, overrides) => {
      const analysis = provider({
        id: 'xai',
        overrides: overrides as Record<string, unknown>,
      });
      const challenge = provider({ id: 'openai', produce: assessment });
      await expect(
        createEvidenceEngine({
          provider: analysis.model,
          challengeProvider: challenge.model,
        }).extractClaims(input()),
      ).rejects.toThrow();
      expect(challenge.calls).toHaveLength(0);
    },
  );

  it.each([
    [
      'claim ID',
      (value: ReturnType<typeof assessment>) => ({
        ...value,
        claimId: ulid('OTHER'),
      }),
    ],
    [
      'claim text',
      (value: ReturnType<typeof assessment>) => ({
        ...value,
        claimText: 'A different claim is not the one that was extracted.',
      }),
    ],
    [
      'source hash',
      (value: ReturnType<typeof assessment>) => ({
        ...value,
        sourceSha256: 'b'.repeat(64),
      }),
    ],
    [
      'source kind',
      (value: ReturnType<typeof assessment>) => ({
        ...value,
        sourceRef: { ...value.sourceRef, kind: 'intake' },
      }),
    ],
    [
      'source ID',
      (value: ReturnType<typeof assessment>) => ({
        ...value,
        sourceRef: { ...value.sourceRef, id: ulid('OTHER') },
      }),
    ],
  ])(
    'refuses challenge evidence bound to a different %s',
    async (_label, change) => {
      const analysis = provider({ id: 'xai' });
      const challenge = provider({
        id: 'openai',
        produce: (call) => change(assessment(call)),
      });
      const result = await createEvidenceEngine({
        provider: analysis.model,
        challengeProvider: challenge.model,
        now: () => NOW,
      }).extractClaims(input());
      expect(result.items[0]?.challenge).toMatchObject({
        outcome: 'failed',
        reason: 'binding-mismatch',
      });
      expect(result.items[0]?.providerRuns).toHaveLength(1);
      expect(result.items[0]?.claim.status).toBe('contested');
      expect(
        result.items[0]?.promotion.reasons.some((r) => r.code === 'R7'),
      ).toBe(true);
    },
  );

  it.each([
    ['provider mismatch', { provider: 'xai' }, 'provider-mismatch'],
    ['incomplete', { status: 'incomplete' }, 'incomplete-response'],
    [
      'refusal terminator',
      { rawFinishReason: 'content_filter' },
      'incomplete-response',
    ],
    [
      'malformed assessment',
      { value: { supports: 'supports' } },
      'invalid-response',
    ],
    ['unknown status', { status: 'successful' }, 'invalid-response'],
    [
      'invalid usage',
      { usage: { ...USAGE, inputTokens: -1 } },
      'invalid-response',
    ],
    ['missing model', { model: undefined }, 'invalid-response'],
  ])(
    'keeps R7 and audited failure after %s',
    async (_label, overrides, reason) => {
      const analysis = provider({ id: 'xai' });
      const challenge = provider({
        id: 'openai',
        produce: assessment,
        overrides: overrides as Record<string, unknown>,
      });
      const result = await createEvidenceEngine({
        provider: analysis.model,
        challengeProvider: challenge.model,
        now: () => NOW,
      }).extractClaims(input());
      expect(challenge.calls).toHaveLength(1);
      expect(result.items[0]?.challenge).toMatchObject({
        outcome: 'failed',
        reason,
      });
      expect(result.items[0]?.providerRuns).toHaveLength(1);
      expect(
        result.items[0]?.promotion.reasons.some((r) => r.code === 'R7'),
      ).toBe(true);
      expect(
        result.items[0]?.auditTrail.find((r) => r.action === 'claim.challenged')
          ?.detail,
      ).toMatchObject({ outcome: 'failed', reason });
    },
  );

  it('contains provider exceptions without recording their sensitive text or retrying', async () => {
    const analysis = provider({ id: 'xai' });
    const secretText = 'Sensitive upstream error body must stay private';
    const challenge = provider({ id: 'openai', error: secretText });
    const result = await createEvidenceEngine({
      provider: analysis.model,
      challengeProvider: challenge.model,
      now: () => NOW,
    }).extractClaims(input());
    expect(challenge.calls).toHaveLength(1);
    expect(result.items[0]?.challenge).toMatchObject({
      outcome: 'failed',
      reason: 'provider-error',
    });
    expect(result.items[0]?.claim.status).toBe('contested');
    expect(result.items[0]?.providerRuns).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(secretText);
  });

  it('accepts reordered sourceRef fields and a missing optional response ID', async () => {
    const analysis = provider({
      id: 'xai',
      overrides: { responseId: undefined },
    });
    const challenge = provider({
      id: 'openai',
      overrides: { responseId: undefined },
      produce: (call) => {
        const value = assessment(call);
        return {
          ...value,
          sourceRef: { id: value.sourceRef.id, kind: value.sourceRef.kind },
        };
      },
    });
    const result = await createEvidenceEngine({
      provider: analysis.model,
      challengeProvider: challenge.model,
      now: () => NOW,
    }).extractClaims(input());
    expect(result.items[0]?.challenge?.outcome).toBe('completed');
    expect(
      result.items[0]?.providerRuns?.every((r) => r.responseId === undefined),
    ).toBe(true);
    expect(
      result.items[0]?.auditTrail.find((r) => r.action === 'claim.challenged')
        ?.detail,
    ).not.toHaveProperty('responseId');
  });

  it('dispatches bounded per-claim requests sequentially and preserves each claim binding', async () => {
    const analysis = provider({
      id: 'xai',
      produce: () => ({
        summary: 'Three extracted claims.',
        claims: [
          analysisValue().claims[0],
          {
            ...analysisValue('high-confidence').claims[0],
            text: 'The family requested the record before the refusal.',
          },
          analysisValue('contested').claims[0],
        ],
      }),
    });
    const calls: CompleteArgs<z.ZodType>[] = [];
    let active = 0;
    let maxActive = 0;
    const challenge: ModelProvider = {
      id: 'openai',
      complete: async <TSchema extends z.ZodType>(
        call: CompleteArgs<TSchema>,
      ): Promise<ModelResponse<z.infer<TSchema>>> => {
        active++;
        maxActive = Math.max(maxActive, active);
        calls.push(call);
        await Promise.resolve();
        active--;
        return {
          value: call.schema.parse(assessment(call)),
          provider: 'openai',
          model: 'test-model',
          status: 'completed',
          rawFinishReason: 'stop',
          usage: USAGE,
        };
      },
    };
    const result = await createEvidenceEngine({
      provider: analysis.model,
      challengeProvider: challenge,
      now: () => NOW,
    }).extractClaims(input({ maxClaims: 3 }));
    expect(maxActive).toBe(1);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.requestId)).size).toBe(2);
    expect(result.items.map((i) => i.challenge?.outcome)).toEqual([
      'completed',
      'completed',
      undefined,
    ]);
    for (const item of result.items.slice(0, 2)) {
      expect(
        item.providerRuns?.every(
          (r) => r.claimId === item.claim.id && r.claimText === item.claim.text,
        ),
      ).toBe(true);
      expect(item.providerRuns?.[1]?.requestId).toBe(
        `req-challenge:challenge:${item.claim.id}`,
      );
    }
  });

  it('forwards challenger configuration through the real xAI engine factory', async () => {
    const client: XaiClient = {
      chat: {
        completions: {
          create: () =>
            Promise.resolve({
              id: 'actual-adapter-response',
              model: 'configured-xai-model',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: JSON.stringify(analysisValue()),
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 2,
                completion_tokens: 3,
                total_tokens: 5,
              },
            }),
        },
      },
    };
    const challenge = provider({ id: 'openai', produce: assessment });
    const result = await createXaiEvidenceEngine({
      client,
      model: 'configured-xai-model',
      challengeProvider: challenge.model,
      now: () => NOW,
    }).extractClaims(input());
    expect(challenge.calls).toHaveLength(1);
    expect(result.items[0]?.providerRuns?.[0]?.responseId).toBe(
      'actual-adapter-response',
    );
    expect(result.items[0]?.challenge?.outcome).toBe('completed');
    expect(result.items[0]?.claim.status).toBe('contested');
  });
});
