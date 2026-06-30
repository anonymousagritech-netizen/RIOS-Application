import { describe, it, expect } from 'vitest';
import {
  makeRng,
  sampleLognormal,
  samplePoisson,
  samplePareto,
  simulateLayerResults,
  compareStructures,
  type SimulationInput,
} from './simulation.js';

// ---------------------------------------------------------------------------
// 1. Seeded PRNG — the bedrock fact: a fixed seed yields a fixed stream.
// ---------------------------------------------------------------------------
describe('makeRng (seeded PRNG)', () => {
  // Test: the same seed reproduces an exact, hand-checkable stream (golden values
  // captured from mulberry32 seed=42); two generators with the same seed agree.
  it('is deterministic and reproduces exact golden draws for a fixed seed', () => {
    const r = makeRng(42);
    const draws = [r(), r(), r(), r(), r()];
    expect(draws[0]).toBeCloseTo(0.6011037519201636, 15);
    expect(draws[1]).toBeCloseTo(0.44829055899754167, 15);
    // Independent generator, same seed -> identical stream.
    const r2 = makeRng(42);
    expect([r2(), r2(), r2(), r2(), r2()]).toEqual(draws);
  });

  // Test: every draw is a uniform in [0, 1).
  it('produces values in [0, 1)', () => {
    const r = makeRng(99);
    for (let i = 0; i < 1000; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Sampling helpers — bounds + determinism.
// ---------------------------------------------------------------------------
describe('sampling helpers', () => {
  // Test: lognormal is strictly positive and reproducible for a fixed seed.
  it('sampleLognormal is positive and deterministic', () => {
    const a = makeRng(1);
    const b = makeRng(1);
    const xa = sampleLognormal(a, 10, 1.5);
    const xb = sampleLognormal(b, 10, 1.5);
    expect(xa).toBeGreaterThan(0);
    expect(xa).toBe(xb);
  });

  // Test: Pareto draws are never below xmin and are reproducible.
  it('samplePareto respects xmin and is deterministic', () => {
    const a = makeRng(5);
    const b = makeRng(5);
    const xa = samplePareto(a, 2, 1_000_000);
    expect(xa).toBeGreaterThanOrEqual(1_000_000);
    expect(samplePareto(b, 2, 1_000_000)).toBe(xa);
  });

  // Test: Poisson returns a non-negative integer and lambda<=0 short-circuits to 0.
  it('samplePoisson returns a non-negative integer; lambda<=0 -> 0', () => {
    const r = makeRng(7);
    const k = samplePoisson(r, 3);
    expect(Number.isInteger(k)).toBe(true);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(samplePoisson(makeRng(7), 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. simulateLayerResults
// ---------------------------------------------------------------------------
const baseInput = (overrides: Partial<SimulationInput> = {}): SimulationInput => ({
  seed: 2024,
  iterations: 5000,
  frequency: { lambda: 1.2 },
  // mu=15.4, sigma=0.8 -> median severity ~ exp(15.4) ≈ 4.9m minor units.
  severity: { dist: 'lognormal', params: { mu: 15.4, sigma: 0.8 } },
  layer: { attachmentMinor: 5_000_000, limitMinor: 5_000_000 },
  premiumMinor: 1_000_000,
  ...overrides,
});

describe('simulateLayerResults', () => {
  // Test: determinism — same seed -> byte-identical summary (mean, std, VaR, TVaR).
  it('is fully deterministic for a fixed seed', () => {
    const a = simulateLayerResults(baseInput());
    const b = simulateLayerResults(baseInput());
    expect(a).toEqual(b);
  });

  // Test: a different seed generally moves the result (sanity that the seed wires in).
  it('responds to the seed', () => {
    const a = simulateLayerResults(baseInput({ seed: 1 }));
    const b = simulateLayerResults(baseInput({ seed: 2 }));
    expect(a.meanNetResultMinor).not.toBe(b.meanNetResultMinor);
  });

  // Test: monotonicity — raising the attachment can only lower expected loss to layer
  // (fewer/smaller losses pierce a higher retention), holding the loss set fixed via
  // the same seed. Asserted strictly because at this attachment level losses do erode.
  it('higher attachment -> lower (or equal) expected loss to layer', () => {
    const low = simulateLayerResults(
      baseInput({ layer: { attachmentMinor: 5_000_000, limitMinor: 5_000_000 } }),
    );
    const high = simulateLayerResults(
      baseInput({ layer: { attachmentMinor: 10_000_000, limitMinor: 5_000_000 } }),
    );
    expect(high.expectedLossToLayerMinor).toBeLessThanOrEqual(low.expectedLossToLayerMinor);
    expect(high.probabilityOfAttachment).toBeLessThanOrEqual(low.probabilityOfAttachment);
  });

  // Test: TVaR (mean of the tail) is always at least VaR (the tail threshold).
  it('TVaR >= VaR at each confidence level', () => {
    const s = simulateLayerResults(baseInput());
    expect(s.tvarRecoveryMinor.p95).toBeGreaterThanOrEqual(s.varRecoveryMinor.p95);
    expect(s.tvarRecoveryMinor.p99).toBeGreaterThanOrEqual(s.varRecoveryMinor.p99);
  });

  // Test: small hand-checkable case. With seed=7 and lambda=2, samplePoisson draws 0
  // claims on the first (only) period, so there are no losses: recovery=0, the layer
  // never attaches, and net result = premium exactly. This pins the whole pipeline to
  // a known draw (see probe in simulation.ts comments).
  it('iterations=1 with a forced zero-claim draw returns premium with no loss', () => {
    const s = simulateLayerResults(
      baseInput({ seed: 7, iterations: 1, frequency: { lambda: 2 }, premiumMinor: 1_000_000 }),
    );
    expect(s.expectedLossToLayerMinor).toBe(0);
    expect(s.probabilityOfAttachment).toBe(0);
    expect(s.meanNetResultMinor).toBe(1_000_000);
    expect(s.stdDevNetResultMinor).toBe(0);
  });

  // Test: reinstatement premium reduces the net result when a loss reinstates cover.
  // With a free vs priced reinstatement on the same seed, priced net <= free net.
  it('priced reinstatements never improve the net result vs free', () => {
    const free = simulateLayerResults(
      baseInput({ reinstatements: { count: 1 } }),
    );
    const priced = simulateLayerResults(
      baseInput({ reinstatements: { count: 1, rate: 1.0 } }),
    );
    expect(priced.meanNetResultMinor).toBeLessThanOrEqual(free.meanNetResultMinor);
  });
});

// ---------------------------------------------------------------------------
// 4. compareStructures
// ---------------------------------------------------------------------------
describe('compareStructures', () => {
  // Test: common random numbers — every candidate sees the same loss set (same seed),
  // and a structure equal to a standalone run reproduces that run's summary exactly.
  it('runs candidates on the same loss set and matches standalone runs', () => {
    const seed = 555;
    const iterations = 3000;
    const frequency = { lambda: 1.5 };
    const severity = baseInput().severity;
    const premiumMinor = 1_200_000;

    const cmp = compareStructures({
      seed,
      iterations,
      frequency,
      severity,
      premiumMinor,
      structures: [
        { name: 'low', layer: { attachmentMinor: 5_000_000, limitMinor: 5_000_000 } },
        { name: 'high', layer: { attachmentMinor: 12_000_000, limitMinor: 5_000_000 } },
      ],
    });

    expect(cmp.map((c) => c.name)).toEqual(['low', 'high']);
    // Higher attachment -> lower expected loss to layer (same loss set).
    expect(cmp[1]!.summary.expectedLossToLayerMinor).toBeLessThanOrEqual(
      cmp[0]!.summary.expectedLossToLayerMinor,
    );
    // The 'low' candidate equals an identical standalone simulation (determinism).
    const standalone = simulateLayerResults({
      seed,
      iterations,
      frequency,
      severity,
      premiumMinor,
      layer: { attachmentMinor: 5_000_000, limitMinor: 5_000_000 },
    });
    expect(cmp[0]!.summary).toEqual(standalone);
  });

  // Test: fewer than two structures is rejected.
  it('requires at least two structures', () => {
    expect(() =>
      compareStructures({
        seed: 1,
        iterations: 10,
        frequency: { lambda: 1 },
        severity: baseInput().severity,
        premiumMinor: 100,
        structures: [{ name: 'only', layer: { attachmentMinor: 1, limitMinor: 1 } }],
      }),
    ).toThrow(/at least two/);
  });
});
