import { LlmProviderIdSchema, type ModelProvider } from '@wsa/agent-contracts';
import { z } from 'zod';

const SubscriptionPolicySchema = z
  .object({
    lane: z.enum(['analysis', 'challenge']),
    allowUncappedOutput: z.literal(true),
  })
  .strict();

/** Explicit acceptance of the subscription preview's missing output ceiling. */
export interface OpenAiSubscriptionPolicy {
  readonly lane: 'analysis' | 'challenge';
  readonly allowUncappedOutput: true;
}

export function snapshotSubscriptionPolicy(
  value: unknown,
): OpenAiSubscriptionPolicy | undefined {
  if (value === undefined) return undefined;
  const parsed = SubscriptionPolicySchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid subscription policy');
  return Object.freeze(parsed.data);
}

export interface SubscriptionPolicyGuard {
  assertBindings(): void;
  assertInput(maxOutputTokens: number | undefined): void;
}

/** Both lane bindings remain stable throughout one configured engine's life. */
export function createSubscriptionPolicyGuard(
  policy: OpenAiSubscriptionPolicy | undefined,
  analysis: ModelProvider,
  challenge: ModelProvider | undefined,
): SubscriptionPolicyGuard {
  if (policy === undefined) {
    return { assertBindings: () => undefined, assertInput: () => undefined };
  }
  const selected = policy.lane === 'analysis' ? analysis : challenge;
  if (
    selected == null ||
    typeof selected !== 'object' ||
    selected.id !== 'openai' ||
    accessMode(selected) !== 'subscription'
  ) {
    throw new Error('subscription policy requires an OpenAI subscription lane');
  }
  const bindings = [analysis, challenge]
    .filter((provider): provider is ModelProvider => provider !== undefined)
    .map((provider) => {
      const candidate: unknown = provider;
      if (candidate === null || typeof candidate !== 'object') {
        throw new Error('invalid subscription policy adapter binding');
      }
      const id = LlmProviderIdSchema.safeParse(provider.id);
      const mode = accessMode(provider);
      const complete: unknown = Reflect.get(provider, 'complete');
      if (
        !id.success ||
        typeof complete !== 'function' ||
        (mode !== undefined && mode !== 'api' && mode !== 'subscription')
      ) {
        throw new Error('invalid subscription policy adapter binding');
      }
      return { provider, id: id.data, mode, complete };
    });
  if (analysis.id === challenge?.id) {
    throw new Error('challenge provider must differ from analysis provider');
  }
  return {
    assertBindings() {
      if (
        bindings.some(
          ({ provider, id, mode, complete }) =>
            provider.id !== id ||
            accessMode(provider) !== mode ||
            provider.complete !== complete,
        )
      ) {
        throw new Error('subscription policy adapter binding changed');
      }
    },
    assertInput(maxOutputTokens) {
      if (maxOutputTokens !== undefined) {
        throw new Error('output cap conflicts with subscription policy');
      }
    },
  };
}

function accessMode(provider: ModelProvider): unknown {
  return 'accessMode' in provider ? provider.accessMode : undefined;
}
