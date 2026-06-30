/**
 * Catastrophe analytics (brief §13 - cat analysis / PML / RDS).
 *
 * Works from an Event Loss Table (ELT): each potential event carries an annual
 * occurrence rate (frequency λ) and a loss. From it we derive the standard
 * actuarial cat metrics - Average Annual Loss, the occurrence exceedance
 * probability (OEP) curve, and the loss at a given return period (PML). Pure
 * and unit-tested, so the numbers are reproducible. Losses are integer minor
 * units; rates are events-per-year (e.g. 0.01 = a 1-in-100 event).
 */

export interface EltEvent {
  id?: string;
  name?: string;
  /** Annual occurrence rate λ (events per year). */
  rate: number;
  /** Ground-up or layer loss for the event, in minor units. */
  lossMinor: number;
}

/** Average Annual Loss = Σ rate_i · loss_i (rounded to whole minor units). */
export function averageAnnualLoss(elt: EltEvent[]): number {
  return Math.round((elt ?? []).reduce((acc, e) => acc + e.rate * e.lossMinor, 0));
}

/**
 * Occurrence exceedance probability: the probability that at least one event in
 * a year exceeds `thresholdMinor`. With Poisson frequencies the aggregate rate
 * of qualifying events is λ_exc = Σ_{loss > threshold} rate, and
 * P(exceed) = 1 − e^(−λ_exc).
 */
export function exceedanceProbability(elt: EltEvent[], thresholdMinor: number): number {
  const lambda = (elt ?? []).filter((e) => e.lossMinor > thresholdMinor).reduce((a, e) => a + e.rate, 0);
  return 1 - Math.exp(-lambda);
}

export interface EpPoint {
  lossMinor: number;
  /** Aggregate exceedance rate at this loss level. */
  rate: number;
  /** P(at least one exceedance in a year). */
  probability: number;
  /** 1 / rate, the occurrence return period in years. */
  returnPeriod: number;
}

/**
 * The OEP curve: one point per distinct event-loss level, from largest loss to
 * smallest, with the cumulative exceedance rate, annual probability and return
 * period at each level.
 */
export function exceedanceCurve(elt: EltEvent[]): EpPoint[] {
  const sorted = [...(elt ?? [])].sort((a, b) => b.lossMinor - a.lossMinor);
  const points: EpPoint[] = [];
  let cumRate = 0;
  let lastLoss: number | null = null;
  for (const e of sorted) {
    cumRate += e.rate;
    if (e.lossMinor === lastLoss && points.length) {
      // Same loss level: fold the rate into the existing point.
      const p = points[points.length - 1]!;
      p.rate = cumRate;
      p.probability = 1 - Math.exp(-cumRate);
      p.returnPeriod = cumRate > 0 ? 1 / cumRate : Infinity;
      continue;
    }
    points.push({
      lossMinor: e.lossMinor,
      rate: cumRate,
      probability: 1 - Math.exp(-cumRate),
      returnPeriod: cumRate > 0 ? 1 / cumRate : Infinity,
    });
    lastLoss = e.lossMinor;
  }
  return points;
}

/**
 * Probable Maximum Loss at a given return period (years): the loss level whose
 * cumulative occurrence rate first reaches 1/returnPeriod. Returns 0 when no
 * modelled event is that rare. This is the occurrence (OEP) PML.
 */
export function probableMaximumLoss(elt: EltEvent[], returnPeriod: number): number {
  if (returnPeriod <= 0) return 0;
  const targetRate = 1 / returnPeriod;
  const sorted = [...(elt ?? [])].sort((a, b) => b.lossMinor - a.lossMinor);
  let cumRate = 0;
  for (const e of sorted) {
    cumRate += e.rate;
    if (cumRate >= targetRate - 1e-12) return e.lossMinor;
  }
  return 0;
}

/** PML at several return periods at once, e.g. [10, 50, 100, 250]. */
export function pmlProfile(elt: EltEvent[], returnPeriods: number[]): { returnPeriod: number; lossMinor: number }[] {
  return returnPeriods.map((rp) => ({ returnPeriod: rp, lossMinor: probableMaximumLoss(elt, rp) }));
}
