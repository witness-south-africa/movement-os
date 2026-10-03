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
import { createRoutedEvidenceEngine, type ExtractionInput } from '../index.js';

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

function peer(): ModelProvider {
  const fake = createFakeProvider({
    id: 'xai',
    model: 'xai-offline',
    produce: (schema) => schema.parse(extraction),
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

function engine(analysis: 'openai' | 'xai', openai: ModelProvider) {
  return createRoutedEvidenceEngine({
    routing: {
      version: 1,
      lanes: {
        'sensitive-intake': null,
        analysis,
        challenge: analysis === 'openai' ? 'xai' : 'openai',
      },
    },
    providers: { openai, xai: peer() },
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
