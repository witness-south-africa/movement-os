import {
  createXaiEvidenceEngine,
  type ExtractionInput,
  type XaiEvidenceEngineConfig,
} from '@wsa/evidence-engine';
import type { SignatureSecretEnv } from './auth.js';
import { AuthError, verifySignedRequest } from './auth.js';
import { createAuthTelemetrySampler } from './auth-telemetry.js';
import {
  BudgetExhaustedError,
  assertBudgetAvailable,
  readBudgetCapUsdTicks,
  toMonthKey,
} from './budget-guard.js';
import {
  acquireRateLimitLease,
  RateLimitedError,
  type RateLimiterEnv,
} from './rate-limiter.js';
import {
  type ExtractRequestEnvelope,
  ExtractRequestValidationError,
  mapExtractionResultToResponse,
  parseExtractRequestEnvelope,
} from './schemas.js';
import {
  buildAuthFailureTelemetryRecord,
  buildBudgetExhaustedTelemetryRecord,
  buildErrorTelemetryRecord,
  buildSuccessTelemetryRecord,
  writeTelemetryRecord,
  withWorkerVersion,
} from './telemetry.js';

const DEFAULT_MODEL = 'grok-4-fast-reasoning';
const DEFAULT_API_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_REPLAY_WINDOW_SECONDS = 300;
const defaultAuthTelemetryAdmission = createAuthTelemetrySampler();
type XaiClient = XaiEvidenceEngineConfig['client'];
type XaiCreateCompletion = XaiClient['chat']['completions']['create'];
type XaiChatCompletionRequest = Parameters<XaiCreateCompletion>[0];
type XaiRequestOptions = Parameters<XaiCreateCompletion>[1];
type XaiChatCompletion = Awaited<ReturnType<XaiCreateCompletion>>;

