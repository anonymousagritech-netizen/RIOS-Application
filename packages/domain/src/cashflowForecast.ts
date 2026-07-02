/**
 * Cash-flow forecasting (brief §9.8, §16 - Treasury dealing & liquidity).
 *
 * A pure bucketing engine that projects known scheduled cash items (premium
 * instalments, claim payments, investment-trade settlements) into equal-width
 * date buckets across a forecast horizon, netting inflows against outflows per
 * bucket. This is the *technical* projection: the server gathers the typed cash
 * items (from financial_event / investment_trade) and hands them here; the maths
 * stays pure so the forecast reconciles and is unit-testable.
 *
 * Money is integer minor units; a single currency per forecast (cross-currency
 * must be converted via FX first - throws on a mixed set so a silent mis-add can
 * never happen, mirroring portfolioSummary).
 */

export type CashDirection = 'INFLOW' | 'OUTFLOW';

export interface ScheduledCashItem {
  /** Expected cash date, ISO `yyyy-mm-dd`. */
  date: string;
  direction: CashDirection;
  amountMinor: number;
  currency: string;
  /** Provenance label, e.g. 'PREMIUM', 'CLAIM', 'TRADE'. */
  source: string;
}

export interface ForecastBucket {
  /** Inclusive start date of the bucket, ISO `yyyy-mm-dd`. */
  bucketDate: string;
  inflowMinor: number;
  outflowMinor: number;
  netMinor: number;
  currency: string;
  /** Distinct item sources landing in the bucket, sorted and `+`-joined; '' when empty. */
  source: string;
}

export interface CashFlowForecastResult {
  asOf: string;
  horizonDays: number;
  bucketDays: number;
  currency: string;
  buckets: ForecastBucket[];
  totalInflowMinor: number;
  totalOutflowMinor: number;
  netMinor: number;
}

export interface BucketCashFlowsInput {
  /** Forecast anchor date, ISO `yyyy-mm-dd`. */
  asOf: string;
  /** Days forward to project (items on/after asOf and strictly before asOf+horizon are included). */
  horizonDays: number;
  /** Width of each bucket in days (default 30 ~ monthly). */
  bucketDays?: number;
  /** The forecast currency; every item must match it. */
  currency: string;
  items: ScheduledCashItem[];
}

/** Parse an ISO `yyyy-mm-dd` date to a UTC-midnight epoch-day integer (pure, no clock). */
function toEpochDay(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new RangeError(`invalid ISO date: ${iso}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.floor(ms / 86_400_000);
}

/** Render a UTC epoch-day integer back to an ISO `yyyy-mm-dd` string. */
function fromEpochDay(day: number): string {
  const d = new Date(day * 86_400_000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/**
 * Bucket scheduled cash items into an equal-width date grid over the horizon.
 * Produces the full grid (empty buckets carry zeros) so the forecast is a stable
 * shape independent of which buckets happen to have activity. Items outside
 * `[asOf, asOf + horizonDays)` are ignored.
 */
export function bucketCashFlows(input: BucketCashFlowsInput): CashFlowForecastResult {
  const bucketDays = input.bucketDays ?? 30;
  if (!Number.isInteger(input.horizonDays) || input.horizonDays <= 0) {
    throw new RangeError('horizonDays must be a positive integer');
  }
  if (!Number.isInteger(bucketDays) || bucketDays <= 0) {
    throw new RangeError('bucketDays must be a positive integer');
  }
  const items = input.items ?? [];
  const wrong = items.find((i) => i.currency !== input.currency);
  if (wrong) {
    throw new Error(`bucketCashFlows requires a single currency ${input.currency}, got ${wrong.currency}`);
  }

  const asOfDay = toEpochDay(input.asOf);
  const bucketCount = Math.ceil(input.horizonDays / bucketDays);

  const buckets: ForecastBucket[] = [];
  const sourcesPerBucket: Array<Set<string>> = [];
  for (let b = 0; b < bucketCount; b++) {
    buckets.push({
      bucketDate: fromEpochDay(asOfDay + b * bucketDays),
      inflowMinor: 0,
      outflowMinor: 0,
      netMinor: 0,
      currency: input.currency,
      source: '',
    });
    sourcesPerBucket.push(new Set<string>());
  }

  let totalIn = 0;
  let totalOut = 0;
  for (const item of items) {
    const offset = toEpochDay(item.date) - asOfDay;
    if (offset < 0 || offset >= input.horizonDays) continue; // outside the horizon window
    const idx = Math.floor(offset / bucketDays);
    const bucket = buckets[idx]!;
    if (item.direction === 'INFLOW') {
      bucket.inflowMinor += item.amountMinor;
      totalIn += item.amountMinor;
    } else {
      bucket.outflowMinor += item.amountMinor;
      totalOut += item.amountMinor;
    }
    sourcesPerBucket[idx]!.add(item.source);
  }

  for (let b = 0; b < bucketCount; b++) {
    const bucket = buckets[b]!;
    bucket.netMinor = bucket.inflowMinor - bucket.outflowMinor;
    bucket.source = [...sourcesPerBucket[b]!].sort().join('+');
  }

  return {
    asOf: input.asOf,
    horizonDays: input.horizonDays,
    bucketDays,
    currency: input.currency,
    buckets,
    totalInflowMinor: totalIn,
    totalOutflowMinor: totalOut,
    netMinor: totalIn - totalOut,
  };
}
