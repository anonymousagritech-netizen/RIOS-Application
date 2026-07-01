import { describe, it, expect } from 'vitest';
import { severityLowerBetter, severityHigherBetter, severityFromCount, rankInsights, insightSummary, type Insight } from './insight.js';

describe('insight classification', () => {
  it('severityLowerBetter maps against thresholds', () => {
    expect(severityLowerBetter(60, 70, 100)).toBe('POSITIVE');
    expect(severityLowerBetter(85, 70, 100)).toBe('WATCH');
    expect(severityLowerBetter(120, 70, 100)).toBe('RISK');
  });

  it('severityHigherBetter maps against thresholds', () => {
    expect(severityHigherBetter(98, 95, 80)).toBe('POSITIVE');
    expect(severityHigherBetter(85, 95, 80)).toBe('WATCH');
    expect(severityHigherBetter(50, 95, 80)).toBe('RISK');
  });

  it('severityFromCount escalates with count', () => {
    expect(severityFromCount(0)).toBe('POSITIVE');
    expect(severityFromCount(2)).toBe('WATCH');
    expect(severityFromCount(9)).toBe('RISK');
  });

  it('rankInsights puts RISK first, stable within severity', () => {
    const items: Insight[] = [
      { domain: 'x', severity: 'POSITIVE', title: 'a', detail: '' },
      { domain: 'x', severity: 'RISK', title: 'b', detail: '' },
      { domain: 'x', severity: 'WATCH', title: 'c', detail: '' },
      { domain: 'x', severity: 'RISK', title: 'd', detail: '' },
    ];
    expect(rankInsights(items).map((i) => i.title)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('insightSummary counts by severity', () => {
    const s = insightSummary([
      { domain: 'x', severity: 'RISK', title: '', detail: '' },
      { domain: 'x', severity: 'RISK', title: '', detail: '' },
      { domain: 'x', severity: 'POSITIVE', title: '', detail: '' },
    ]);
    expect(s.RISK).toBe(2);
    expect(s.POSITIVE).toBe(1);
  });
});
