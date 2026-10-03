import {
  createProviderRouter,
  type ProviderRegistry,
} from '@wsa/agent-contracts';
import {
  createEvidenceEngine,
  type EvidenceEngine,
  type EvidenceEngineConfig,
} from './runtime.js';

export interface RoutedEvidenceEngineConfig extends Omit<
  EvidenceEngineConfig,
  'provider' | 'challengeProvider'
> {
  readonly routing: unknown;
  readonly providers: ProviderRegistry;
}

/** Explicit opt-in; validates both lanes before any extraction call. */
export function createRoutedEvidenceEngine(
  config: RoutedEvidenceEngineConfig,
): EvidenceEngine {
  const { routing, providers, ...engineConfig } = config;
  const router = createProviderRouter({ config: routing, providers });
  return {
    extractClaims: async (input) =>
      createEvidenceEngine({
        ...engineConfig,
        provider: router.resolve('analysis'),
        challengeProvider: router.resolve('challenge'),
      }).extractClaims(input),
  };
}
