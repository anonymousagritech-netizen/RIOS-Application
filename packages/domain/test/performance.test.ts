import { describe, it, expect } from 'vitest';
import { weightedRating, ratingBand, normaliseWeights, type Goal } from '../src/performance.js';

describe('weighted rating', () => {
  it('weights goal scores by importance', () => {
    const goals: Goal[] = [{ weight: 2, score: 4 }, { weight: 1, score: 1 }];
    expect(weightedRating(goals)).toBe(3); // (8+1)/3
  });

  it('rounds to two decimals and ignores zero weights', () => {
    expect(weightedRating([{ weight: 1, score: 4 }, { weight: 1, score: 5 }, { weight: 1, score: 5 }])).toBe(4.67);
    expect(weightedRating([{ weight: 0, score: 1 }, { weight: 2, score: 4 }])).toBe(4);
    expect(weightedRating([])).toBe(0);
  });
});

describe('rating band', () => {
  it('maps a score to its band', () => {
    expect(ratingBand(1.5)).toBe('below');
    expect(ratingBand(2.5)).toBe('developing');
    expect(ratingBand(3)).toBe('meets');
    expect(ratingBand(4)).toBe('exceeds');
  });
});

describe('normalise weights', () => {
  it('returns fractions summing to one', () => {
    const n = normaliseWeights([{ weight: 3, score: 0 }, { weight: 1, score: 0 }]);
    expect(n.map((x) => x.weight)).toEqual([0.75, 0.25]);
    expect(normaliseWeights([])).toEqual([]);
  });
});
