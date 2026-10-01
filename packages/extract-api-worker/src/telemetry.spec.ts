import { ArtefactIdSchema, ulid } from '@wsa/schemas';
import {
  assertBudgetAvailable,
  readMonthToDateCostUsdTicks,
} from './budget-guard.js';
import {
  buildAuthFailureTelemetryRecord,
  buildBudgetExhaustedTelemetryRecord,
  buildErrorTelemetryRecord,
  buildSuccessTelemetryRecord,
  telemetryObjectKey,
  writeTelemetryRecord,
  withWorkerVersion,
} from './telemetry.js';

class FakeBucket {
  readonly writes: Array<{ key: string; body: string }> = [];

  put(key: string, body: string): Promise<void> {
    this.writes.push({ key, body });
    return Promise.resolve();
  }

  list(args: { prefix: string }) {
    return Promise.resolve({
      objects: this.writes
        .filter((item) => item.key.startsWith(args.prefix))
        .map(({ key }) => ({ key })),
      truncated: false,
    });
  }

  get(key: string) {
    const item = this.writes.find((entry) => entry.key === key);
    return Promise.resolve(
      item === undefined ? null : { text: () => Promise.resolve(item.body) },
    );
  }
}

const input = {
  requestId: 'req-001',
  sourceRef: {
    kind: 'artefact',
    id: ArtefactIdSchema.parse(ulid('ARTF1')),
  },
  sourceUrl: 'https://example.org/source',
  sourceSha256: 'a'.repeat(64),
  sourceFetchedAt: '2026-04-18T19:00:00.000Z',
  sourceText: 'already-redacted source text',
} as const;

describe('@wsa/extract-api-worker/telemetry', () => {
  it('builds the R2 object key under the monthly prefix', () => {
    expect(telemetryObjectKey('2026-04', 'req-001')).toBe(
      'xai/2026-04/req-001.json',
    );
  });

  it('keeps auth records outside the provider budget namespace', () => {
    expect(telemetryObjectKey('2026-04', 'event-id', 'auth')).toBe(
      'auth/2026-04/event-id.json',
    );
  });

  it('binds stored telemetry to the full Worker version and only a full source tag', () => {
    const record = buildAuthFailureTelemetryRecord({
      requestId: 'auth-event',
      keyId: 'missing',
      model: 'model',
      reason: 'missing_signature_headers',
    });
    const metadata = {
      id: 'e7f88286-b86b-4f31-b32a-0b896f5444c8',
      tag: 'a'.repeat(40),
      timestamp: '2026-10-01T08:00:00Z',
    };
    expect(withWorkerVersion(record, metadata)).toMatchObject({
      workerVersionId: metadata.id,
      workerSourceSha: metadata.tag,
    });
    expect(
      withWorkerVersion(record, { ...metadata, tag: 'short-tag' }),
    ).not.toHaveProperty('workerSourceSha');
    expect(withWorkerVersion(record)).not.toHaveProperty('workerVersionId');
  });

  it('counts repeated request IDs separately and excludes auth events from budget reads', async () => {
    const bucket = new FakeBucket();
    const store = bucket as unknown as R2Bucket;
    const record = buildSuccessTelemetryRecord({
      keyId: 'OP01',
      input,
      sourceByteLength: 27,
      result: {
        requestId: '../same-client-id',
        summary: '',
        provider: 'xai',
        model: 'grok-4-fast-reasoning',
        status: 'completed',
        items: [],
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          costInUsdTicks: 9,
        },
      },
    });
    await Promise.all([
      writeTelemetryRecord(store, '2026-04', record),
      writeTelemetryRecord(store, '2026-04', record),
      writeTelemetryRecord(
        store,
        '2026-04',
        buildAuthFailureTelemetryRecord({
          requestId: 'auth-event',
          keyId: 'missing',
          model: 'grok-4-fast-reasoning',
          reason: 'missing_signature_headers',
        }),
      ),
    ]);
    expect(new Set(bucket.writes.map(({ key }) => key)).size).toBe(3);
    expect(
      bucket.writes.filter(({ key }) => key.startsWith('xai/')),
    ).toHaveLength(2);
    expect(
      bucket.writes.every(({ key }) => !key.includes('same-client-id')),
    ).toBe(true);
    const read = jest.spyOn(bucket, 'get');
    await expect(readMonthToDateCostUsdTicks(store, '2026-04')).resolves.toBe(
      18,
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.every(([key]) => key.startsWith('xai/'))).toBe(true);
    await expect(
      assertBudgetAvailable(store, 18, new Date('2026-04-20')),
    ).rejects.toMatchObject({ reason: 'budget_exhausted' });
  });

  it('writes minimal success telemetry without source text', async () => {
    const bucket = new FakeBucket();
    const record = buildSuccessTelemetryRecord({
      keyId: 'OP01',
      input,
      sourceByteLength: 27,
      result: {
        requestId: 'req-001',
        summary: 'summary',
        provider: 'xai',
        model: 'grok-4-fast-reasoning',
        status: 'completed',
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          totalTokens: 14,
          costInUsdTicks: 9,
        },
        items: [],
      },
    });

    await writeTelemetryRecord(
      bucket as unknown as R2Bucket,
      '2026-04',
      record,
    );

    expect(bucket.writes).toHaveLength(1);
    const firstWrite = bucket.writes[0];
    if (firstWrite === undefined) {
      throw new Error('expected telemetry write');
    }
    const written = JSON.parse(firstWrite.body) as Record<string, unknown>;
    expect(written.requestId).toBe('req-001');
    expect(written.sourceSha256).toBe('a'.repeat(64));
    expect(written.sourceText).toBeUndefined();
    expect(written.costInUsdTicks).toBe(9);
  });

  it('builds a budget-exhausted telemetry record with zero usage', () => {
    expect(
      buildBudgetExhaustedTelemetryRecord({
        keyId: 'OP01',
        input,
        sourceByteLength: 27,
        model: 'grok-4-fast-reasoning',
      }),
    ).toMatchObject({
      outcome: 'budget_exhausted',
      totalTokens: 0,
    });
  });

  it('builds an error telemetry record with zero usage', () => {
    expect(
      buildErrorTelemetryRecord({
        keyId: 'OP01',
        input,
        sourceByteLength: 27,
        model: 'grok-4-fast-reasoning',
      }),
    ).toMatchObject({
      outcome: 'error',
      inputTokens: 0,
      totalTokens: 0,
    });
  });

  it('builds a minimal auth-failure telemetry record without source fields', () => {
    expect(
      buildAuthFailureTelemetryRecord({
        requestId: 'auth-mtr9k',
        keyId: 'missing',
        model: 'grok-4-fast-reasoning',
        reason: 'missing_signature_headers',
      }),
    ).toEqual({
      requestId: 'auth-mtr9k',
      keyId: 'missing',
      provider: 'xai',
      model: 'grok-4-fast-reasoning',
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      outcome: 'error',
      errorReason: 'missing_signature_headers',
      httpStatus: 401,
      stage: 'auth',
    });
  });

  it('omits costInUsdTicks when the provider does not return a cost', () => {
    expect(
      buildSuccessTelemetryRecord({
        keyId: 'OP01',
        input,
        sourceByteLength: 27,
        result: {
          requestId: 'req-001',
          summary: 'summary',
          provider: 'xai',
          model: 'grok-4-fast-reasoning',
          status: 'completed',
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            totalTokens: 14,
          },
          items: [],
        },
      }),
    ).not.toHaveProperty('costInUsdTicks');
  });
});
