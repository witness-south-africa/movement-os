import { createHash, randomUUID } from 'node:crypto';
import {
  createOpenAiResponsesFetchClient,
  createOpenAiResponsesProvider,
  OpenAiResponsesError,
  sanitizeOpenAiResponsesError,
  type OpenAiResponsesDiagnostics,
} from '@wsa/agent-openai';
import {
  createOpenAiSubscriptionSession,
  OpenAiSubscriptionAuthError,
  type OpenAiSubscriptionSession,
  type SubscriptionModelInfo,
  type SubscriptionStore,
} from '@wsa/agent-openai/subscription-auth';
import { createEvidenceEngine } from '@wsa/evidence-engine';
import { ArtefactIdSchema, ulid } from '@wsa/schemas';

export interface BuildProvenance {
  readonly sourceRevision: string;
  readonly sourceTree: string;
  readonly lockSha256: string;
  readonly artifactSha256: string;
  readonly artifactCount: number;
  readonly nodeVersion: string;
  readonly typescriptVersion: string;
}

export interface AcceptanceConfig {
  readonly directory: string;
  readonly hosting: 'local';
  readonly acceptUncappedOutput: true;
  readonly model?: string;
  readonly browser?: 'system' | 'manual';
}

type Stage = 'signIn' | 'models' | 'inference' | 'signOut';
type StageState = 'skipped' | 'started' | 'completed' | 'failed';
export interface AcceptanceReport {
  readonly version: 1;
  readonly runId: string;
  readonly fixtureSha256: string;
  readonly provenance: BuildProvenance;
  readonly stages: Record<Stage, StageState>;
  analysisAccepted: boolean;
  localCredentialsCleared: boolean;
  remoteRevocationConfirmed: boolean;
  responsesDispatches: number;
  refresh: {
    attempts: number;
    persistedRotations: number;
    status: 'not_observed' | 'completed' | 'pending';
  };
  requestedModel?: string;
  response?: {
    id: string;
    model: string;
    status: 'completed';
    accessMode: 'subscription';
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cachedInputTokens?: number;
    };
    claims: number;
    promotionBlocked: number;
    promotionRules: string[];
  };
  failure?: {
    stage: Stage;
    code: string;
    diagnostics?: Omit<OpenAiResponsesDiagnostics, 'requestId'>;
  };
  cleanupFailure?: string;
}

export interface AcceptanceDependencies {
  readonly store: SubscriptionStore;
  readonly fetch: typeof globalThis.fetch;
  readonly openAuthorizationUrl: (url: string) => Promise<void>;
  readonly chooseModel: (
    models: readonly SubscriptionModelInfo[],
  ) => Promise<string | undefined>;
  readonly signal: AbortSignal;
  /** Dependency seam for offline account fixtures; production always uses native sessions. */
  readonly createSession?: typeof createOpenAiSubscriptionSession;
}

const FIXTURE =
  'This is a fictional training record. The fictional clerk scheduled an inspection for Monday.';
const AUTH_CODES = new Set([
  'invalid_configuration',
  'storage_unavailable',
  'storage_locked',
  'invalid_callback',
  'access_denied',
  'invalid_identity',
  'account_not_found',
  'plan_not_authorized',
  'reauthorization_required',
  'invalid_response',
  'transport_failed',
  'cancelled',
  'timeout',
]);
function failureCode(error: unknown): string {
  try {
    if (
      error instanceof OpenAiSubscriptionAuthError &&
      AUTH_CODES.has(error.code)
    )
      return error.code;
    if (error instanceof OpenAiResponsesError)
      return sanitizeOpenAiResponsesError(error).code;
  } catch {
    /* Never inspect an arbitrary exception's message or cause. */
  }
  return 'transport_failed';
}

/** Receipt fields are finite; even a valid native request ID is not exported. */
function failureDiagnostics(
  error: unknown,
): Omit<OpenAiResponsesDiagnostics, 'requestId'> | undefined {
  const diagnostics = sanitizeOpenAiResponsesError(error).diagnostics;
  if (!diagnostics) return undefined;
  const finite = {
    ...(diagnostics.httpStatus === undefined
      ? {}
      : { httpStatus: diagnostics.httpStatus }),
    ...(diagnostics.bodyShape === undefined
      ? {}
      : { bodyShape: diagnostics.bodyShape }),
    ...(diagnostics.providerCode === undefined
      ? {}
      : { providerCode: diagnostics.providerCode }),
    ...(diagnostics.validationFailure === undefined
      ? {}
      : { validationFailure: diagnostics.validationFailure }),
  };
  return Object.keys(finite).length === 0 ? undefined : finite;
}

