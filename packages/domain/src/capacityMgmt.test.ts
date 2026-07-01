import { describe, it, expect } from 'vitest';
import { capacityUtilisation, capacityBook, capacityAlerts, capacityForecast } from './capacityMgmt.js';

const M = (major: number) => major * 100;
const line = (dimKey: string, avail: number, consumed: number, warnPct = 80) =>
  ({ dimension: 'PERIL', dimKey, availableMinor: M(avail), consumedMinor: M(consumed), warnPct });

describe('capacity management', () => {
  it('computes utilisation and RAG status', () => {
    expect(capacityUtilisation(line('A', 100, 50)).status).toBe('OK');
    expect(capacityUtilisation(line('B', 100, 70)).status).toBe('WATCH');
    expect(capacityUtilisation(line('C', 100, 85)).status).toBe('WARN');
    expect(capacityUtilisation(line('D', 100, 100)).status).toBe('BREACH');
    const r = capacityUtilisation(line('E', 100, 40));
    expect(r.remainingMinor).toBe(M(60));
    expect(r.utilisationPct).toBe(40);
  });

  it('rolls a book and counts breaches/warnings hottest first', () => {
    const book = capacityBook([line('A', 100, 50), line('B', 100, 100), line('C', 100, 90)]);
    expect(book.availableMinor).toBe(M(300));
    expect(book.consumedMinor).toBe(M(240));
    expect(book.remainingMinor).toBe(M(60));
    expect(book.breaches).toBe(1);
    expect(book.warnings).toBe(1);
    expect(book.lines[0]!.dimKey).toBe('B'); // hottest first
  });

  it('raises alerts, breaches first', () => {
    const alerts = capacityAlerts([line('A', 100, 50), line('B', 100, 100), line('C', 100, 90)]);
    expect(alerts.length).toBe(2);
    expect(alerts[0]!.severity).toBe('high');
    expect(alerts[0]!.dimKey).toBe('B');
  });

  it('forecasts year-end consumption', () => {
    const f = capacityForecast(M(50), M(100), 0.5);
    expect(f.projectedConsumedMinor).toBe(M(100));
    expect(f.projectedUtilisationPct).toBe(100);
    expect(f.willBreach).toBe(true);
    const g = capacityForecast(M(30), M(100), 0.5);
    expect(g.willBreach).toBe(false);
  });
});
