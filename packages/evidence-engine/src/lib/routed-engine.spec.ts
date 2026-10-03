import type {
  CompleteArgs,
  LlmProviderId,
  ModelProvider,
  ModelResponse,
} from '@wsa/agent-contracts';
import {
  createAnthropicProvider,
  type AnthropicMessageRequest,
} from '@wsa/agent-anthropic';
import {
  AgentIdSchema,
  ArtefactIdSchema,
  ClaimExtractorSchema,
  ulid,
} from '@wsa/schemas';
import type { z } from 'zod';
import {
  createEvidenceEngine,
  createRoutedEvidenceEngine,
  type ExtractionInput,
} from '../index.js';

const NOW = new Date('2026-10-03T08:00:00Z');
const TEXT = 'The clerk refused to release the requested record.';

function input(): ExtractionInput {
  return {
    requestId: 'req-routing',
    sourceRef: {
      kind: 'artefact',
      id: ArtefactIdSchema.parse(ulid('ROUTE_SOURCE')),
    },
    sourceUrl: 'https://example.org/record',
    sourceSha256: 'a'.repeat(64),
    sourceFetchedAt: NOW.toISOString(),
    sourceText: TEXT,
    maxClaims: 1,
    maxOutputTokens: 321,
    timeoutMs: 4_321,
  };
}

function routing(
  analysis: LlmProviderId = 'xai',
  challenge: LlmProviderId = 'openai',
) {
  return {
    version: 1,
    lanes: { 'sensitive-intake': null, analysis, challenge },
  };
}

function adapter(id: LlmProviderId, incompleteChallenge = false) {
  const calls: CompleteArgs<z.ZodType>[] = [];
  const provider: ModelProvider = {
    id,
    complete: <TSchema extends z.ZodType>(
      call: CompleteArgs<TSchema>,
    ): Promise<ModelResponse<z.infer<TSchema>>> => {
      calls.push(call);
      const binding = JSON.parse(call.messages[1]?.content ?? '{}') as Readonly<
        Record<string, unknown>
      >;
      const value =
        call.taskKind === 'analysis'
          ? {
              summary: 'One extracted claim.',
              claims: [
                {
                  text: TEXT,
                  status: 'conclusive',
                  supports: 'supports',
                  rationale: 'The source describes a refusal.',
                },
              ],
            }
          : {
              claimId: binding.claimId,
              claimText: binding.claimText,
              sourceRef: binding.sourceRef,
              sourceSha256: binding.sourceSha256,
              supports: 'contradicts',
              rationale:
                'A refusal alone does not establish the claimed conclusion.',
            };
      return Promise.resolve({
        value: call.schema.parse(value),
        provider: id,
        model: `${id}-offline`,
        status:
          incompleteChallenge && call.taskKind === 'challenge'
            ? 'incomplete'
            : 'completed',
        rawFinishReason:
          incompleteChallenge && call.taskKind === 'challenge'
            ? 'length'
            : 'stop',
        responseId: `${id}-response`,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });
    },
  };
  return { provider, calls };
}

function adapters(incompleteChallenge = false) {
  const xai = adapter('xai');
  const openai = adapter('openai', incompleteChallenge);
  const unused = adapter('anthropic');
  return {
    xai,
    openai,
    unused,
    providers: {
      xai: xai.provider,
      openai: openai.provider,
      anthropic: unused.provider,
    },
  };
}

