import type { ExtractionInput, ExtractionResult } from '@wsa/evidence-engine';
import type { ClaimSourceRef } from '@wsa/schemas';

export interface ExtractTelemetryRecord {
  readonly requestId: string;
  readonly keyId: string;
  readonly sourceRef?: ClaimSourceRef;
  readonly sourceSha256?: string;
  readonly sourceByteLength?: number;
  readonly provider: 'xai';
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costInUsdTicks?: number;
  readonly outcome: 'success' | 'error' | 'budget_exhausted';
  readonly status?: ExtractionResult['status'];
  readonly errorReason?: string;
  readonly httpStatus?: number;
  readonly stage?: 'auth' | 'handler';
  readonly workerVersionId?: string;
  readonly workerSourceSha?: string;
}

export function withWorkerVersion(
  record: ExtractTelemetryRecord,
  metadata?: WorkerVersionMetadata,
): ExtractTelemetryRecord {
  if (metadata === undefined) return record;
  return {
    ...record,
    workerVersionId: metadata.id,
    ...(/^[a-f0-9]{40}$/.test(metadata.tag)
      ? { workerSourceSha: metadata.tag }
      : {}),
  };
}

export function telemetryObjectKey(
  monthKey: string,
  eventId: string,
  stage?: ExtractTelemetryRecord['stage'],
): string {
  return `${stage === 'auth' ? 'auth' : 'xai'}/${monthKey}/${eventId}.json`;
}

export async function writeTelemetryRecord(
  bucket: R2Bucket,
  monthKey: string,
  record: ExtractTelemetryRecord,
): Promise<void> {
  await bucket.put(
    telemetryObjectKey(monthKey, crypto.randomUUID(), record.stage),
    JSON.stringify(record),
    {
      httpMetadata: {
        contentType: 'application/json',
      },
    },
  );
}

export function buildSuccessTelemetryRecord(args: {
  readonly keyId: string;
  readonly input: ExtractionInput;
  readonly sourceByteLength: number;
  readonly result: ExtractionResult;
}): ExtractTelemetryRecord {
  return {
    requestId: args.result.requestId,
    keyId: args.keyId,
    sourceRef: args.input.sourceRef,
    sourceSha256: args.input.sourceSha256.toLowerCase(),
    sourceByteLength: args.sourceByteLength,
    provider: 'xai',
    model: args.result.model,
    inputTokens: args.result.usage.inputTokens,
    cachedInputTokens: args.result.usage.cachedInputTokens ?? 0,
    outputTokens: args.result.usage.outputTokens,
    totalTokens: args.result.usage.totalTokens,
    ...(args.result.usage.costInUsdTicks === undefined
      ? {}
      : { costInUsdTicks: args.result.usage.costInUsdTicks }),
    outcome: 'success',
    status: args.result.status,
  };
}

export function buildBudgetExhaustedTelemetryRecord(args: {
  readonly keyId: string;
  readonly input: ExtractionInput;
  readonly sourceByteLength: number;
  readonly model: string;
}): ExtractTelemetryRecord {
  return {
    requestId: args.input.requestId,
    keyId: args.keyId,
    sourceRef: args.input.sourceRef,
    sourceSha256: args.input.sourceSha256.toLowerCase(),
    sourceByteLength: args.sourceByteLength,
    provider: 'xai',
    model: args.model,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    outcome: 'budget_exhausted',
  };
}

export function buildErrorTelemetryRecord(args: {
  readonly keyId: string;
  readonly input: ExtractionInput;
  readonly sourceByteLength: number;
  readonly model: string;
}): ExtractTelemetryRecord {
  return {
    requestId: args.input.requestId,
    keyId: args.keyId,
    sourceRef: args.input.sourceRef,
    sourceSha256: args.input.sourceSha256.toLowerCase(),
    sourceByteLength: args.sourceByteLength,
    provider: 'xai',
    model: args.model,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    outcome: 'error',
    stage: 'handler',
  };
}

export function buildAuthFailureTelemetryRecord(args: {
  readonly requestId: string;
  readonly keyId: 'missing' | 'provided';
  readonly model: string;
  readonly reason: string;
}): ExtractTelemetryRecord {
  return {
    requestId: args.requestId,
    keyId: args.keyId,
    provider: 'xai',
    model: args.model,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    outcome: 'error',
    errorReason: args.reason,
    httpStatus: 401,
    stage: 'auth',
  };
}