/** Pin inside the existing exclusive transaction; retain rotation and restore operator selection. */
export function pinAccountStore(
  store: SubscriptionStore,
  key: string,
  refresh: AcceptanceReport['refresh'],
  refreshSuccesses: () => number,
): SubscriptionStore {
  return {
    async transaction(operation, options) {
      const observation = { rotation: false };
      const result = await store.transaction(async (state) => {
        const selected = state.accounts.find((account) => account.key === key);
        if (!selected)
          throw new OpenAiSubscriptionAuthError('account_not_found');
        const previous = state.activeAccountKey;
        const previousToken = selected.tokens?.refreshToken;
        const successes = refreshSuccesses();
        state.activeAccountKey = key;
        try {
          const value = await operation(state);
          observation.rotation =
            refreshSuccesses() > successes &&
            selected.tokens !== undefined &&
            selected.tokens.refreshToken !== previousToken &&
            selected.tokens.refreshToken !== undefined;
          return value;
        } finally {
          state.activeAccountKey = previous;
        }
      }, options);
      // Underlying transaction has now validated and durably committed replacement tokens.
      if (observation.rotation) refresh.persistedRotations++;
      return result;
    },
  };
}

/** One fresh account, catalogue-bound model, native analysis and targeted cleanup. */
export async function runAcceptance(
  config: AcceptanceConfig,
  provenance: BuildProvenance,
  deps: AcceptanceDependencies,
): Promise<AcceptanceReport> {
  const report: AcceptanceReport = {
    version: 1,
    runId: `acceptance-${randomUUID()}`,
    fixtureSha256: createHash('sha256').update(FIXTURE).digest('hex'),
    provenance,
    stages: {
      signIn: 'skipped',
      models: 'skipped',
      inference: 'skipped',
      signOut: 'skipped',
    },
    analysisAccepted: false,
    localCredentialsCleared: false,
    remoteRevocationConfirmed: false,
    responsesDispatches: 0,
    refresh: { attempts: 0, persistedRotations: 0, status: 'not_observed' },
  };
  let stage: Stage = 'signIn';
  let key: string | undefined;
  let selectedSession: OpenAiSubscriptionSession | undefined;
  let refreshSuccesses = 0;
  const transport: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const rotation =
      url === 'https://auth.openai.com/api/accounts/oauth/token' &&
      init?.body instanceof URLSearchParams &&
      init.body.get('grant_type') === 'refresh_token';
    if (rotation) report.refresh.attempts++;
    if (url === 'https://api.openai.com/v1/responses') {
      if (report.responsesDispatches !== 0 || deps.signal.aborted)
        throw new OpenAiResponsesError('transport_failed');
      report.responsesDispatches++;
      init = {
        ...init,
        signal: AbortSignal.any([
          deps.signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      };
    }
    const response = await deps.fetch(input, init);
    if (rotation && response.status === 200) refreshSuccesses++;
    return response;
  };
  const createSession = deps.createSession ?? createOpenAiSubscriptionSession;
  try {
    report.stages.signIn = 'started';
    const runtimeConfig: { hosting: unknown; acceptUncappedOutput: unknown } =
      config;
    if (
      runtimeConfig.hosting !== 'local' ||
      runtimeConfig.acceptUncappedOutput !== true ||
      deps.signal.aborted
    )
      throw new OpenAiSubscriptionAuthError('invalid_configuration');
    const session = createSession({
      store: deps.store,
      hosting: 'local',
      fetch: transport,
    });
    if ((await session.listAccounts()).length !== 0)
      throw new OpenAiSubscriptionAuthError('invalid_configuration');
    const account = await session.signIn({
      openAuthorizationUrl: deps.openAuthorizationUrl,
      enablePlanUsage: true,
      signal: deps.signal,
    });
    key = account.key;
    if (!account.signedIn || !account.planUsageAuthorized)
      throw new OpenAiSubscriptionAuthError('plan_not_authorized');
    const store = pinAccountStore(
      deps.store,
      key,
      report.refresh,
      () => refreshSuccesses,
    );
    const pinnedSession = createSession({
      store,
      hosting: 'local',
      fetch: transport,
    });
    selectedSession = pinnedSession;
    report.stages.signIn = 'completed';
    stage = 'models';
    report.stages.models = 'started';
    const models = (
      await selectedSession.listModels({ signal: deps.signal })
    ).filter((model) =>
      /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(model.slug),
    );
    const chosen = config.model ?? (await deps.chooseModel(models));
    if (
      !chosen ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(chosen) ||
      !models.some((model) => model.slug === chosen)
    )
      throw new OpenAiSubscriptionAuthError('invalid_configuration');
    report.requestedModel = chosen;
    report.stages.models = 'completed';
    stage = 'inference';
    report.stages.inference = 'started';
    const client = createOpenAiResponsesFetchClient({
      accessMode: 'subscription',
      hosting: 'local',
      fetch: transport,
      resolveAccessToken: () =>
        pinnedSession.resolveAccessToken({ signal: deps.signal }),
    });
    const provider = createOpenAiResponsesProvider({ client, model: chosen });
    const result = await createEvidenceEngine({
      provider,
      subscriptionPolicy: { lane: 'analysis', allowUncappedOutput: true },
    }).extractClaims({
      requestId: report.runId,
      sourceRef: {
        kind: 'artefact',
        id: ArtefactIdSchema.parse(ulid('SUBSCRIPTION_ACCEPTANCE')),
      },
      sourceUrl: 'https://example.org/synthetic-acceptance-fixture',
      sourceSha256: report.fixtureSha256,
      sourceFetchedAt: new Date().toISOString(),
      sourceText: FIXTURE,
      maxClaims: 1,
      timeoutMs: 60_000,
    });
    if (
      result.status !== 'completed' ||
      result.accessMode !== 'subscription' ||
      !result.responseId ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,511}$/.test(result.responseId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(result.model)
    )
      throw new OpenAiResponsesError('invalid_response', {
        validationFailure: 'response_identity',
      });
    report.response = {
      id: result.responseId,
      model: result.model,
      status: 'completed',
      accessMode: 'subscription',
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
        ...(result.usage.cachedInputTokens === undefined
          ? {}
          : { cachedInputTokens: result.usage.cachedInputTokens }),
      },
      claims: result.items.length,
      promotionBlocked: result.items.filter((item) => !item.promotion.ok)
        .length,
      promotionRules: [
        ...new Set(
          result.items.flatMap((item) =>
            item.promotion.reasons.map((reason) => reason.code),
          ),
        ),
      ],
    };
    report.analysisAccepted = true;
    report.stages.inference = 'completed';
  } catch (error) {
    report.stages[stage] = 'failed';
    const diagnostics = failureDiagnostics(error);
    report.failure = {
      stage,
      code: failureCode(error),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    };
  } finally {
    if (key) {
      report.stages.signOut = 'started';
      try {
        const session =
          selectedSession ??
          createSession({
            store: deps.store,
            hosting: 'local',
            fetch: transport,
          });
        const outcome = await session.signOut({
          accountKey: key,
          signal: AbortSignal.timeout(20_000),
        });
        report.remoteRevocationConfirmed = outcome.remoteRevocationConfirmed;
        report.localCredentialsCleared = await deps.store.transaction((state) =>
          Promise.resolve(
            state.accounts.some(
              (account) => account.key === key && account.tokens === undefined,
            ),
          ),
        );
        if (report.localCredentialsCleared) report.stages.signOut = 'completed';
        else {
          report.stages.signOut = 'failed';
          report.cleanupFailure = 'storage_unavailable';
        }
      } catch (error) {
        report.stages.signOut = 'failed';
        report.cleanupFailure = failureCode(error);
      }
    }
    report.refresh.status =
      report.refresh.persistedRotations > 0
        ? 'completed'
        : report.refresh.attempts > 0
          ? 'pending'
          : 'not_observed';
  }
  return report;
}
