/**
 * Stochastic (Monte Carlo) loss-simulation engine for excess-of-loss layers.
 *
 * Brief §7.2 (non-proportional) extended with §16 analytics: simulate a portfolio
 * of annual loss outcomes for a treaty layer, then summarise the net-result
 * distribution (mean, std-dev, VaR, TVaR/CVaR) and pricing diagnostics
 * (probability of attachment, expected loss to layer).
 *
 * CRITICAL — determinism. The domain core must be pure and unit-testable with no
 * I/O, framework, DB, or clock (brief §4.4). `Math.random()` is therefore banned:
 * it is non-deterministic and would make tests irreproducible. ALL randomness in
 * this file is driven by an explicit numeric `seed` through a small seeded PRNG
 * (mulberry32). The same seed ALWAYS yields the same draws, the same summary, and
 * the same comparison — see simulation.test.ts.
 *
 * Money is integer minor units (ADR 0003). Severities are sampled as real numbers
 * (a severity *is* a continuous quantity) and converted to integer minor units at
 * the boundary; every money aggregate (recoveries, net result) stays integer.
 */

// ---------------------------------------------------------------------------
// 1. Seeded PRNG
// ---------------------------------------------------------------------------

/**
 * mulberry32 — a tiny, fast, well-distributed 32-bit PRNG.
 *
 * Given a seed it returns a generator producing a deterministic stream of
 * numbers in [0, 1). The whole engine's reproducibility rests on this: same
 * seed in ⇒ identical stream out, on every platform (pure integer/float ops).
 *
 * @param seed integer seed; any finite number (it is masked to 32 bits).
 * @returns a function `() => number` yielding the next draw in [0, 1).
 */