function anthropicAdapter(
  options: {
    stopReason?: string;
    invalidJson?: boolean;
    wrongBinding?: boolean;
    oversizedRationale?: boolean;
    extraClaim?: boolean;
  } = {},
) {
  const create = jest.fn((request: AnthropicMessageRequest) => {
    const binding = JSON.parse(
      request.messages.at(-1)?.content ?? '{}',
    ) as Record<string, unknown>;
    const candidate = {
      text: TEXT,
      status: 'conclusive',
      supports: 'supports',
      rationale: 'The supplied record describes a refusal.',
    };
    const value = Object.hasOwn(binding, 'claimId')
      ? {
          claimId: binding.claimId,
          claimText: options.wrongBinding
            ? 'A different claim about the supplied record.'
            : binding.claimText,
          sourceRef: binding.sourceRef,
          sourceSha256: binding.sourceSha256,
          supports: 'contradicts',
          rationale: options.oversizedRationale
            ? 'r'.repeat(501)
            : 'The record does not establish the claimed conclusion.',
        }
      : {
          summary: 'One extracted claim.',
          claims: options.extraClaim ? [candidate, candidate] : [candidate],
        };
    return Promise.resolve({
      id: 'anthropic-response',
      type: 'message' as const,
      role: 'assistant' as const,
      model: 'claude-offline',
      content: [
        {
          type: 'text' as const,
          text: options.invalidJson ? '{invalid' : JSON.stringify(value),
        },
      ],
      stop_reason: options.stopReason ?? 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 13,
        output_tokens: 7,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 5,
      },
    });
  });
  return {
    create,
    provider: createAnthropicProvider({
      client: { messages: { create } },
      model: 'claude-selected',
    }),
  };
}

