export {
  ClaimExtractionOutputSchema,
  ClaimExtractionCandidateSchema,
} from './lib/extraction-schema.js';
export type {
  ClaimExtractionCandidate,
  ClaimExtractionOutput,
} from './lib/extraction-schema.js';
export {
  createEvidenceEngine,
  createXaiEvidenceEngine,
  extractClaimsWithProvider,
} from './lib/runtime.js';
export { ClaimChallengeAssessmentSchema } from './lib/challenge.js';
export type {
  ClaimChallengeAssessment,
  ClaimChallengeAttempt,
  CompletedProviderRun,
} from './lib/challenge.js';
export type {
  ExtractionAuditRecord,
  ExtractionInput,
  ExtractionResult,
  ExtractedClaimRecord,
  EvidenceEngine,
  EvidenceEngineConfig,
  XaiEvidenceEngineConfig,
} from './lib/runtime.js';
export { createRoutedEvidenceEngine } from './lib/routed-engine.js';
export type { RoutedEvidenceEngineConfig } from './lib/routed-engine.js';
