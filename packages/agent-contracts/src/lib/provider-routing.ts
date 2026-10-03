import { z } from 'zod';
import type { ModelProvider } from './model-provider.js';
import { LlmProviderIdSchema, type LlmProviderId } from './provider-id.js';
import { AgentTaskKindSchema, type AgentTaskKind } from './task-kind.js';

export const ProviderRoutingConfigSchema = z
  .object({
    version: z.literal(1),
    lanes: z
      .object({
        'sensitive-intake': z.null(),
        analysis: LlmProviderIdSchema,
        challenge: LlmProviderIdSchema,
      })
      .strict(),
  })
  .strict()
  .refine((config) => config.lanes.analysis !== config.lanes.challenge, {
    message: 'challenge provider must differ from analysis provider',
    path: ['lanes', 'challenge'],
  });

type ParsedRoutingConfig = z.infer<typeof ProviderRoutingConfigSchema>;

export type ProviderRoutingConfig = Readonly<{
  version: ParsedRoutingConfig['version'];
  lanes: Readonly<ParsedRoutingConfig['lanes']>;
}>;

export type ProviderRegistry = Readonly<
  Partial<Record<LlmProviderId, ModelProvider>>
>;

export interface ProviderRouter {
  readonly config: ProviderRoutingConfig;
  resolve(taskKind: AgentTaskKind): ModelProvider;
}

/** Select real injected adapters; never masquerade as one aggregate provider. */
export function createProviderRouter(args: {
  readonly config: unknown;
  readonly providers: ProviderRegistry;
}): ProviderRouter {
  const parsed = ProviderRoutingConfigSchema.parse(args.config);
  const config: ProviderRoutingConfig = Object.freeze({
    version: parsed.version,
    lanes: Object.freeze(parsed.lanes),
  });
  const select = (providerId: LlmProviderId): ModelProvider => {
    if (!Object.hasOwn(args.providers, providerId)) {
      throw new Error(`configured provider is unavailable: ${providerId}`);
    }
    return validateProvider(args.providers[providerId], providerId);
  };
  // Resolve both routes before callers can start analysis or incur call costs.
  const selected = Object.freeze({
    analysis: select(config.lanes.analysis),
    challenge: select(config.lanes.challenge),
  });

  return Object.freeze({
    config,
    resolve(taskKind: AgentTaskKind): ModelProvider {
      const lane = AgentTaskKindSchema.parse(taskKind);
      if (lane === 'sensitive-intake') {
        throw new Error('sensitive-intake routing is disabled');
      }
      // Preserve the selected instances, while refusing later adapter drift.
      return validateProvider(selected[lane], config.lanes[lane]);
    },
  });
}

function validateProvider(
  provider: ModelProvider | null | undefined,
  expectedId: LlmProviderId,
): ModelProvider {
  if (provider === undefined || provider === null) {
    throw new Error(`configured provider is unavailable: ${expectedId}`);
  }
  if (provider.id !== expectedId) {
    throw new Error(`configured provider identity mismatch: ${expectedId}`);
  }
  if (typeof provider.complete !== 'function') {
    throw new Error(`configured provider cannot complete calls: ${expectedId}`);
  }
  return provider;
}