describe('Anthropic adapter in shared routing', () => {
  it('runs the native adapter as a claim-bound challenger without changing primary evidence', async () => {
    const xai = adapter('xai');
    const anthropic = anthropicAdapter();
    const result = await createRoutedEvidenceEngine({
      routing: routing('xai', 'anthropic'),
      providers: { xai: xai.provider, anthropic: anthropic.provider },
      now: () => NOW,
    }).extractClaims(input());
    const item = result.items[0];
    expect(xai.calls).toHaveLength(1);
    expect(anthropic.create).toHaveBeenCalledTimes(1);
    const request = anthropic.create.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      model: 'claude-selected',
      max_tokens: 321,
      output_config: { format: { type: 'json_schema' } },
    });
    expect(request).not.toHaveProperty('metadata');
    expect(JSON.parse(request?.messages.at(-1)?.content ?? '{}')).toEqual({
      claimId: item?.claim.id,
      claimText: TEXT,
      sourceRef: input().sourceRef,
      sourceSha256: input().sourceSha256,
      sourceText: TEXT,
    });
    expect(item?.challenge).toMatchObject({
      outcome: 'completed',
      provider: 'anthropic',
      model: 'claude-offline',
      responseId: 'anthropic-response',
      rawFinishReason: 'end_turn',
      assessment: {
        claimId: item?.claim.id,
        claimText: TEXT,
        sourceRef: input().sourceRef,
        sourceSha256: input().sourceSha256,
        supports: 'contradicts',
      },
      usage: {
        inputTokens: 21,
        outputTokens: 7,
        totalTokens: 28,
        cachedInputTokens: 5,
      },
    });
    expect(item?.providerRuns?.map((run) => run.provider)).toEqual([
      'xai',
      'anthropic',
    ]);
    expect(item?.providerRuns?.[1]).toMatchObject({
      requestId: `req-routing:challenge:${String(item?.claim.id)}`,
      claimText: TEXT,
      sourceRef: input().sourceRef,
      sourceSha256: input().sourceSha256,
    });
    const reasons = item?.promotion.reasons.map((reason) => reason.code);
    expect(reasons).not.toContain('R7');
    expect(reasons).toEqual(expect.arrayContaining(['R2', 'R3', 'R4']));
    expect(item?.claim.status).toBe('contested');
    expect(item?.evidence.evidence.kind).toBe('other');
    expect(item?.evidence.provenance).toEqual({
      providerIds: ['xai'],
      modelGenerated: true,
    });
    expect(result.usage.totalTokens).toBe(15);
  });

  it('uses the real extraction schema with native analysis and a distinct challenger', async () => {
    const anthropic = anthropicAdapter();
    const xai = adapter('xai');
    const result = await createRoutedEvidenceEngine({
      routing: routing('anthropic', 'xai'),
      providers: { anthropic: anthropic.provider, xai: xai.provider },
      now: () => NOW,
    }).extractClaims(input());
    expect(anthropic.create).toHaveBeenCalledTimes(1);
    expect(xai.calls).toHaveLength(1);
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-offline');
    expect(result.usage).toEqual({
      inputTokens: 21,
      outputTokens: 7,
      totalTokens: 28,
      cachedInputTokens: 5,
    });
    expect(result.items[0]?.challenge?.outcome).toBe('completed');
    expect(result.items[0]?.evidence.provenance).toEqual({
      providerIds: ['anthropic'],
      modelGenerated: true,
    });
    const reasons = result.items[0]?.promotion.reasons.map(
      (reason) => reason.code,
    );
    expect(reasons).not.toContain('R7');
    expect(reasons).not.toContain('R2');
    expect(reasons).toEqual(expect.arrayContaining(['R3', 'R4']));
  });

  it.each([
    'max_tokens',
    'stop_sequence',
    'tool_use',
    'pause_turn',
    'refusal',
    'model_context_window_exceeded',
    'future_stop_reason',
  ])('retains R7 for native challenger stop reason %s', async (stopReason) => {
    const xai = adapter('xai');
    const anthropic = anthropicAdapter({ stopReason });
    const result = await createRoutedEvidenceEngine({
      routing: routing('xai', 'anthropic'),
      providers: { xai: xai.provider, anthropic: anthropic.provider },
      now: () => NOW,
    }).extractClaims(input());
    expect(anthropic.create).toHaveBeenCalledTimes(1);
    expect(result.items[0]?.challenge).toMatchObject({
      outcome: 'failed',
      reason: 'incomplete-response',
      provider: 'anthropic',
      rawFinishReason: stopReason,
      responseStatus: 'incomplete',
    });
    expect(result.items[0]?.providerRuns).toHaveLength(1);
    expect(result.items[0]?.claim.status).toBe('contested');
    expect(
      result.items[0]?.promotion.reasons.map((reason) => reason.code),
    ).toContain('R7');
  });

  it.each([
    [{ invalidJson: true }, 'provider-error'],
    [{ oversizedRationale: true }, 'provider-error'],
    [{ wrongBinding: true }, 'binding-mismatch'],
  ] as const)(
    'retains R7 for invalid native challenge output %j',
    async (options, reason) => {
      const xai = adapter('xai');
      const anthropic = anthropicAdapter(options);
      const result = await createRoutedEvidenceEngine({
        routing: routing('xai', 'anthropic'),
        providers: { xai: xai.provider, anthropic: anthropic.provider },
        now: () => NOW,
      }).extractClaims(input());
      expect(result.items[0]?.challenge).toMatchObject({
        outcome: 'failed',
        reason,
      });
      expect(result.items[0]?.providerRuns).toHaveLength(1);
      expect(
        result.items[0]?.promotion.reasons.map((entry) => entry.code),
      ).toContain('R7');
    },
  );

  it('still rejects extraction beyond the original claim cap after wire-schema normalization', async () => {
    const anthropic = anthropicAdapter({ extraClaim: true });
    const xai = adapter('xai');
    const engine = createRoutedEvidenceEngine({
      routing: routing('anthropic', 'xai'),
      providers: { anthropic: anthropic.provider, xai: xai.provider },
      now: () => NOW,
    });
    await expect(engine.extractClaims(input())).rejects.toThrow();
    expect(anthropic.create).toHaveBeenCalledTimes(1);
    expect(xai.calls).toHaveLength(0);
  });

  it('skips challenge calls when native analysis is incomplete', async () => {
    const anthropic = anthropicAdapter({ stopReason: 'max_tokens' });
    const xai = adapter('xai');
    const result = await createRoutedEvidenceEngine({
      routing: routing('anthropic', 'xai'),
      providers: { anthropic: anthropic.provider, xai: xai.provider },
      now: () => NOW,
    }).extractClaims(input());
    expect(xai.calls).toHaveLength(0);
    expect(result.items[0]?.challenge).toMatchObject({
      outcome: 'skipped',
      reason: 'analysis-incomplete',
    });
    expect(
      result.items[0]?.promotion.reasons.map((reason) => reason.code),
    ).toContain('R7');
  });
});