export function makeRng(seed: number): () => number {
  // Force to a 32-bit unsigned integer state so the stream is platform-stable.
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A pull-on-demand random source in [0, 1). */
export type Rng = () => number;

// ---------------------------------------------------------------------------
// 2. Sampling helpers (frequency & severity)
// ---------------------------------------------------------------------------

/**
 * Standard normal variate via the Box–Muller transform.
 * Consumes two uniforms from `rng`. Internal helper for the lognormal.
 */
function sampleStandardNormal(rng: Rng): number {
  // Guard u1 away from 0 so log() is finite.
  const u1 = Math.max(rng(), Number.MIN_VALUE);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Lognormal severity sample: X = exp(mu + sigma·Z), Z ~ N(0,1).
 *
 * @param rng seeded source.
 * @param mu     mean of the underlying normal (log-scale location).
 * @param sigma  std-dev of the underlying normal (log-scale shape), ≥ 0.
 * @returns a positive real severity (major currency units, not minor).
 */
export function sampleLognormal(rng: Rng, mu: number, sigma: number): number {
  return Math.exp(mu + sigma * sampleStandardNormal(rng));
}

/**
 * Poisson frequency sample (claim count) via Knuth's multiplicative algorithm.
 *
 * Draws the number of events in a period given a mean rate `lambda`. Consumes a
 * variable number of uniforms (≈ lambda + 1). Adequate and exact for the small
 * lambda typical of XL frequency; for very large lambda a normal approximation
 * would be cheaper, but we keep it exact for determinism clarity.
 *
 * @param rng seeded source.
 * @param lambda expected number of events per period, ≥ 0.
 * @returns a non-negative integer event count.
 */
export function samplePoisson(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

/**
 * Pareto (Type I) severity sample via inverse-CDF: X = xmin / U^(1/alpha).
 *
 * Heavy-tailed; good for large single-loss severities in cat/liability XL.
 *
 * @param rng seeded source.
 * @param alpha tail index > 0 (smaller ⇒ heavier tail).
 * @param xmin  scale / minimum value > 0.
 * @returns a real severity ≥ xmin (major currency units, not minor).
 */
export function samplePareto(rng: Rng, alpha: number, xmin: number): number {
  // U in (0,1]; guard away from 0 so the inverse is finite.
  const u = Math.max(rng(), Number.MIN_VALUE);
  return xmin / Math.pow(u, 1 / alpha);
}

// ---------------------------------------------------------------------------
// 3. simulateLayerResults
// ---------------------------------------------------------------------------

/** Severity distribution selector for the simulation. */
export type SeveritySpec =
  | { dist: 'lognormal'; params: { mu: number; sigma: number } }
  | { dist: 'pareto'; params: { alpha: number; xmin: number } };

/** Frequency model (Poisson) for annual claim count. */
export interface FrequencySpec {
  /** Expected number of claims per simulated period. */
  lambda: number;
}

/** The excess-of-loss layer under test, in minor units. */
export interface LayerSpec {
  /** Attachment / retention: losses below this recover nothing. */
  attachmentMinor: number;
  /** Limit: most this layer pays for a single loss/occurrence. */
  limitMinor: number;
}

/**
 * Reinstatement terms used to derive aggregate cover and (optionally) cost.
 * Aggregate cover for the period = limit × (count + 1).
 */
export interface ReinstatementSpec {
  /** Number of reinstatements (0 = single shot). `Infinity` = unlimited. */
  count: number;
  /**
   * Reinstatement cost as a fraction of the layer premium per 100% of limit
   * reinstated (e.g. 1.0 = 100% "1 @ 100%"). If omitted, reinstatements are free
   * and only cap aggregate cover; if present, reinstatement premium reduces the
   * net result. The same rate is applied to every reinstatement.
   */
  rate?: number;
}

export interface SimulationInput {
  /** Deterministic seed for the whole run. */
  seed: number;
  /** Number of Monte Carlo iterations (simulated periods). */
  iterations: number;
  /** Poisson frequency model. */
  frequency: FrequencySpec;
  /** Severity model. */
  severity: SeveritySpec;
  /** The layer to evaluate. */
  layer: LayerSpec;
  /** Annual/deposit premium for the layer (minor units). */
  premiumMinor: number;
  /** Optional reinstatement terms (aggregate cover + optional reinstatement cost). */
  reinstatements?: ReinstatementSpec;
}

/** Distribution summary of the simulated outcomes (all money in minor units). */
export interface SimulationSummary {
  iterations: number;
  /** Mean net result = E[premium − recoveries (− reinstatement premium)]. */
  meanNetResultMinor: number;
  /** Population standard deviation of the net result. */
  stdDevNetResultMinor: number;
  /** Mean recovery (ceded loss) to the layer = expected loss to layer. */
  expectedLossToLayerMinor: number;
  /** P(at least one loss reaches the attachment) — probability of attachment. */
  probabilityOfAttachment: number;
  /**
   * Value-at-Risk of the LOSS (recoveries) at each confidence level: the
   * recovery quantile not exceeded with probability p. A larger recovery is a
   * worse outcome, so VaR is taken on the recovery (loss) distribution.
   */
  varRecoveryMinor: { p95: number; p99: number };
  /** Tail VaR / CVaR: mean recovery in the worst (1−p) tail, at each level. */
  tvarRecoveryMinor: { p95: number; p99: number };
}

/**
 * Apply one ground-up loss to the layer (excess-of-loss): recover the slice
 * above the attachment, capped at the limit. Integer minor units throughout.
 */
function recoverFromLayer(lossMinor: number, layer: LayerSpec): number {
  const excess = Math.max(0, lossMinor - layer.attachmentMinor);
  return Math.min(excess, layer.limitMinor);
}

/**
 * Draw one severity from the chosen distribution, in integer minor units.
 * Negative/NaN draws are floored at 0; rounding is the single conversion point
 * from real-valued severity to integer money.
 */
function sampleSeverityMinor(rng: Rng, severity: SeveritySpec): number {
  const raw =
    severity.dist === 'lognormal'
      ? sampleLognormal(rng, severity.params.mu, severity.params.sigma)
      : samplePareto(rng, severity.params.alpha, severity.params.xmin);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.round(raw);
}

/**
 * Aggregate cover (max total recovery for the period) implied by reinstatements:
 * limit × (count + 1). Without reinstatements a single full-limit loss is the cap
 * per occurrence but the period is unbounded across occurrences; we model the
 * common XL convention that absent terms the annual aggregate equals one limit
 * (single shot, 0 reinstatements).
 */
function aggregateCoverMinor(layer: LayerSpec, reinstatements?: ReinstatementSpec): number {
  const count = reinstatements ? reinstatements.count : 0;
  if (!Number.isFinite(count)) return Number.MAX_SAFE_INTEGER;
  return layer.limitMinor * (count + 1);
}

/**
 * Simulate one period's recoveries and reinstatement premium given a frequency
 * draw and severity draws. Returns the capped total recovery, whether the layer
 * attached, and the reinstatement premium charged (0 if not modelled).
 *
 * Reasoning: each loss erodes the layer per-occurrence (excess up to limit); the
 * running total is capped by the aggregate cover. Reinstatement premium is
 * charged pro-rata as to amount on the limit reinstated by each loss (every
 * recovery except the portion that exhausts the final limit reinstates cover),
 * at `rate` × (amountReinstated / limit) × premium.
 */
function simulateOnePeriod(
  rng: Rng,
  input: SimulationInput,
  aggregateCover: number,
): { recoveryMinor: number; attached: boolean; reinstatementPremiumMinor: number } {
  const count = samplePoisson(rng, input.frequency.lambda);
  let recovery = 0;
  let attached = false;
  let reinstatedLimit = 0; // limit reinstated so far (drives reinstatement premium)
  const limit = input.layer.limitMinor;
  const rate = input.reinstatements?.rate;

  for (let i = 0; i < count; i++) {
    const loss = sampleSeverityMinor(rng, input.severity);
    const perOcc = recoverFromLayer(loss, input.layer);
    if (perOcc > 0) attached = true;

    const capacityLeft = aggregateCover - recovery;
    const applied = Math.max(0, Math.min(perOcc, capacityLeft));
    if (applied <= 0) continue;

    // Reinstatement premium: the recovery before this one's "last limit" reinstates
    // cover. We reinstate up to (aggregateCover − limit) of total recovery, i.e.
    // every minor unit of recovery beyond the first full limit consumes a
    // reinstatement. Charge only when a rate is supplied and reinstatements exist.
    if (rate !== undefined && limit > 0) {
      const reinstatableTotal = Math.max(0, aggregateCover - limit);
      const newlyReinstatable = Math.max(
        0,
        Math.min(applied, reinstatableTotal - reinstatedLimit),
      );
      reinstatedLimit += newlyReinstatable;
    }

    recovery += applied;
  }

  const reinstatementPremiumMinor =
    rate !== undefined && limit > 0
      ? Math.round((reinstatedLimit / limit) * rate * input.premiumMinor)
      : 0;

  return { recoveryMinor: recovery, attached, reinstatementPremiumMinor };
}

/** Population standard deviation of an array of numbers. */
function stdDev(xs: number[], mean: number): number {
  if (xs.length === 0) return 0;
  const variance = xs.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / xs.length;
  return Math.sqrt(variance);
}

/**
 * VaR at confidence p on an ascending-sorted sample: the value at quantile p,
 * i.e. the loss not exceeded with probability p. Uses the nearest-rank method
 * (index = ceil(p·n) − 1), which is deterministic and integer-money-safe.
 */
function valueAtRisk(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil(p * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx]!;
}

/**
 * Tail VaR / CVaR at confidence p: the mean of the worst (1−p) tail (the samples
 * at or beyond the VaR rank). For p=0.95 on 100 samples this averages the top 5.
 */
function tailValueAtRisk(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil(p * sortedAsc.length);
  const start = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  let acc = 0;
  for (let i = start; i < sortedAsc.length; i++) acc += sortedAsc[i]!;
  return Math.round(acc / (sortedAsc.length - start));
}

/**
 * Run the Monte Carlo simulation for a single layer and return a distribution
 * summary. Deterministic given `seed`.
 *
 * For each of `iterations` periods: draw a Poisson claim count, draw that many
 * severities, push each through the layer (excess-of-loss), sum recoveries
 * (capped by aggregate cover when reinstatements are given), and compute the net
 * result = premium − recoveries − reinstatement premium. The summary reports the
 * net-result mean/std-dev and the recovery-side tail metrics (VaR, TVaR), the
 * expected loss to layer, and the probability of attachment.
 */
export function simulateLayerResults(input: SimulationInput): SimulationSummary {
  if (input.iterations <= 0) throw new RangeError('iterations must be a positive integer');
  const rng = makeRng(input.seed);
  const aggregateCover = aggregateCoverMinor(input.layer, input.reinstatements);

  const netResults: number[] = new Array(input.iterations);
  const recoveries: number[] = new Array(input.iterations);
  let attachmentCount = 0;
  let recoverySum = 0;
  let netSum = 0;

  for (let i = 0; i < input.iterations; i++) {
    const { recoveryMinor, attached, reinstatementPremiumMinor } = simulateOnePeriod(
      rng,
      input,
      aggregateCover,
    );
    const net = input.premiumMinor - recoveryMinor - reinstatementPremiumMinor;
    netResults[i] = net;
    recoveries[i] = recoveryMinor;
    netSum += net;
    recoverySum += recoveryMinor;
    if (attached) attachmentCount++;
  }

  const meanNet = netSum / input.iterations;
  const recoveriesAsc = [...recoveries].sort((a, b) => a - b);

  return {
    iterations: input.iterations,
    meanNetResultMinor: Math.round(meanNet),
    stdDevNetResultMinor: Math.round(stdDev(netResults, meanNet)),
    expectedLossToLayerMinor: Math.round(recoverySum / input.iterations),
    probabilityOfAttachment: attachmentCount / input.iterations,
    varRecoveryMinor: {
      p95: valueAtRisk(recoveriesAsc, 0.95),
      p99: valueAtRisk(recoveriesAsc, 0.99),
    },
    tvarRecoveryMinor: {
      p95: tailValueAtRisk(recoveriesAsc, 0.95),
      p99: tailValueAtRisk(recoveriesAsc, 0.99),
    },
  };
}

// ---------------------------------------------------------------------------
// 4. compareStructures
// ---------------------------------------------------------------------------

/** A candidate treaty structure to evaluate against a shared loss set. */
export interface CandidateStructure {
  /** Human label, e.g. "$5m xs $5m, 1 RI". */
  name: string;
  /** The layer for this candidate. */
  layer: LayerSpec;
  /** Optional reinstatement terms for this candidate. */
  reinstatements?: ReinstatementSpec;
}

export interface CompareInput {
  /** Deterministic seed shared by every candidate (same loss set). */
  seed: number;
  /** Number of Monte Carlo iterations. */
  iterations: number;
  /** Frequency model (shared). */
  frequency: FrequencySpec;
  /** Severity model (shared). */
  severity: SeveritySpec;
  /** Premium (shared) — candidates differ by structure, not price, for comparability. */
  premiumMinor: number;
  /** Two or more candidate structures. */
  structures: CandidateStructure[];
}

export interface StructureComparison {
  name: string;
  summary: SimulationSummary;
}

/**
 * Compare 2+ candidate structures over the SAME simulated loss set so the
 * results are directly comparable. Each candidate re-runs `simulateLayerResults`
 * with the SAME `seed`; because the PRNG is seeded identically and the frequency
 * and severity specs are shared, every candidate sees the identical stream of
 * Poisson counts and severities — only the layer/reinstatement terms differ.
 * This is the variance-reduction trick of common random numbers: differences
 * between structures reflect the structures, not sampling noise.
 */
export function compareStructures(input: CompareInput): StructureComparison[] {
  if (input.structures.length < 2) {
    throw new RangeError('compareStructures requires at least two structures');
  }
  return input.structures.map((s) => ({
    name: s.name,
    summary: simulateLayerResults({
      seed: input.seed,
      iterations: input.iterations,
      frequency: input.frequency,
      severity: input.severity,
      premiumMinor: input.premiumMinor,
      layer: s.layer,
      reinstatements: s.reinstatements,
    }),
  }));
}
