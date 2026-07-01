/**
 * Catastrophe model adapter - the extension point for commercial CAT vendors
 * (RMS, AIR/Verisk, KatRisk, JBA) without redesigning the platform.
 *
 * `CatModelProvider` is the interface every vendor adapter implements; the app
 * depends only on this interface. `MockCatModel` is a deterministic, dependency-
 * free provider used until a licensed vendor is connected - it produces a
 * plausible PML curve, AAL and exceedance-probability (EP) curve from an exposure
 * and peril so the CAT dashboards render real shapes today. A real adapter (see
 * the connectors module) swaps in behind the same interface.
 *
 * All money is integer minor units.
 */

export interface CatModelInput {
  /** Aggregate exposure to the peril/zone, in minor units. */
  aggregateExposureMinor: number;
  peril: string;                 // e.g. 'HURRICANE', 'EARTHQUAKE', 'FLOOD'
  region?: string;
}

export interface CatEpPoint {
  returnPeriod: number;          // years
  exceedanceProb: number;        // 1 / returnPeriod
  lossMinor: number;             // occurrence loss at this return period
}

export interface CatModelResult {
  provider: string;
  peril: string;
  region?: string;
  aalMinor: number;                          // average annual loss
  pmlMinor: Record<number, number>;          // return period → PML (occurrence)
  epCurve: CatEpPoint[];
  currency?: string;
}

export interface CatModelProvider {
  readonly name: string;
  run(input: CatModelInput): CatModelResult;
}

/** Standard return periods the dashboards chart. */
export const RETURN_PERIODS = [10, 25, 50, 100, 250, 500, 1000] as const;

/**
 * Per-peril severity shape. `mean` scales the AAL; `tail` controls how fast the
 * PML rises with return period (heavier tail → steeper curve). Deterministic.
 */
const PERIL_PROFILE: Record<string, { aalFrac: number; tail: number }> = {
  HURRICANE:   { aalFrac: 0.012, tail: 0.62 },
  WINDSTORM:   { aalFrac: 0.010, tail: 0.58 },
  EARTHQUAKE:  { aalFrac: 0.008, tail: 0.72 },
  FLOOD:       { aalFrac: 0.014, tail: 0.50 },
  WILDFIRE:    { aalFrac: 0.009, tail: 0.55 },
  HAIL:        { aalFrac: 0.011, tail: 0.45 },
  TSUNAMI:     { aalFrac: 0.006, tail: 0.78 },
  STORMSURGE:  { aalFrac: 0.010, tail: 0.60 },
  DEFAULT:     { aalFrac: 0.010, tail: 0.58 },
};

function profileFor(peril: string) {
  return PERIL_PROFILE[peril.toUpperCase().replace(/[^A-Z]/g, '')] ?? PERIL_PROFILE.DEFAULT!;
}

export class MockCatModel implements CatModelProvider {
  readonly name = 'RIOS Mock CAT';

  run(input: CatModelInput): CatModelResult {
    const exposure = Math.max(0, input.aggregateExposureMinor);
    const p = profileFor(input.peril);
    const aalMinor = Math.round(exposure * p.aalFrac);

    // Occurrence PML rises with the log of the return period, capped at exposure.
    // loss(rp) = exposure * min(1, base * ln(rp) ^ (1 / (1 - tail)) / K)
    const K = 9; // normalisation so the 1000-yr PML approaches a sensible fraction
    const pmlMinor: Record<number, number> = {};
    const epCurve: CatEpPoint[] = [];
    for (const rp of RETURN_PERIODS) {
      const shape = Math.pow(Math.log(rp), 1 / (1 - p.tail)) / K;
      const frac = Math.min(0.95, p.aalFrac * 6 + shape * 0.12);
      const lossMinor = Math.round(exposure * Math.min(1, frac));
      pmlMinor[rp] = lossMinor;
      epCurve.push({ returnPeriod: rp, exceedanceProb: round4(1 / rp), lossMinor });
    }
    return { provider: this.name, peril: input.peril, region: input.region, aalMinor, pmlMinor, epCurve };
  }
}

/** Tail Value-at-Risk (mean loss beyond the p-th percentile) from an EP curve. */
export function tvarFromEpCurve(epCurve: CatEpPoint[], percentile: number): number {
  const threshold = 1 - percentile; // e.g. p99 → exceedance 0.01
  const tail = epCurve.filter((e) => e.exceedanceProb <= threshold);
  if (!tail.length) return epCurve.length ? epCurve[epCurve.length - 1]!.lossMinor : 0;
  return Math.round(tail.reduce((a, e) => a + e.lossMinor, 0) / tail.length);
}

/** The single default provider the app uses until a vendor adapter is registered. */
export const defaultCatModel: CatModelProvider = new MockCatModel();

function round4(v: number): number { return Math.round(v * 10000) / 10000; }
