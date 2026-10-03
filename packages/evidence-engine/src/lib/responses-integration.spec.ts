import {
  createFakeProvider,
  type ModelProvider,
  type CompleteArgs,
  type ModelResponse,
} from '@wsa/agent-contracts';
import {
  createOpenAiResponsesProvider,
  createOpenAiResponsesFetchClient,
  type OpenAiAccessMode,
} from '@wsa/agent-openai';
import { ArtefactIdSchema, ulid } from '@wsa/schemas';
import type { z } from 'zod';
import {
  createRoutedEvidenceEngine,
  type ExtractionInput,
  type OpenAiSubscriptionPolicy,
} from '../index.js';

const TEXT = 'The clerk refused to release the requested record.';
const NOW = new Date('2026-10-03T12:00:00Z');
const input: ExtractionInput = {
  requestId: 'req-responses-engine',
  sourceRef: {
    kind: 'artefact',
    id: ArtefactIdSchema.parse(ulid('RESPONSES_SOURCE')),
  },
  sourceUrl: 'https://example.org/record',
  sourceSha256: 'b'.repeat(64),
  sourceFetchedAt: NOW.toISOString(),
  sourceText: TEXT,
  maxClaims: 1,
  maxOutputTokens: 321,
};
const extraction = {
  summary: 'One extracted claim.',
  claims: [
    {
      text: TEXT,
      status: 'conclusive',
      supports: 'supports',
      rationale: 'The source describes a refusal.',
    },
  ],
};

function challenge(binding: Record<string, unknown>) {
  return {
    claimId: binding.claimId,
    claimText: binding.claimText,
    sourceRef: binding.sourceRef,
    sourceSha256: binding.sourceSha256,
    supports: 'contradicts',
    rationale: 'A refusal alone does not establish the conclusion.',
  };
}

