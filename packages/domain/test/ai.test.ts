import { describe, it, expect } from 'vitest';
import { extractFields, extractionConfidence, BORDEREAUX_FIELDS } from '../src/ocr.js';
import { lossRatio, renewalLikelihood, insightBand } from '../src/prediction.js';

describe('OCR field extraction', () => {
  const sample = `COVER NOTE
Policy No: AB-12345
Insured: Atlantic Mutual
Premium: USD $1,250,000.00
Sum Insured: 50,000,000
Inception date: 2026-01-01`;

  it('extracts labelled fields from text', () => {
    const f = extractFields(sample, BORDEREAUX_FIELDS);
    expect(f.policyNumber).toBe('AB-12345');
    expect(f.premium).toBe('1,250,000.00');
    expect(f.sumInsured).toBe('50,000,000');
    expect(f.inception).toBe('2026-01-01');
  });

  it('reports confidence as the fraction of fields matched', () => {
    expect(extractionConfidence({ a: 'x', b: null, c: 'y', d: null })).toBe(0.5);
    expect(extractionConfidence({})).toBe(0);
  });
});

describe('prediction & insights', () => {
  it('computes loss ratio', () => {
    expect(lossRatio(600, 1000)).toBe(0.6);
    expect(lossRatio(100, 0)).toBe(0);
  });

  it('scores renewal likelihood transparently', () => {
    // 0.6 + 0.05*3 - 0.4*0.5 - 0 = 0.55
    expect(renewalLikelihood({ lossRatio: 0.5, yearsOnBook: 3, openClaims: 0 })).toBe(0.55);
    // 0.6 + 0.05 - 0.4 - 0.1 = 0.15
    expect(renewalLikelihood({ lossRatio: 1.0, yearsOnBook: 1, openClaims: 2 })).toBe(0.15);
  });

  it('bands the score', () => {
    expect(insightBand(0.15)).toBe('unlikely');
    expect(insightBand(0.55)).toBe('at-risk');
    expect(insightBand(0.8)).toBe('likely');
  });
});
