import {
  BudgetExhaustedError,
  assertBudgetAvailable,
  readBudgetCapUsdTicks,
  readMonthToDateCostUsdTicks,
  toMonthKey,
} from './budget-guard.js';

class FakeObject {
  constructor(private readonly payload: string) {}
  text(): Promise<string> {
    return Promise.resolve(this.payload);
  }
}

class FakeBucket {
  constructor(private readonly entries: Record<string, string>) {}

  list(args: { prefix?: string; cursor?: string }) {
    const objects = Object.keys(this.entries)
      .filter((key) => args.prefix === undefined || key.startsWith(args.prefix))
      .map((key) => ({ key }));
    return Promise.resolve({ objects, truncated: false, cursor: undefined });
  }

  get(key: string): Promise<FakeObject | null> {
    const value = this.entries[key];
    return Promise.resolve(value === undefined ? null : new FakeObject(value));
  }
}

describe('@wsa/extract-api-worker/budget-guard', () => {
  it('reads month-to-date cost from telemetry objects', async () => {
    const bucket = new FakeBucket({
      'xai/2026-04/req-1.json': JSON.stringify({ costInUsdTicks: 12 }),
      'xai/2026-04/req-2.json': JSON.stringify({ costInUsdTicks: 8 }),
      'xai/2026-03/req-3.json': JSON.stringify({ costInUsdTicks: 100 }),
    });

    await expect(
      readMonthToDateCostUsdTicks(bucket as unknown as R2Bucket, '2026-04'),
    ).resolves.toBe(20);
  });

  it('throws when the monthly cap is exhausted', async () => {
    const bucket = new FakeBucket({
      'xai/2026-04/req-1.json': JSON.stringify({ costInUsdTicks: 25 }),
    });

    await expect(
      assertBudgetAvailable(
        bucket as unknown as R2Bucket,
        25,
        new Date('2026-04-18T00:00:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it('returns state when budget remains available', async () => {
    const bucket = new FakeBucket({
      'xai/2026-04/req-1.json': JSON.stringify({ costInUsdTicks: 10 }),
    });

    await expect(
      assertBudgetAvailable(
        bucket as unknown as R2Bucket,
        25,
        new Date('2026-04-18T00:00:00.000Z'),
      ),
    ).resolves.toMatchObject({
      monthKey: '2026-04',
      monthToDateCostUsdTicks: 10,
      monthlyCapUsdTicks: 25,
    });
  });

  it('requires a valid integer budget cap env var', () => {
    expect(() =>
      readBudgetCapUsdTicks({ XAI_BUDGET_MONTHLY_CAP_USD_TICKS: 'nope' }),
    ).toThrow('missing or invalid XAI_BUDGET_MONTHLY_CAP_USD_TICKS');
    expect(
      readBudgetCapUsdTicks({ XAI_BUDGET_MONTHLY_CAP_USD_TICKS: '123' }),
    ).toBe(123);
  });

  it.each(['123junk', '1.5', '-1', '', '9007199254740993'])(
    'rejects malformed or unsafe budget cap %s',
    (value) => {
      expect(() =>
        readBudgetCapUsdTicks({ XAI_BUDGET_MONTHLY_CAP_USD_TICKS: value }),
      ).toThrow('missing or invalid');
    },
  );

  it('formats a YYYY-MM month key', () => {
    expect(toMonthKey(new Date('2026-04-18T00:00:00.000Z'))).toBe('2026-04');
  });
});
