import {
  createFakeProvider,
  type CompleteArgs,
  type ModelProvider,
  type ModelResponse,
} from '@wsa/agent-contracts';
import { ArtefactIdSchema, ulid } from '@wsa/schemas';
import type { z } from 'zod';
import {
  createEvidenceEngine,
  createRoutedEvidenceEngine,
  extractClaimsWithProvider,
  type EvidenceEngineConfig,
  type ExtractionInput,
  type OpenAiSubscriptionPolicy,
} from '../index.js';

const TEXT = 'The clerk refused to release the requested record.';
const input: ExtractionInput = {
  requestId: 'policy-regression',
  sourceRef: {
    kind: 'artefact',
    id: ArtefactIdSchema.parse(ulid('POLICY_SOURCE')),
  },
  sourceUrl: 'https://example.org/source',
  sourceSha256: 'b'.repeat(64),
  sourceFetchedAt: '2026-10-03T12:00:00Z',
  sourceText: TEXT,
  maxClaims: 3,
};
const extraction = {
  summary: 'A claim.',
  claims: [
    {
      text: TEXT,
      status: 'conclusive',
      supports: 'supports',
      rationale: 'The record states a refusal.',
    },
  ],
};
const policy: OpenAiSubscriptionPolicy = {
  lane: 'analysis',
  allowUncappedOutput: true,
};

interface Hooks {
  after?: () => void;
  reportMode?: 'api' | 'subscription' | 'missing';
  claims?: number;
}
interface MutableProvider {
  id: ModelProvider['id'];
  accessMode?: 'api' | 'subscription';
  complete: ModelProvider['complete'];
}

function provider(
  id: ModelProvider['id'],
  mode?: 'api' | 'subscription',
  hooks: Hooks = {},
): MutableProvider {
  const fake = createFakeProvider({
    id,
    model: 'offline',
    produce: (schema) =>
      schema.parse({
        ...extraction,
        claims: Array.from(
          { length: hooks.claims ?? 1 },
          () => extraction.claims[0],
        ),
      }),
  });
  return {
    id,
    ...(mode === undefined ? {} : { accessMode: mode }),
    async complete<TSchema extends z.ZodType>(
      args: CompleteArgs<TSchema>,
    ): Promise<ModelResponse<z.infer<TSchema>>> {
      const binding = JSON.parse(args.messages.at(-1)?.content ?? '{}');
      const result =
        args.taskKind === 'analysis'
          ? await fake.complete(args)
          : {
              value: args.schema.parse({
                claimId: binding.claimId,
                claimText: binding.claimText,
                sourceRef: binding.sourceRef,
                sourceSha256: binding.sourceSha256,
                supports: 'supports',
                rationale: 'The source matches.',
              }),
              provider: id,
              model: 'offline',
              status: 'completed' as const,
              rawFinishReason: 'stop',
              usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
            };
      hooks.after?.();
      const reportMode = hooks.reportMode ?? mode;
      return {
        ...result,
        ...(reportMode === undefined || reportMode === 'missing'
          ? {}
          : { accessMode: reportMode }),
      };
    },
  };
}

function config(
  lane: 'analysis' | 'challenge' = 'analysis',
  hooks: Hooks = {},
) {
  const openai = provider('openai', 'subscription', hooks);
  const xai = provider('xai');
  const openaiCalls = jest.spyOn(openai, 'complete');
  const xaiCalls = jest.spyOn(xai, 'complete');
  const options: EvidenceEngineConfig = {
    provider: lane === 'analysis' ? openai : xai,
    challengeProvider: lane === 'analysis' ? xai : openai,
    subscriptionPolicy: { lane, allowUncappedOutput: true },
  };
  return { openai, xai, openaiCalls, xaiCalls, options };
}

