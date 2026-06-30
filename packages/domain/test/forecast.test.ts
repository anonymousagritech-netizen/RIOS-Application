import { describe, it, expect } from 'vitest';
import {
  movingAverage,
  linearRegression,
  linearTrendForecast,
  exponentialSmoothing,
  smoothedForecast,
} from '../src/forecast.js';

describe('moving average', () => {
  it('computes a trailing window mean', () => {
    expect(movingAverage([10, 20, 30, 40], 2)).toEqual([15, 25, 35]);
    expect(movingAverage([10, 20, 30, 40], 4)).toEqual([25]);
    expect(movingAverage([10], 2)).toEqual([]); // not enough points
  });
});

describe('linear regression & trend forecast', () => {
  it('fits a perfect line and reports R² = 1', () => {
    const fit = linearRegression([10, 20, 30, 40]);
    expect(fit.slope).toBeCloseTo(10, 10);
    expect(fit.intercept).toBeCloseTo(10, 10);
    expect(fit.r2).toBeCloseTo(1, 10);
  });

  it('projects the next periods from the trend', () => {
    expect(linearTrendForecast([10, 20, 30, 40], 2)).toEqual([
      { index: 4, value: 50 },
      { index: 5, value: 60 },
    ]);
  });

  it('handles a flat series (slope 0)', () => {
    const fit = linearRegression([5, 5, 5]);
    expect(fit.slope).toBe(0);
    expect(fit.intercept).toBe(5);
    expect(linearTrendForecast([5, 5, 5], 1)).toEqual([{ index: 3, value: 5 }]);
  });
});

describe('exponential smoothing', () => {
  it('smooths a series with factor alpha', () => {
    // s0=10; s1=.5*20+.5*10=15; s2=.5*30+.5*15=22.5
    expect(exponentialSmoothing([10, 20, 30], 0.5)).toEqual([10, 15, 22.5]);
  });

  it('forecasts one step ahead as the final smoothed level (rounded)', () => {
    expect(smoothedForecast([10, 20, 30], 0.5)).toBe(23); // round(22.5)
    expect(smoothedForecast([], 0.5)).toBe(0);
  });
});
