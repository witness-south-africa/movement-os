import type {
  AgentMessage,
  ModelProvider,
  ResponseStatus,
  TokenUsage,
} from '@wsa/agent-contracts';
import { createXaiProvider, type XaiProviderConfig } from '@wsa/agent-xai';
import {
  checkEvidencePromotion,
  type EvidenceWithProvenance,
  type PromotionDecision,
} from '@wsa/guardrails';
import {
  AgentIdSchema,
  ClaimIdSchema,
  ClaimExtractorSchema,
  ClaimSchema,
  ClaimSourceRefSchema,
  EvidenceIdSchema,
  EvidenceSchema,
  type AgentId,
  type Claim,
  type ClaimExtractor,
  type ClaimSourceRef,
  type ClaimStatus,
  type Evidence,
} from '@wsa/schemas';
import { z } from 'zod';
import {
  challengeClaim,
  ProviderResponseMetadataSchema,
  type ClaimChallengeAttempt,
  type CompletedProviderRun,
} from './challenge.js';
import { ClaimExtractionOutputSchema } from './extraction-schema.js';
import {
  createSubscriptionPolicyGuard,
  snapshotSubscriptionPolicy,
  type OpenAiSubscriptionPolicy,
  type SubscriptionPolicyGuard,
} from './subscription-policy.js';
import { generateUlid } from './ulid.js';

const DEFAULT_ACTOR_ID = AgentIdSchema.parse('agent:evidence-engine');
const DEFAULT_EXTRACTOR_ID = ClaimExtractorSchema.parse(
  'agent:evidence-engine',
);
const DEFAULT_MAX_CLAIMS = 3;
const DEFAULT_MAX_OUTPUT_TOKENS = 900;
const DEFAULT_TIMEOUT_MS = 20_000;
const PROMOTABLE_STATUSES: ReadonlySet<ClaimStatus> = new Set([
  'high-confidence',
  'conclusive',
]);
const SAFE_FALLBACK_STATUS: ClaimStatus = 'contested';
const SYSTEM_PROMPT = [
  'You extract discrete, checkable civic-accountability claims from already-redacted or already-consented material.',
  'Return only JSON that matches the provided schema.',
  'Never invent names, dates, URLs, records, or legal conclusions that are not present in the source text.',
  'Prefer lower certainty over overstatement.',
  'A rationale must explain why the source text supports the requested status in one short sentence.',
].join('\n');

const ExtractionInputSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    sourceRef: ClaimSourceRefSchema,
    sourceUrl: z.string().url(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/i, 'expected a sha256 hex'),
    sourceFetchedAt: z.string().datetime({ offset: true }),
    sourceText: z.string().min(1).max(50_000),
    maxClaims: z.number().int().min(1).max(10).optional(),
    maxOutputTokens: z.number().int().positive().max(4_096).optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .strict();

export interface ExtractionInput {
  readonly requestId: string;
  readonly sourceRef: ClaimSourceRef;
  readonly sourceUrl: string;
  readonly sourceSha256: string;
  readonly sourceFetchedAt: string;
  readonly sourceText: string;
  readonly maxClaims?: number;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
}

