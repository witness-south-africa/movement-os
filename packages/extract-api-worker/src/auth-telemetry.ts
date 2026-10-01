const SAMPLE_LIMIT = 6;
const WINDOW_MS = 60_000;

// Sampling limits R2 work in an isolate; it is not a fleet-wide abuse quota.
export function createAuthTelemetrySampler(): (now: Date) => boolean {
  let windowStart = Number.NEGATIVE_INFINITY;
  let admitted = 0;
  return (now) => {
    if (now.getTime() - windowStart >= WINDOW_MS) {
      windowStart = now.getTime();
      admitted = 0;
    }
    if (admitted >= SAMPLE_LIMIT) {
      return false;
    }
    admitted += 1;
    return true;
  };
}