describe('engine subscription policy boundaries', () => {
  it.each([
    null,
    {},
    { lane: 'analysis' },
    { lane: 'analysis', allowUncappedOutput: false },
    { lane: 'challenge', allowUncappedOutput: 1 },
    { lane: 'sensitive-intake', allowUncappedOutput: true },
    { lane: 'analysis', allowUncappedOutput: true, fallback: 'api' },
  ])('rejects malformed policy %j before effects', (invalid) => {
    const test = config();
    expect(() =>
      createEvidenceEngine({
        ...test.options,
        subscriptionPolicy: invalid as OpenAiSubscriptionPolicy,
      }),
    ).toThrow('invalid subscription policy');
    expect(test.openaiCalls).not.toHaveBeenCalled();
    expect(test.xaiCalls).not.toHaveBeenCalled();
  });

  it.each(['api', undefined] as const)(
    'rejects OpenAI mode %s before effects',
    (mode) => {
      const test = config();
      if (mode === undefined) Reflect.deleteProperty(test.openai, 'accessMode');
      else test.openai.accessMode = mode;
      expect(() => createEvidenceEngine(test.options)).toThrow(
        'subscription policy requires an OpenAI subscription lane',
      );
      expect(test.openaiCalls).not.toHaveBeenCalled();
      expect(test.xaiCalls).not.toHaveBeenCalled();
    },
  );

  it('rejects wrong policy lane and absent subscription challenger', () => {
    const test = config();
    expect(() =>
      createEvidenceEngine({
        ...test.options,
        subscriptionPolicy: { lane: 'challenge', allowUncappedOutput: true },
      }),
    ).toThrow('subscription policy requires an OpenAI subscription lane');
    expect(() =>
      createEvidenceEngine({
        provider: test.xai,
        subscriptionPolicy: { lane: 'challenge', allowUncappedOutput: true },
      }),
    ).toThrow('subscription policy requires an OpenAI subscription lane');
    expect(test.openaiCalls).not.toHaveBeenCalled();
    expect(test.xaiCalls).not.toHaveBeenCalled();
  });

  it('rejects the same OpenAI vendor in both modes before effects', () => {
    const test = config();
    const api = provider('openai', 'api');
    const apiCalls = jest.spyOn(api, 'complete');
    expect(() =>
      createEvidenceEngine({ ...test.options, challengeProvider: api }),
    ).toThrow('challenge provider must differ');
    expect(test.openaiCalls).not.toHaveBeenCalled();
    expect(apiCalls).not.toHaveBeenCalled();
  });

  it('snapshots policy and selected instances at factory construction', async () => {
    const test = config();
    const mutablePolicy = {
      lane: 'analysis' as 'analysis' | 'challenge',
      allowUncappedOutput: true as const,
    };
    const options = { ...test.options, subscriptionPolicy: mutablePolicy };
    const configured = createEvidenceEngine(options);
    mutablePolicy.lane = 'challenge';
    options.provider = provider('openai', 'api');
    options.challengeProvider = provider('anthropic');
    const result = await configured.extractClaims(input);
    expect(result.accessMode).toBe('subscription');
    expect(test.openaiCalls.mock.calls[0]?.[0]).not.toHaveProperty(
      'maxOutputTokens',
    );
    expect(test.xaiCalls.mock.calls[0]?.[0].maxOutputTokens).toBe(900);
  });

  it.each(['id', 'mode', 'complete'] as const)(
    'refuses %s drift before a routed call',
    async (field) => {
      const test = config();
      const configured = createRoutedEvidenceEngine({
        routing: {
          version: 1,
          lanes: {
            'sensitive-intake': null,
            analysis: 'openai',
            challenge: 'xai',
          },
        },
        providers: { openai: test.openai, xai: test.xai },
        subscriptionPolicy: policy,
      });
      if (field === 'id') test.openai.id = 'anthropic';
      else if (field === 'mode') test.openai.accessMode = 'api';
      else test.openai.complete = provider('openai', 'api').complete;
      await expect(configured.extractClaims(input)).rejects.toThrow();
      expect(test.openaiCalls).not.toHaveBeenCalled();
      expect(test.xaiCalls).not.toHaveBeenCalled();
    },
  );

  it('keeps the routed binding snapshot across multiple extractions', async () => {
    const test = config();
    const configured = createRoutedEvidenceEngine({
      routing: {
        version: 1,
        lanes: {
          'sensitive-intake': null,
          analysis: 'openai',
          challenge: 'xai',
        },
      },
      providers: { openai: test.openai, xai: test.xai },
      subscriptionPolicy: policy,
    });
    await configured.extractClaims(input);
    test.xai.accessMode = 'api';
    await expect(configured.extractClaims(input)).rejects.toThrow(
      'subscription policy adapter binding changed',
    );
    expect(test.openaiCalls).toHaveBeenCalledTimes(1);
    expect(test.xaiCalls).toHaveBeenCalledTimes(1);
  });

  it.each(['analysis', 'challenge'] as const)(
    'rejects both-lane drift after awaited %s',
    async (lane) => {
      const hooks: Hooks = {};
      const test = config(lane, hooks);
      hooks.after = () => {
        test.xai.id = 'anthropic';
      };
      const configured = createEvidenceEngine(test.options);
      await expect(configured.extractClaims(input)).rejects.toThrow(
        'subscription policy adapter binding changed',
      );
      expect(test.openaiCalls).toHaveBeenCalledTimes(1);
      expect(test.xaiCalls).toHaveBeenCalledTimes(lane === 'analysis' ? 0 : 1);
    },
  );

  it('does not swallow binding drift when the challenger also throws', async () => {
    const hooks: Hooks = {};
    const test = config('challenge', hooks);
    hooks.after = () => {
      test.xai.accessMode = 'api';
      throw new Error('raw secret exception');
    };
    await expect(
      createEvidenceEngine(test.options).extractClaims(input),
    ).rejects.toThrow('subscription policy adapter binding changed');
    expect(test.openaiCalls).toHaveBeenCalledTimes(1);
  });

  it.each(['api', 'missing'] as const)(
    'rejects subscription analysis reporting %s',
    async (reportMode) => {
      const test = config('analysis', { reportMode });
      await expect(
        createEvidenceEngine(test.options).extractClaims(input),
      ).rejects.toThrow(
        'analysis response does not match subscription access mode',
      );
      expect(test.xaiCalls).not.toHaveBeenCalled();
    },
  );

  it.each(['api', 'missing'] as const)(
    'keeps R7 for subscription challenge reporting %s',
    async (reportMode) => {
      const test = config('challenge', { reportMode });
      const result = await createEvidenceEngine(test.options).extractClaims(
        input,
      );
      expect(result.items[0]?.challenge).toMatchObject({
        outcome: 'failed',
        reason: 'access-mode-mismatch',
      });
      expect(
        result.items[0]?.promotion.reasons.map((reason) => reason.code),
      ).toContain('R7');
      expect(result.items[0]?.providerRuns).toHaveLength(1);
      if (reportMode === 'missing')
        expect(result.items[0]?.challenge).not.toHaveProperty('accessMode');
      else expect(result.items[0]?.challenge?.accessMode).toBe('api');
    },
  );

  it('supports direct extraction and bounds uncapped calls with the requested timeout', async () => {
    const test = config();
    const result = await extractClaimsWithProvider({
      ...test.options,
      input: { ...input, timeoutMs: 4_321 },
    });
    expect(result.accessMode).toBe('subscription');
    expect(test.openaiCalls.mock.calls[0]?.[0]).toMatchObject({
      timeoutMs: 4_321,
    });
    expect(test.openaiCalls.mock.calls[0]?.[0]).not.toHaveProperty(
      'maxOutputTokens',
    );
    expect(test.xaiCalls.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 900,
      timeoutMs: 4_321,
    });
  });

  it('does not treat an error code getter as quota evidence or expose its text', async () => {
    const readCode = jest.fn(() => {
      throw new Error('secret getter text');
    });
    const error = Object.defineProperty(
      new Error('secret provider text'),
      'code',
      { get: readCode },
    );
    const hooks: Hooks = {
      after: () => {
        throw error;
      },
    };
    const test = config('challenge', hooks);
    const result = await createEvidenceEngine(test.options).extractClaims(
      input,
    );
    expect(result.items[0]?.challenge).toMatchObject({
      outcome: 'failed',
      reason: 'provider-error',
    });
    expect(readCode).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('contains a throwing error descriptor proxy', async () => {
    const error = new Proxy(new Error('secret provider error'), {
      getOwnPropertyDescriptor() {
        throw new Error('secret descriptor');
      },
    });
    const test = config('challenge', {
      after: () => {
        throw error;
      },
    });
    const result = await createEvidenceEngine(test.options).extractClaims(
      input,
    );
    expect(result.items[0]?.challenge).toMatchObject({
      outcome: 'failed',
      reason: 'provider-error',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('preserves API per-candidate failure behavior without the subscription policy', async () => {
    const analysis = provider('xai', undefined, { claims: 3 });
    const challenger = provider('openai', 'api', {
      after: () => {
        throw Object.assign(new Error('offline quota'), {
          code: 'quota_exhausted',
        });
      },
    });
    const calls = jest.spyOn(challenger, 'complete');
    const result = await createEvidenceEngine({
      provider: analysis,
      challengeProvider: challenger,
    }).extractClaims(input);
    expect(calls).toHaveBeenCalledTimes(3);
    expect(
      result.items.every(
        (item) =>
          item.challenge?.outcome === 'failed' &&
          item.challenge.reason === 'provider-error',
      ),
    ).toBe(true);
    expect(
      calls.mock.calls.every(([args]) => args.maxOutputTokens === 900),
    ).toBe(true);
  });
});