export interface ExtractionAuditRecord {
  readonly action: 'claim.extracted' | 'evidence.linked' | 'claim.challenged';
  readonly actor: AgentId;
  readonly at: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface ExtractedClaimRecord {
  readonly requestedStatus: ClaimStatus;
  readonly claim: Claim;
  readonly evidence: EvidenceWithProvenance;
  readonly promotion: PromotionDecision;
  readonly auditTrail: ReadonlyArray<ExtractionAuditRecord>;
  readonly providerRuns?: ReadonlyArray<CompletedProviderRun>;
  readonly challenge?: ClaimChallengeAttempt;
}

export interface ExtractionResult {
  readonly requestId: string;
  readonly summary: string;
  readonly provider: ModelProvider['id'];
  readonly model: string;
  readonly accessMode?: 'api' | 'subscription';
  readonly responseId?: string;
  readonly rawFinishReason?: string;
  readonly status: ResponseStatus;
  readonly usage: TokenUsage;
  readonly items: ReadonlyArray<ExtractedClaimRecord>;
}

export interface EvidenceEngine {
  extractClaims(input: ExtractionInput): Promise<ExtractionResult>;
}

export interface EvidenceEngineConfig {
  readonly provider: ModelProvider;
  readonly challengeProvider?: ModelProvider;
  readonly subscriptionPolicy?: OpenAiSubscriptionPolicy;
  readonly actorId?: AgentId;
  readonly extractorId?: ClaimExtractor;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export interface XaiEvidenceEngineConfig extends XaiProviderConfig {
  readonly challengeProvider?: ModelProvider;
  readonly subscriptionPolicy?: OpenAiSubscriptionPolicy;
  readonly actorId?: AgentId;
  readonly extractorId?: ClaimExtractor;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export function createEvidenceEngine(
  config: EvidenceEngineConfig,
): EvidenceEngine {
  const snapshot = { ...config };
  const policy = snapshotSubscriptionPolicy(snapshot.subscriptionPolicy);
  const guard = createSubscriptionPolicyGuard(
    policy,
    snapshot.provider,
    snapshot.challengeProvider,
  );
  return {
    extractClaims: async (input: ExtractionInput): Promise<ExtractionResult> =>
      extractClaimsWithPolicy(
        {
          ...snapshot,
          input,
        },
        policy,
        guard,
      ),
  };
}

export function createXaiEvidenceEngine(
  config: XaiEvidenceEngineConfig,
): EvidenceEngine {
  const {
    actorId,
    extractorId,
    now,
    createId,
    challengeProvider,
    subscriptionPolicy,
    ...providerConfig
  } = config;
  return createEvidenceEngine({
    provider: createXaiProvider(providerConfig),
    ...(challengeProvider === undefined ? {} : { challengeProvider }),
    ...(subscriptionPolicy === undefined ? {} : { subscriptionPolicy }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(extractorId === undefined ? {} : { extractorId }),
    ...(now === undefined ? {} : { now }),
    ...(createId === undefined ? {} : { createId }),
  });
}

export async function extractClaimsWithProvider(
  args: EvidenceEngineConfig & {
    readonly input: ExtractionInput;
  },
): Promise<ExtractionResult> {
  const snapshot = { ...args };
  const policy = snapshotSubscriptionPolicy(snapshot.subscriptionPolicy);
  const guard = createSubscriptionPolicyGuard(
    policy,
    snapshot.provider,
    snapshot.challengeProvider,
  );
  return extractClaimsWithPolicy(snapshot, policy, guard);
}

async function extractClaimsWithPolicy(
  args: EvidenceEngineConfig & { readonly input: ExtractionInput },
  policy: OpenAiSubscriptionPolicy | undefined,
  guard: SubscriptionPolicyGuard,
): Promise<ExtractionResult> {
  const input = ExtractionInputSchema.parse(args.input);
  guard.assertInput(input.maxOutputTokens);
  guard.assertBindings();
  const analysisMaxOutputTokens =
    policy?.lane === 'analysis'
      ? undefined
      : (input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
  const challengeMaxOutputTokens =
    policy?.lane === 'challenge'
      ? undefined
      : (input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
  const actorId = args.actorId ?? DEFAULT_ACTOR_ID;
  const extractorId = args.extractorId ?? DEFAULT_EXTRACTOR_ID;
  const now = args.now ?? (() => new Date());
  const createId = args.createId ?? (() => generateUlid(now()));
  const schema = ClaimExtractionOutputSchema({
    maxClaims: input.maxClaims ?? DEFAULT_MAX_CLAIMS,
  });
  const providerId = args.provider.id;
  const challengeProviderId = args.challengeProvider?.id;
  if (challengeProviderId === providerId) {
    throw new Error('challenge provider must differ from analysis provider');
  }
  const response = await args.provider.complete({
    schema,
    messages: buildMessages(input),
    taskKind: 'analysis',
    requestId: input.requestId,
    ...(analysisMaxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: analysisMaxOutputTokens }),
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  guard.assertBindings();

  const occurredAt = now().toISOString();
  const metadata = ProviderResponseMetadataSchema.safeParse(response);
  if (!metadata.success) {
    throw new Error('analysis response metadata is invalid');
  }
  if (metadata.data.provider !== providerId) {
    throw new Error(
      'analysis response provider does not match configured provider',
    );
  }
  if (
    policy?.lane === 'analysis' &&
    metadata.data.accessMode !== 'subscription'
  ) {
    throw new Error(
      'analysis response does not match subscription access mode',
    );
  }
  const output = schema.parse(response.value);
  const items: ExtractedClaimRecord[] = [];
  const subscriptionChallengeState = { quotaExhausted: false };
  for (const candidate of output.claims) {
    guard.assertBindings();
    items.push(
      await buildExtractedClaimRecord({
        requestId: input.requestId,
        sourceRef: input.sourceRef,
        sourceUrl: input.sourceUrl,
        sourceSha256: input.sourceSha256,
        sourceFetchedAt: input.sourceFetchedAt,
        candidate,
        actorId,
        extractorId,
        occurredAt,
        providerId,
        model: metadata.data.model,
        createId,
        sourceText: input.sourceText,
        analysisCompleted:
          metadata.data.status === 'completed' &&
          metadata.data.rawFinishReason !== 'length' &&
          metadata.data.rawFinishReason !== 'content_filter',
        rawFinishReason: metadata.data.rawFinishReason,
        now,
        maxOutputTokens: challengeMaxOutputTokens,
        subscriptionGuard: guard,
        subscriptionChallengeState,
        ...(policy?.lane === 'challenge'
          ? { expectedChallengeAccessMode: 'subscription' as const }
          : {}),
        ...(metadata.data.accessMode === undefined
          ? {}
          : { accessMode: metadata.data.accessMode }),
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(args.challengeProvider === undefined
          ? {}
          : { challengeProvider: args.challengeProvider }),
        ...(challengeProviderId === undefined ? {} : { challengeProviderId }),
        ...(metadata.data.responseId === undefined
          ? {}
          : { responseId: metadata.data.responseId }),
      }),
    );
  }

  guard.assertBindings();
  return {
    requestId: input.requestId,
    summary: output.summary,
    provider: response.provider,
    model: metadata.data.model,
    ...(metadata.data.accessMode === undefined
      ? {}
      : { accessMode: metadata.data.accessMode }),
    ...(metadata.data.responseId === undefined
      ? {}
      : { responseId: metadata.data.responseId }),
    rawFinishReason: metadata.data.rawFinishReason,
    status: metadata.data.status,
    usage: metadata.data.usage,
    items,
  };
}

function buildMessages(
  input: z.infer<typeof ExtractionInputSchema>,
): readonly AgentMessage[] {
  const payload = {
    sourceRef: input.sourceRef,
    sourceUrl: input.sourceUrl,
    sourceSha256: input.sourceSha256,
    sourceFetchedAt: input.sourceFetchedAt,
    maxClaims: input.maxClaims ?? DEFAULT_MAX_CLAIMS,
    instructions: [
      'Extract only claims stated or strongly implied by the source text.',
      'Use `supports` relative to the claim you emit.',
      'Use `contested` or `insufficient-record` when the text does not justify a promotable status.',
    ],
    sourceText: input.sourceText,
  };

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify(payload, null, 2),
    },
  ];
}

async function buildExtractedClaimRecord(args: {
  readonly requestId: string;
  readonly sourceRef: ClaimSourceRef;
  readonly sourceUrl: string;
  readonly sourceSha256: string;
  readonly sourceFetchedAt: string;
  readonly candidate: z.infer<
    ReturnType<typeof ClaimExtractionOutputSchema>
  >['claims'][number];
  readonly actorId: AgentId;
  readonly extractorId: ClaimExtractor;
  readonly occurredAt: string;
  readonly providerId: ModelProvider['id'];
  readonly model: string;
  readonly accessMode?: 'api' | 'subscription';
  readonly responseId?: string;
  readonly createId: () => string;
  readonly sourceText: string;
  readonly analysisCompleted: boolean;
  readonly rawFinishReason: string;
  readonly challengeProvider?: ModelProvider;
  readonly challengeProviderId?: ModelProvider['id'];
  readonly maxOutputTokens: number | undefined;
  readonly expectedChallengeAccessMode?: 'subscription';
  readonly subscriptionGuard: SubscriptionPolicyGuard;
  readonly subscriptionChallengeState: { quotaExhausted: boolean };
  readonly timeoutMs: number;
  readonly now: () => Date;
}): Promise<ExtractedClaimRecord> {
  const claimId = ClaimIdSchema.parse(args.createId());
  const requestedStatus = args.candidate.status;
  const provisionalClaim = ClaimSchema.parse({
    id: claimId,
    text: args.candidate.text,
    extractedBy: args.extractorId,
    status: requestedStatus,
    sourceRef: args.sourceRef,
    assertedAt: args.occurredAt,
    validFrom: null,
    validTo: null,
  });

  const evidence = EvidenceSchema.parse({
    id: EvidenceIdSchema.parse(args.createId()),
    claimId,
    kind: 'other',
    url: args.sourceUrl,
    fetchedAt: args.sourceFetchedAt,
    sha256: args.sourceSha256.toLowerCase(),
    supports: args.candidate.supports,
    note: buildEvidenceNote(args),
    assertedAt: args.occurredAt,
    validFrom: null,
    validTo: null,
  });

  const evidenceWithProvenance: EvidenceWithProvenance = {
    evidence,
    provenance: {
      providerIds: [args.providerId],
      modelGenerated: true,
    },
  };

  const binding = {
    claimId,
    claimText: provisionalClaim.text,
    sourceRef: args.sourceRef,
    sourceSha256: args.sourceSha256.toLowerCase(),
  };
  const providerRuns: CompletedProviderRun[] = args.analysisCompleted
    ? [
        {
          provider: args.providerId,
          taskKind: 'analysis',
          ...binding,
          requestId: args.requestId,
          model: args.model,
          ...(args.accessMode === undefined
            ? {}
            : { accessMode: args.accessMode }),
          at: args.occurredAt,
          rawFinishReason: args.rawFinishReason,
          ...(args.responseId === undefined
            ? {}
            : { responseId: args.responseId }),
        },
      ]
    : [];
  let challenge: ClaimChallengeAttempt | undefined;
  if (
    args.challengeProvider !== undefined &&
    args.challengeProviderId !== undefined &&
    PROMOTABLE_STATUSES.has(requestedStatus)
  ) {
    args.subscriptionGuard.assertBindings();
    const requestId = `${args.requestId}:challenge:${claimId}`;
    challenge =
      args.expectedChallengeAccessMode === 'subscription' &&
      args.subscriptionChallengeState.quotaExhausted
        ? {
            provider: args.challengeProviderId,
            requestId,
            at: args.now().toISOString(),
            outcome: 'skipped',
            reason: 'subscription-quota-exhausted',
          }
        : args.analysisCompleted
          ? await challengeClaim({
              provider: args.challengeProvider,
              providerId: args.challengeProviderId,
              binding,
              sourceText: args.sourceText,
              requestId,
              maxOutputTokens: args.maxOutputTokens,
              ...(args.expectedChallengeAccessMode === undefined
                ? {}
                : { expectedAccessMode: args.expectedChallengeAccessMode }),
              timeoutMs: args.timeoutMs,
              now: args.now,
            })
          : {
              provider: args.challengeProviderId,
              requestId,
              at: args.now().toISOString(),
              outcome: 'skipped',
              reason: 'analysis-incomplete',
            };
    args.subscriptionGuard.assertBindings();
    if (
      challenge.outcome === 'failed' &&
      challenge.reason === 'quota-exhausted'
    ) {
      args.subscriptionChallengeState.quotaExhausted = true;
    }
    if (challenge.outcome === 'completed') {
      providerRuns.push({
        provider: args.challengeProviderId,
        taskKind: 'challenge',
        ...binding,
        requestId,
        model: challenge.model,
        ...(challenge.accessMode === undefined
          ? {}
          : { accessMode: challenge.accessMode }),
        at: challenge.at,
        rawFinishReason: challenge.rawFinishReason,
        ...(challenge.responseId === undefined
          ? {}
          : { responseId: challenge.responseId }),
      });
    }
  }

  const promotion = checkEvidencePromotion({
    claim: provisionalClaim,
    claimProducerProvider: args.providerId,
    evidence: [evidenceWithProvenance],
    providerRuns,
    now: challenge?.at ?? args.occurredAt,
  });
  const effectiveStatus = shouldDowngradeStatus(requestedStatus, promotion)
    ? SAFE_FALLBACK_STATUS
    : requestedStatus;

  const claim =
    effectiveStatus === requestedStatus
      ? provisionalClaim
      : ClaimSchema.parse({
          ...provisionalClaim,
          status: effectiveStatus,
        });

  return {
    requestedStatus,
    claim,
    evidence: evidenceWithProvenance,
    promotion,
    providerRuns,
    ...(challenge === undefined ? {} : { challenge }),
    auditTrail: [
      ...buildAuditTrail({
        actorId: args.actorId,
        occurredAt: args.occurredAt,
        requestId: args.requestId,
        sourceRef: args.sourceRef,
        requestedStatus,
        effectiveStatus,
        claim,
        evidence,
        promotion,
        providerId: args.providerId,
        model: args.model,
        ...(args.accessMode === undefined
          ? {}
          : { accessMode: args.accessMode }),
        ...(args.responseId === undefined
          ? {}
          : { responseId: args.responseId }),
      }),
      ...(challenge === undefined
        ? []
        : [
            {
              action: 'claim.challenged' as const,
              actor: args.actorId,
              at: challenge.at,
              detail: {
                requestId: challenge.requestId,
                claimId,
                sourceRef: args.sourceRef,
                sourceSha256: binding.sourceSha256,
                provider: challenge.provider,
                ...(challenge.accessMode === undefined
                  ? {}
                  : { accessMode: challenge.accessMode }),
                outcome: challenge.outcome,
                ...(challenge.outcome === 'completed'
                  ? { supports: challenge.assessment.supports }
                  : { reason: challenge.reason }),
                ...(challenge.model === undefined
                  ? {}
                  : { model: challenge.model }),
                ...(challenge.responseId === undefined
                  ? {}
                  : { responseId: challenge.responseId }),
                ...(challenge.responseStatus === undefined
                  ? {}
                  : { responseStatus: challenge.responseStatus }),
                ...(challenge.rawFinishReason === undefined
                  ? {}
                  : { rawFinishReason: challenge.rawFinishReason }),
                ...(challenge.usage === undefined
                  ? {}
                  : { usage: challenge.usage }),
              },
            },
          ]),
    ],
  };
}

function buildEvidenceNote(args: {
  readonly candidate: { readonly rationale: string };
  readonly providerId: ModelProvider['id'];
  readonly model: string;
  readonly requestId: string;
}): string {
  return [
    `Model-generated extraction candidate from ${args.providerId}/${args.model}.`,
    `requestId=${args.requestId}.`,
    args.candidate.rationale.trim(),
  ]
    .join(' ')
    .slice(0, 500);
}

function shouldDowngradeStatus(
  requestedStatus: ClaimStatus,
  promotion: PromotionDecision,
): boolean {
  return PROMOTABLE_STATUSES.has(requestedStatus) && !promotion.ok;
}

function buildAuditTrail(args: {
  readonly actorId: AgentId;
  readonly occurredAt: string;
  readonly requestId: string;
  readonly sourceRef: ClaimSourceRef;
  readonly requestedStatus: ClaimStatus;
  readonly effectiveStatus: ClaimStatus;
  readonly claim: Claim;
  readonly evidence: Evidence;
  readonly promotion: PromotionDecision;
  readonly providerId: ModelProvider['id'];
  readonly model: string;
  readonly accessMode?: 'api' | 'subscription';
  readonly responseId?: string;
}): readonly ExtractionAuditRecord[] {
  return [
    {
      action: 'claim.extracted',
      actor: args.actorId,
      at: args.occurredAt,
      detail: {
        requestId: args.requestId,
        sourceRef: args.sourceRef,
        claimId: args.claim.id,
        requestedStatus: args.requestedStatus,
        effectiveStatus: args.effectiveStatus,
        provider: args.providerId,
        model: args.model,
        ...(args.accessMode === undefined
          ? {}
          : { accessMode: args.accessMode }),
        promotionOk: args.promotion.ok,
        promotionRuleCodes: args.promotion.reasons.map((reason) => reason.code),
        ...(args.responseId === undefined
          ? {}
          : { responseId: args.responseId }),
      },
    },
    {
      action: 'evidence.linked',
      actor: args.actorId,
      at: args.occurredAt,
      detail: {
        requestId: args.requestId,
        claimId: args.claim.id,
        evidenceId: args.evidence.id,
        supports: args.evidence.supports,
        kind: args.evidence.kind,
        providerIds: [args.providerId],
        modelGenerated: true,
      },
    },
  ];
}