describe('createRoutedEvidenceEngine', () => {
  it.each([
    ['xai', 'openai'],
    ['openai', 'xai'],
  ] as const)(
    'uses configured %s analysis and %s challenge with real claim-bound evidence',
    async (analysisId, challengeId) => {
      const { xai, openai, unused, providers } = adapters();
      const ids = [ulid('ROUTE_CLAIM'), ulid('ROUTE_EVIDENCE')];
      let nextId = 0;
      const result = await createRoutedEvidenceEngine({
        routing: routing(analysisId, challengeId),
        providers,
        actorId: AgentIdSchema.parse('agent:source-verifier'),
        extractorId: ClaimExtractorSchema.parse('agent:source-verifier'),
        now: () => NOW,
        createId: () => ids[nextId++] ?? ulid('EXTRA'),
      }).extractClaims(input());
      const item = result.items[0];
      const analysis = analysisId === 'xai' ? xai : openai;
      const challenge = challengeId === 'openai' ? openai : xai;
      expect(analysis.calls).toHaveLength(1);
      expect(challenge.calls).toHaveLength(1);
      expect(unused.calls).toHaveLength(0);
      expect(analysis.calls[0]).toMatchObject({
        taskKind: 'analysis',
        requestId: 'req-routing',
        maxOutputTokens: 321,
        timeoutMs: 4_321,
      });
      expect(challenge.calls[0]).toMatchObject({
        taskKind: 'challenge',
        requestId: `req-routing:challenge:${String(item?.claim.id)}`,
        maxOutputTokens: 321,
        timeoutMs: 4_321,
      });
      expect(result.provider).toBe(analysisId);
      expect(item?.claim.id).toBe(ids[0]);
      expect(item?.claim.extractedBy).toBe('agent:source-verifier');
      expect(item?.claim.assertedAt).toBe(NOW.toISOString());
      expect(item?.auditTrail[0]?.actor).toBe('agent:source-verifier');
      expect(item?.challenge).toMatchObject({
        outcome: 'completed',
        provider: challengeId,
        assessment: {
          claimId: ids[0],
          claimText: TEXT,
          sourceRef: input().sourceRef,
          sourceSha256: input().sourceSha256,
          supports: 'contradicts',
        },
      });
      expect(
        item?.providerRuns?.map((run) => [run.taskKind, run.provider]),
      ).toEqual([
        ['analysis', analysisId],
        ['challenge', challengeId],
      ]);
      expect(
        item?.promotion.reasons.map((reason) => reason.code),
      ).not.toContain('R7');
      expect(item?.promotion.reasons.map((reason) => reason.code)).toEqual(
        expect.arrayContaining(['R3', 'R4']),
      );
      expect(
        item?.promotion.reasons.some((reason) => reason.code === 'R2'),
      ).toBe(analysisId === 'xai');
      expect(item?.claim.status).toBe('contested');
      expect(item?.evidence.evidence.kind).toBe('other');
      expect(item?.evidence.provenance).toEqual({
        providerIds: [analysisId],
        modelGenerated: true,
      });
      expect(result.usage.totalTokens).toBe(15);
      expect(item?.challenge?.usage?.totalTokens).toBe(15);
    },
  );

  it('retains failed challenge outcome and R7 when routed output is incomplete', async () => {
    const { xai, openai, providers } = adapters(true);
    const result = await createRoutedEvidenceEngine({
      routing: routing(),
      providers,
      now: () => NOW,
    }).extractClaims(input());
    expect(xai.calls).toHaveLength(1);
    expect(openai.calls).toHaveLength(1);
    expect(result.items[0]?.challenge).toMatchObject({
      outcome: 'failed',
      reason: 'incomplete-response',
    });
    expect(result.items[0]?.providerRuns).toHaveLength(1);
    expect(
      result.items[0]?.promotion.reasons.map((reason) => reason.code),
    ).toContain('R7');
    expect(result.items[0]?.claim.status).toBe('contested');
  });

  it('snapshots route config and registry selections at construction', async () => {
    const { xai, openai, providers } = adapters();
    const config = routing();
    const engine = createRoutedEvidenceEngine({
      routing: config,
      providers,
      now: () => NOW,
    });
    config.lanes.analysis = 'openai';
    config.lanes.challenge = 'xai';
    const replacement = adapter('xai');
    providers.xai = replacement.provider;
    const result = await engine.extractClaims(input());
    expect(result.provider).toBe('xai');
    expect(result.items[0]?.challenge?.provider).toBe('openai');
    expect(xai.calls).toHaveLength(1);
    expect(openai.calls).toHaveLength(1);
    expect(replacement.calls).toHaveLength(0);
  });

  it.each(['xai', 'openai'] as const)(
    'rechecks %s identity before each extraction, including later calls',
    async (id) => {
      const { xai, openai, providers } = adapters();
      const engine = createRoutedEvidenceEngine({
        routing: routing(),
        providers,
        now: () => NOW,
      });
      await engine.extractClaims(input());
      Reflect.set(providers[id], 'id', 'local');
      await expect(engine.extractClaims(input())).rejects.toThrow(
        `configured provider identity mismatch: ${id}`,
      );
      expect(xai.calls).toHaveLength(1);
      expect(openai.calls).toHaveLength(1);
    },
  );

  it.each(['xai', 'openai'] as const)(
    'rejects %s callable drift before either first call',
    async (id) => {
      const { xai, openai, providers } = adapters();
      const engine = createRoutedEvidenceEngine({
        routing: routing(),
        providers,
        now: () => NOW,
      });
      Reflect.set(providers[id], 'complete', null);
      await expect(engine.extractClaims(input())).rejects.toThrow(
        `configured provider cannot complete calls: ${id}`,
      );
      expect(xai.calls).toHaveLength(0);
      expect(openai.calls).toHaveLength(0);
    },
  );

  it('rejects a missing challenger at construction before analysis can cost anything', () => {
    const { xai, openai, providers } = adapters();
    expect(() =>
      createRoutedEvidenceEngine({
        routing: routing(),
        providers: { xai: providers.xai },
      }),
    ).toThrow('configured provider is unavailable: openai');
    expect(xai.calls).toHaveLength(0);
    expect(openai.calls).toHaveLength(0);
  });

  it('refuses sensitive routing configuration without provider calls', () => {
    const { xai, openai, providers } = adapters();
    expect(() =>
      createRoutedEvidenceEngine({
        routing: {
          ...routing(),
          lanes: { ...routing().lanes, 'sensitive-intake': 'openai' },
        },
        providers,
      }),
    ).toThrow();
    expect(xai.calls).toHaveLength(0);
    expect(openai.calls).toHaveLength(0);
  });

  it('leaves the existing default factory single-provider even when registry adapters exist', async () => {
    const { xai, openai, providers } = adapters();
    const result = await createEvidenceEngine({
      provider: providers.xai,
      now: () => NOW,
    }).extractClaims(input());
    expect(xai.calls).toHaveLength(1);
    expect(openai.calls).toHaveLength(0);
    expect(result.items[0]?.challenge).toBeUndefined();
    expect(
      result.items[0]?.promotion.reasons.map((reason) => reason.code),
    ).toContain('R7');
    expect(result.items[0]?.claim.status).toBe('contested');
  });
});
