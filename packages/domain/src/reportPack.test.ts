import { describe, it, expect } from 'vitest';
import { assembleReportPack, type ReportPackTemplate } from './reportPack.js';

// A small ceded-reinsurance style pack: recoverables by counterparty status,
// a computed total, a provision, and net recoverable, with a control tie.
const template: ReportPackTemplate = {
  code: 'CEDED-RI',
  title: 'Ceded Reinsurance Summary',
  totalLineCode: 'TOTAL_RECOVERABLE',
  controls: [{ code: 'TOTAL_RECOVERABLE', equals: 'TOTAL_CHECK' }],
  sections: [
    {
      code: 'RECOVERABLES',
      title: 'Recoverables by status',
      lines: [
        { code: 'AUTH', label: 'Authorized', kind: 'input', required: true },
        { code: 'UNAUTH', label: 'Unauthorized', kind: 'input', required: true },
        { code: 'TOTAL_RECOVERABLE', label: 'Total recoverable', kind: 'sum', of: ['AUTH', 'UNAUTH'] },
        { code: 'TOTAL_CHECK', label: 'Total (control)', kind: 'input', required: true },
      ],
    },
    {
      code: 'PROVISION',
      title: 'Provision & net',
      lines: [
        { code: 'PROVISION', label: 'Provision for reinsurance', kind: 'input', required: true },
        { code: 'NET_RECOVERABLE', label: 'Net recoverable', kind: 'diff', of: ['TOTAL_RECOVERABLE', 'PROVISION'] },
      ],
    },
  ],
};

describe('reportPack.assembleReportPack', () => {
  it('resolves computed lines and surfaces the grand total', () => {
    const r = assembleReportPack(template, {
      AUTH: 800_000_00, UNAUTH: 200_000_00, TOTAL_CHECK: 1_000_000_00, PROVISION: 40_000_00,
    });
    expect(r.complete).toBe(true);
    expect(r.errors).toHaveLength(0);
    expect(r.values.TOTAL_RECOVERABLE).toBe(1_000_000_00);
    expect(r.values.NET_RECOVERABLE).toBe(1_000_000_00 - 40_000_00);
    expect(r.totalMinor).toBe(1_000_000_00);
  });

  it('flags a failed control tie-out', () => {
    const r = assembleReportPack(template, {
      AUTH: 800_000_00, UNAUTH: 200_000_00, TOTAL_CHECK: 999_999_00, PROVISION: 0,
    });
    expect(r.complete).toBe(false);
    expect(r.errors.some((e) => e.startsWith('Control failed'))).toBe(true);
  });

  it('reports missing required inputs and leaves dependent lines null', () => {
    const r = assembleReportPack(template, { AUTH: 800_000_00, TOTAL_CHECK: 800_000_00, PROVISION: 0 });
    expect(r.complete).toBe(false);
    expect(r.errors.some((e) => e.includes('UNAUTH'))).toBe(true);
    // TOTAL_RECOVERABLE depends on UNAUTH => unresolved => null
    const total = r.sections[0]!.lines.find((l) => l.code === 'TOTAL_RECOVERABLE');
    expect(total!.valueMinor).toBeNull();
  });

  it('resolves chained computed lines regardless of declaration order', () => {
    const chained: ReportPackTemplate = {
      code: 'CHAIN', title: 'Chain',
      totalLineCode: 'GRAND',
      sections: [{
        code: 'S', title: 'S', lines: [
          { code: 'GRAND', label: 'Grand', kind: 'sum', of: ['SUB1', 'SUB2'] }, // declared before its children
          { code: 'SUB1', label: 'Sub 1', kind: 'sum', of: ['A', 'B'] },
          { code: 'SUB2', label: 'Sub 2', kind: 'input', required: true },
          { code: 'A', label: 'A', kind: 'input', required: true },
          { code: 'B', label: 'B', kind: 'input', required: true },
        ],
      }],
    };
    const r = assembleReportPack(chained, { A: 100, B: 200, SUB2: 50 });
    expect(r.values.SUB1).toBe(300);
    expect(r.totalMinor).toBe(350);
    expect(r.complete).toBe(true);
  });
});
