const MONTH_PREFIX = 'xai/';

export interface BudgetState {
  readonly monthKey: string;
  readonly monthToDateCostUsdTicks: number;
  readonly monthlyCapUsdTicks: number;
}

export class BudgetExhaustedError extends Error {
  readonly status = 429;
  readonly reason = 'budget_exhausted';

  constructor(readonly state: BudgetState) {
    super('budget_exhausted');
    this.name = 'BudgetExhaustedError';
  }
}

export function readBudgetCapUsdTicks(env: {
  readonly XAI_BUDGET_MONTHLY_CAP_USD_TICKS?: string;
}): number {
  const raw = env.XAI_BUDGET_MONTHLY_CAP_USD_TICKS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (
    raw === undefined ||
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0
  ) {
    throw new Error('missing or invalid XAI_BUDGET_MONTHLY_CAP_USD_TICKS');
  }
  return parsed;
}

export async function assertBudgetAvailable(
  bucket: R2Bucket,
  monthlyCapUsdTicks: number,
  now: Date = new Date(),
): Promise<BudgetState> {
  const monthKey = toMonthKey(now);
  const monthToDateCostUsdTicks = await readMonthToDateCostUsdTicks(
    bucket,
    monthKey,
  );
  const state = {
    monthKey,
    monthToDateCostUsdTicks,
    monthlyCapUsdTicks,
  } satisfies BudgetState;

  if (monthToDateCostUsdTicks >= monthlyCapUsdTicks) {
    throw new BudgetExhaustedError(state);
  }

  return state;
}

export async function readMonthToDateCostUsdTicks(
  bucket: R2Bucket,
  monthKey: string,
): Promise<number> {
  const prefix = `${MONTH_PREFIX}${monthKey}/`;
  let cursor: string | undefined;
  let total = 0;

  do {
    const page = await bucket.list({
      prefix,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of page.objects) {
      const stored = await bucket.get(object.key);
      if (stored === null) {
        continue;
      }

      const parsed = JSON.parse(await stored.text()) as {
        costInUsdTicks?: unknown;
      };
      if (typeof parsed.costInUsdTicks === 'number') {
        total += parsed.costInUsdTicks;
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);

  return total;
}

export function toMonthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}