export interface Env extends RateLimiterEnv, SignatureSecretEnv {
  readonly WSA_TELEMETRY: R2Bucket;
  readonly XAI_API_KEY?: string;
  readonly XAI_MODEL?: string;
  readonly XAI_API_BASE_URL?: string;
  readonly XAI_BUDGET_MONTHLY_CAP_USD_TICKS?: string;
  readonly AUTH_REPLAY_WINDOW_SECONDS?: string;
  readonly CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export interface ExtractHandlerDeps {
  readonly now?: () => Date;
  readonly verifySignature?: typeof verifySignedRequest;
  readonly acquireLease?: typeof acquireRateLimitLease;
  readonly assertBudget?: typeof assertBudgetAvailable;
  readonly writeTelemetry?: typeof writeTelemetryRecord;
  readonly createXaiClient?: (env: Env) => XaiClient;
  readonly admitAuthTelemetry?: (now: Date) => boolean;
}

export async function handleExtractRequest(
  request: Request,
  env: Env,
  deps: ExtractHandlerDeps = {},
  context?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const verifySignature = deps.verifySignature ?? verifySignedRequest;
  const acquireLease = deps.acquireLease ?? acquireRateLimitLease;
  const assertBudget = deps.assertBudget ?? assertBudgetAvailable;
  const write: typeof writeTelemetryRecord =
    deps.writeTelemetry ?? writeTelemetryRecord;
  const writeTelemetry: typeof writeTelemetryRecord = (
    bucket,
    monthKey,
    record,
  ) =>
    write(bucket, monthKey, withWorkerVersion(record, env.CF_VERSION_METADATA));
  const createClient = deps.createXaiClient ?? createFetchXaiClient;
  const replayWindowSeconds = readPositiveInteger(
    env.AUTH_REPLAY_WINDOW_SECONDS,
    DEFAULT_REPLAY_WINDOW_SECONDS,
  );

  let lease: Awaited<ReturnType<typeof acquireLease>> | undefined;
  let envelope: ExtractRequestEnvelope | undefined;
  let keyId = '';
  const model = env.XAI_MODEL ?? DEFAULT_MODEL;

  try {
    const verified = await verifySignature(
      request,
      env,
      now(),
      replayWindowSeconds,
    );
    keyId = verified.keyId;

    const bodyBytes = new Uint8Array(await request.arrayBuffer());
    const rawBody = new TextDecoder().decode(bodyBytes);
    envelope = parseExtractRequestEnvelope(parseJsonValue(rawBody));

    lease = await acquireLease(env, keyId, now());

    await assertBudget(env.WSA_TELEMETRY, readBudgetCapUsdTicks(env), now());

    const engine = createXaiEvidenceEngine({
      client: createClient(env),
      model,
    });
    const result = await engine.extractClaims(envelope.extract);
    await writeTelemetry(
      env.WSA_TELEMETRY,
      toMonthKey(now()),
      buildSuccessTelemetryRecord({
        keyId,
        input: envelope.extract,
        sourceByteLength: sourceByteLengthForInput(envelope.extract),
        result,
      }),
    );

    return jsonResponse(200, mapExtractionResultToResponse(result));
  } catch (error) {
    if (error instanceof AuthError) {
      const observedAt = now();
      const admit = deps.admitAuthTelemetry ?? defaultAuthTelemetryAdmission;
      if (admit(observedAt)) {
        const record = buildAuthFailureTelemetryRecord({
          requestId: `auth-${crypto.randomUUID()}`,
          keyId: request.headers.get('x-wsa-key-id')?.trim()
            ? 'provided'
            : 'missing',
          model,
          reason: error.reason,
        });
        const pending = Promise.resolve()
          .then(() =>
            writeTelemetry(env.WSA_TELEMETRY, toMonthKey(observedAt), record),
          )
          .catch(() => undefined);
        context?.waitUntil(pending);
      }
      return jsonResponse(401, { reason: error.reason });
    }
    if (error instanceof ExtractRequestValidationError) {
      return jsonResponse(error.status, { reason: error.reason });
    }
    if (error instanceof RateLimitedError) {
      return jsonResponse(429, { reason: error.reason });
    }
    if (error instanceof BudgetExhaustedError && envelope !== undefined) {
      const input = envelope.extract;
      await bestEffortTelemetry(() =>
        writeTelemetry(
          env.WSA_TELEMETRY,
          error.state.monthKey,
          buildBudgetExhaustedTelemetryRecord({
            keyId,
            input,
            sourceByteLength: sourceByteLengthForInput(input),
            model,
          }),
        ),
      );
      return jsonResponse(429, { reason: error.reason });
    }
    if (envelope !== undefined) {
      const input = envelope.extract;
      await bestEffortTelemetry(() =>
        writeTelemetry(
          env.WSA_TELEMETRY,
          toMonthKey(now()),
          buildErrorTelemetryRecord({
            keyId,
            input,
            sourceByteLength: sourceByteLengthForInput(input),
            model,
          }),
        ),
      );
    }
    return jsonResponse(500, { reason: 'internal_error' });
  } finally {
    if (lease !== undefined) {
      await lease.release().catch(() => undefined);
    }
  }
}

export function createFetchXaiClient(env: Env): XaiClient {
  const apiKey = readRequiredString(env.XAI_API_KEY, 'XAI_API_KEY');
  const configuredBaseUrl = env.XAI_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  let end = configuredBaseUrl.length;
  while (end > 0 && configuredBaseUrl[end - 1] === '/') {
    end -= 1;
  }
  const baseUrl = configuredBaseUrl.slice(0, end);

  return {
    chat: {
      completions: {
        create: async (
          payload: XaiChatCompletionRequest,
          options?: XaiRequestOptions,
        ): Promise<XaiChatCompletion> => {
          const init = {
            method: 'POST',
            headers: {
              authorization: `Bearer ${apiKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(payload),
            ...(options?.signal === undefined
              ? {}
              : { signal: options.signal }),
          } satisfies RequestInit;
          const response = await fetch(`${baseUrl}/chat/completions`, {
            ...init,
          });

          if (!response.ok) {
            throw new Error(
              `provider_request_failed:${String(response.status)}`,
            );
          }

          const json: unknown = await response.json();
          return json as XaiChatCompletion;
        },
      },
    },
  };
}

function sourceByteLengthForInput(input: ExtractionInput): number {
  return new TextEncoder().encode(input.sourceText).length;
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readRequiredString(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function parseJsonValue(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ExtractRequestValidationError(
        'request body must be valid JSON',
      );
    }
    throw error;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

async function bestEffortTelemetry(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch {
    // Failure records must not replace the intended response or leak storage errors.
  }
}