function responses(mode: OpenAiAccessMode = 'api', failed = false) {
  const resolveCredential = jest.fn(() =>
    Promise.resolve(
      mode === 'api'
        ? { accessMode: 'api' as const, apiKey: 'unit-api-token' }
        : {
            accessMode: 'subscription' as const,
            accessToken: 'unit-sub-token',
            planUsageAuthorized: true as const,
          },
    ),
  );
  const fetch = jest.fn((_url: string, init: RequestInit) => {
    if (typeof init.body !== 'string') {
      throw new Error('expected serialized JSON request');
    }
    const body = JSON.parse(init.body);
    const binding = JSON.parse(body.input.at(-1).content);
    const value =
      body.text.format.schema.properties.claimId === undefined
        ? extraction
        : challenge(binding);
    const event = failed
      ? {
          type: 'response.failed',
          response: {
            error: { code: 'subscription_sharing_usage_limit_exceeded' },
          },
        }
      : {
          type: 'response.completed',
          response: {
            object: 'response',
            id: 'resp-engine',
            model: 'selected-offline',
            status: 'completed',
            output: [
              {
                type: 'message',
                id: 'msg-engine',
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify(value),
                    annotations: [],
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
          },
        };
    return Promise.resolve(
      new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
  });
  const client = createOpenAiResponsesFetchClient(
    mode === 'api'
      ? {
          accessMode: mode,
          resolveApiKey: resolveCredential as () => Promise<{
            accessMode: 'api';
            apiKey: string;
          }>,
          fetch,
        }
      : {
          accessMode: mode,
          hosting: 'local',
          resolveAccessToken: resolveCredential as () => Promise<{
            accessMode: 'subscription';
            accessToken: string;
            planUsageAuthorized: true;
          }>,
          fetch,
        },
  );
  return {
    provider: createOpenAiResponsesProvider({
      client,
      model: 'selected-model',
    }),
    fetch,
    resolveCredential,
  };
}

function peer(value = extraction): ModelProvider {
  const fake = createFakeProvider({
    id: 'xai',
    model: 'xai-offline',
    produce: (schema) => schema.parse(value),
  });
  return {
    id: 'xai',
    complete<TSchema extends z.ZodType>(
      args: CompleteArgs<TSchema>,
    ): Promise<ModelResponse<z.infer<TSchema>>> {
      if (args.taskKind === 'analysis') return fake.complete(args);
      const binding = JSON.parse(args.messages.at(-1)?.content ?? '{}');
      return Promise.resolve({
        value: args.schema.parse(challenge(binding)),
        provider: 'xai',
        model: 'xai-offline',
        status: 'completed',
        rawFinishReason: 'stop',
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      });
    },
  };
}

function engine(
  analysis: 'openai' | 'xai',
  openai: ModelProvider,
  subscriptionPolicy?: OpenAiSubscriptionPolicy,
  other: ModelProvider = peer(),
) {
  return createRoutedEvidenceEngine({
    routing: {
      version: 1,
      lanes: {
        'sensitive-intake': null,
        analysis,
        challenge: analysis === 'openai' ? 'xai' : 'openai',
      },
    },
    providers: { openai, xai: other },
    ...(subscriptionPolicy === undefined ? {} : { subscriptionPolicy }),
    now: () => NOW,
  });
}

describe('Responses transport in actual evidence-engine lanes', () => {
  it.each(['analysis', 'challenge'] as const)(
    'validates the actual %s schema over fetch/SSE in API mode',
    async (lane) => {
      const openai = responses();
      const result = await engine(
        lane === 'analysis' ? 'openai' : 'xai',
        openai.provider,
      ).extractClaims(input);
      expect(openai.fetch).toHaveBeenCalledTimes(1);
      expect(openai.resolveCredential).toHaveBeenCalledTimes(1);
      const body = openai.fetch.mock.calls[0]?.[1].body;
      if (typeof body !== 'string') {
        throw new Error('expected serialized JSON request');
      }
      const request = JSON.parse(body);
      expect(request).toMatchObject({
        max_output_tokens: 321,
        stream: true,
        store: false,
        text: {
          format: {
            type: 'json_schema',
            strict: true,
            schema: { type: 'object', additionalProperties: false },
          },
        },
      });
      expect(request).not.toHaveProperty('user');
      expect(request).not.toHaveProperty('metadata');
      expect(result.items[0]?.challenge?.outcome).toBe('completed');
      const reasons = result.items[0]?.promotion.reasons.map(
        (reason) => reason.code,
      );
      expect(reasons).not.toContain('R7');
      expect(reasons).toEqual(expect.arrayContaining(['R3', 'R4']));
      expect(result.items[0]?.claim.status).toBe('contested');
      if (lane === 'analysis') {
        expect(result.usage).toEqual({
          inputTokens: 21,
          outputTokens: 7,
          totalTokens: 28,
          cachedInputTokens: 5,
        });
      } else {
        expect(result.items[0]?.challenge).toMatchObject({
          provider: 'openai',
          responseId: 'resp-engine',
          assessment: {
            claimText: TEXT,
            sourceRef: input.sourceRef,
            sourceSha256: input.sourceSha256,
          },
          usage: { totalTokens: 28 },
        });
        expect(reasons).toContain('R2');
      }
    },
  );

  it('rejects capped subscription analysis before credentials or network', async () => {
    const openai = responses('subscription');
    await expect(
      engine('openai', openai.provider).extractClaims(input),
    ).rejects.toMatchObject({ code: 'unsupported_request' });
    expect(openai.resolveCredential).not.toHaveBeenCalled();
    expect(openai.fetch).not.toHaveBeenCalled();
  });

  it('preserves R7 on unsupported capped subscription challenge without network', async () => {
    const openai = responses('subscription');
    const result = await engine('xai', openai.provider).extractClaims(input);
    expect(result.items[0]?.challenge).toMatchObject({
      outcome: 'failed',
      reason: 'provider-error',
    });
    expect(
      result.items[0]?.promotion.reasons.map((reason) => reason.code),
    ).toContain('R7');
    expect(openai.resolveCredential).not.toHaveBeenCalled();
    expect(openai.fetch).not.toHaveBeenCalled();
  });

  it('preserves R7 for a failed stream with no API retry or fallback', async () => {
    const openai = responses('api', true);
    const result = await engine('xai', openai.provider).extractClaims(input);
    expect(result.items[0]?.challenge).toMatchObject({
      outcome: 'failed',
      reason: 'provider-error',
    });
    expect(
      result.items[0]?.promotion.reasons.map((reason) => reason.code),
    ).toContain('R7');
    expect(openai.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not treat OpenAI subscription and API as distinct challenge providers', () => {
    const api = responses('api');
    const subscription = responses('subscription');
    expect(() =>
      createRoutedEvidenceEngine({
        routing: {
          version: 1,
          lanes: {
            'sensitive-intake': null,
            analysis: 'openai',
            challenge: 'openai',
          },
        },
        providers: { openai: api.provider, xai: subscription.provider },
      }),
    ).toThrow();
    expect(api.fetch).not.toHaveBeenCalled();
    expect(subscription.fetch).not.toHaveBeenCalled();
  });
});

function withoutCap(): ExtractionInput {
  const result = { ...input };
  Reflect.deleteProperty(result, 'maxOutputTokens');
  return result;
}

describe('explicit subscription policy over actual fetch/SSE', () => {
  it.each(['analysis', 'challenge'] as const)(
    'omits the unsupported field only for subscription %s and records actual mode',
    async (lane) => {
      const openai = responses('subscription');
      const other = peer();
      const complete = jest.spyOn(other, 'complete');
      const result = await engine(
        lane === 'analysis' ? 'openai' : 'xai',
        openai.provider,
        { lane, allowUncappedOutput: true },
        other,
      ).extractClaims(withoutCap());
      expect(openai.fetch).toHaveBeenCalledTimes(1);
      expect(openai.resolveCredential).toHaveBeenCalledTimes(1);
      const body = openai.fetch.mock.calls[0]?.[1].body;
      if (typeof body !== 'string')
        throw new Error('expected JSON request body');
      const request = JSON.parse(body);
      expect(request).not.toHaveProperty('max_output_tokens');
      expect(request).toMatchObject({ store: false, stream: true });
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0]?.[0]).toMatchObject({
        maxOutputTokens: 900,
        timeoutMs: 20_000,
      });
      const item = result.items[0];
      expect(
        item?.providerRuns?.find((run) => run.provider === 'openai'),
      ).toMatchObject({ accessMode: 'subscription', taskKind: lane });
      expect(
        item?.auditTrail.find(
          (record) =>
            record.action ===
            (lane === 'analysis' ? 'claim.extracted' : 'claim.challenged'),
        )?.detail,
      ).toMatchObject({ accessMode: 'subscription' });
      expect(
        item?.promotion.reasons.map((reason) => reason.code),
      ).not.toContain('R7');
      expect(item?.promotion.reasons.map((reason) => reason.code)).toEqual(
        expect.arrayContaining(['R3', 'R4']),
      );
      expect(item?.claim.status).toBe('contested');
      if (lane === 'analysis') {
        expect(result.accessMode).toBe('subscription');
        expect(result.usage).toMatchObject({ totalTokens: 28 });
      } else {
        expect(result).not.toHaveProperty('accessMode');
        expect(item?.challenge).toMatchObject({
          accessMode: 'subscription',
          outcome: 'completed',
          usage: { totalTokens: 28 },
        });
      }
    },
  );

  it.each(['analysis', 'challenge'] as const)(
    'rejects explicit global caps before either %s pairing can dispatch',
    async (lane) => {
      const openai = responses('subscription');
      const other = peer();
      const complete = jest.spyOn(other, 'complete');
      await expect(
        engine(
          lane === 'analysis' ? 'openai' : 'xai',
          openai.provider,
          { lane, allowUncappedOutput: true },
          other,
        ).extractClaims(input),
      ).rejects.toThrow('output cap conflicts with subscription policy');
      expect(openai.resolveCredential).not.toHaveBeenCalled();
      expect(openai.fetch).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it('rejects exhausted subscription analysis with one call and no fallback', async () => {
    const openai = responses('subscription', true);
    const other = peer();
    const complete = jest.spyOn(other, 'complete');
    await expect(
      engine(
        'openai',
        openai.provider,
        { lane: 'analysis', allowUncappedOutput: true },
        other,
      ).extractClaims(withoutCap()),
    ).rejects.toMatchObject({ code: 'quota_exhausted' });
    expect(openai.fetch).toHaveBeenCalledTimes(1);
    expect(openai.resolveCredential).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('stops the exhausted subscription challenge batch, retains R7 and resets next extract', async () => {
    const openai = responses('subscription', true);
    const candidate = extraction.claims[0];
    if (candidate === undefined) throw new Error('missing test claim');
    const other = peer({
      ...extraction,
      claims: [
        candidate,
        {
          ...candidate,
          text: 'The clerk did not supply the requested record.',
        },
        { ...candidate, status: 'contested' },
      ],
    });
    const complete = jest.spyOn(other, 'complete');
    const configured = engine(
      'xai',
      openai.provider,
      { lane: 'challenge', allowUncappedOutput: true },
      other,
    );
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await configured.extractClaims({
        ...withoutCap(),
        maxClaims: 3,
      });
      expect(result.items[0]?.challenge).toMatchObject({
        outcome: 'failed',
        reason: 'quota-exhausted',
      });
      expect(result.items[1]?.challenge).toMatchObject({
        outcome: 'skipped',
        reason: 'subscription-quota-exhausted',
      });
      expect(result.items[2]).not.toHaveProperty('challenge');
      for (const item of result.items.slice(0, 2)) {
        expect(item.promotion.reasons.map((reason) => reason.code)).toContain(
          'R7',
        );
        expect(item.providerRuns).toHaveLength(1);
        expect(item.claim.status).toBe('contested');
      }
      expect(openai.fetch).toHaveBeenCalledTimes(attempt);
      expect(openai.resolveCredential).toHaveBeenCalledTimes(attempt);
      expect(complete).toHaveBeenCalledTimes(attempt);
    }
  });

  it('keeps default API caps and reports observed API mode', async () => {
    const openai = responses('api');
    const result = await engine('openai', openai.provider).extractClaims(
      withoutCap(),
    );
    const body = openai.fetch.mock.calls[0]?.[1].body;
    if (typeof body !== 'string') throw new Error('expected JSON request body');
    const request = JSON.parse(body);
    expect(request.max_output_tokens).toBe(900);
    expect(result.accessMode).toBe('api');
    expect(result.items[0]?.providerRuns?.[0]).toMatchObject({
      accessMode: 'api',
    });
  });
});
