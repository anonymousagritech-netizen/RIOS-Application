/**
 * Performance management (brief §14 — performance management). Pure scoring for
 * employee review cycles: a weighted overall rating from per-goal scores and the
 * rating band it falls in. Scores are on a 1–5 scale; weights are arbitrary
 * positive numbers (normalised internally). No I/O — the server persists reviews
 * and asks this module for the roll-up.
 */

export interface Goal {
  title?: string;
  /** Relative importance (any positive number). */
  weight: number;
  /** Achievement score, 1–5. */
  score: number;
}

export type RatingBand = 'below' | 'developing' | 'meets' | 'exceeds';

/** Weighted overall rating = Σ(weight·score) / Σweight, rounded to 2 dp. 0 if no weighted goals. */
export function weightedRating(goals: Goal[]): number {
  const list = (goals ?? []).filter((g) => g.weight > 0);
  const wsum = list.reduce((a, g) => a + g.weight, 0);
  if (wsum === 0) return 0;
  const weighted = list.reduce((a, g) => a + g.weight * g.score, 0);
  return Math.round((weighted / wsum) * 100) / 100;
}

/** The band a rating falls in: <2 below, <3 developing, <4 meets, else exceeds. */
export function ratingBand(score: number): RatingBand {
  if (score < 2) return 'below';
  if (score < 3) return 'developing';
  if (score < 4) return 'meets';
  return 'exceeds';
}

/** Normalise goal weights to fractions summing to 1 (empty/zero → []). */
export function normaliseWeights(goals: Goal[]): { title?: string; weight: number }[] {
  const list = goals ?? [];
  const wsum = list.reduce((a, g) => a + Math.max(0, g.weight), 0);
  if (wsum === 0) return [];
  return list.map((g) => ({ title: g.title, weight: Math.max(0, g.weight) / wsum }));
}
