/**
 * Forecast services (brief §13 — pivot/cube & forecast). Pure time-series
 * helpers used to project a metric forward: trailing moving average, ordinary
 * least-squares linear trend (+ projection), and simple exponential smoothing.
 * Deterministic and unit-tested. Inputs are plain numbers (callers pass minor
 * units for money); outputs are rounded only where noted.
 */

/** Trailing simple moving average; returns an array of length n − window + 1. */
export function movingAverage(series: number[], window: number): number[] {
  const s = series ?? [];
  if (window <= 0 || s.length < window) return [];
  const out: number[] = [];
  for (let i = 0; i + window <= s.length; i++) {
    let sum = 0;
    for (let j = i; j < i + window; j++) sum += s[j]!;
    out.push(sum / window);
  }
  return out;
}

export interface LinearFit {
  slope: number;
  intercept: number;
  /** Coefficient of determination R² in [0, 1] (1 = perfect fit). */
  r2: number;
}

/** Ordinary least-squares fit of y against its index x = 0..n−1. */
export function linearRegression(series: number[]): LinearFit {
  const y = series ?? [];
  const n = y.length;
  if (n === 0) return { slope: 0, intercept: 0, r2: 0 };
  if (n === 1) return { slope: 0, intercept: y[0]!, r2: 1 };
  const xMean = (n - 1) / 2;
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    const dy = y[i]! - yMean;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = yMean - slope * xMean;
  const r2 = syy === 0 ? 1 : Math.max(0, Math.min(1, (sxy * sxy) / (sxx * syy)));
  return { slope, intercept, r2 };
}

export interface ForecastPoint {
  index: number;
  value: number;
}

/**
 * Project the next `periods` values from the linear trend of `series`.
 * Values are rounded to whole units (callers work in minor units).
 */
export function linearTrendForecast(series: number[], periods: number): ForecastPoint[] {
  const { slope, intercept } = linearRegression(series);
  const n = (series ?? []).length;
  const out: ForecastPoint[] = [];
  for (let k = 0; k < periods; k++) {
    const index = n + k;
    out.push({ index, value: Math.round(intercept + slope * index) });
  }
  return out;
}

/**
 * Simple exponential smoothing with factor α ∈ (0, 1]. Returns the smoothed
 * level at each point; the last value is the one-step-ahead forecast.
 */
export function exponentialSmoothing(series: number[], alpha: number): number[] {
  const s = series ?? [];
  if (s.length === 0) return [];
  const a = Math.min(Math.max(alpha, 0), 1);
  const out: number[] = [s[0]!];
  for (let i = 1; i < s.length; i++) {
    out.push(a * s[i]! + (1 - a) * out[i - 1]!);
  }
  return out;
}

/** One-step-ahead exponential-smoothing forecast (the final smoothed level). */
export function smoothedForecast(series: number[], alpha: number): number {
  const smoothed = exponentialSmoothing(series, alpha);
  return smoothed.length ? Math.round(smoothed[smoothed.length - 1]!) : 0;
}
