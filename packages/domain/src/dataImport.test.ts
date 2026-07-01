import { describe, it, expect } from 'vitest';
import { mapAndValidate, type MappingSpec } from './dataImport.js';

const spec: MappingSpec = {
  fields: [
    { target: 'contractRef', source: 'Contract', type: 'string', required: true, pattern: '[A-Z]{2}-\\d+' },
    { target: 'premiumMinor', source: 'Premium', type: 'integerMinor', required: true, min: 0 },
    { target: 'currency', source: 'Ccy', type: 'currency', required: true, allowed: ['USD', 'EUR', 'GBP'] },
    { target: 'periodEnd', source: 'Period End', type: 'date', required: true },
    { target: 'status', source: 'Status', type: 'enum', allowed: ['BOUND', 'DRAFT'] },
  ],
};

describe('dataImport.mapAndValidate', () => {
  it('maps source columns to target fields and coerces types', () => {
    const r = mapAndValidate(
      [{ Contract: 'US-100', Premium: '1,234.50', Ccy: 'usd', 'Period End': '2026-12-31', Status: 'BOUND' }],
      spec,
    );
    expect(r.summary).toEqual({ total: 1, valid: 1, invalid: 0 });
    expect(r.rows[0]).toEqual({
      contractRef: 'US-100',
      premiumMinor: 123450, // 1,234.50 -> minor units, thousands separators stripped
      currency: 'USD',
      periodEnd: '2026-12-31',
      status: 'BOUND',
    });
  });

  it('collects every cell error and excludes the bad row', () => {
    const r = mapAndValidate(
      [{ Contract: 'bad', Premium: 'x', Ccy: 'US', 'Period End': '31/12/2026', Status: 'OPEN' }],
      spec,
    );
    expect(r.summary.valid).toBe(0);
    expect(r.summary.invalid).toBe(1);
    const fields = r.errors.map((e) => e.field).sort();
    expect(fields).toEqual(['contractRef', 'currency', 'periodEnd', 'premiumMinor', 'status']);
    expect(r.errors.every((e) => e.row === 1)).toBe(true);
  });

  it('reports missing required fields but allows blank optional fields', () => {
    const r = mapAndValidate([{ Contract: 'GB-1', Premium: '10', Ccy: 'GBP', 'Period End': '2026-01-01' }], spec);
    // status omitted (optional) => valid
    expect(r.summary.valid).toBe(1);
    expect(r.rows[0]).not.toHaveProperty('status');

    const missing = mapAndValidate([{ Premium: '10', Ccy: 'GBP', 'Period End': '2026-01-01' }], spec);
    expect(missing.errors).toContainEqual({ row: 1, field: 'contractRef', message: 'is required' });
  });

  it('enforces numeric bounds and currency allow-lists', () => {
    const r = mapAndValidate(
      [{ Contract: 'US-2', Premium: '-5', Ccy: 'JPY', 'Period End': '2026-06-30', Status: 'DRAFT' }],
      spec,
    );
    expect(r.errors).toContainEqual({ row: 1, field: 'premiumMinor', message: 'below minimum 0' });
    expect(r.errors).toContainEqual({ row: 1, field: 'currency', message: 'not an allowed currency' });
  });

  it('separates valid and invalid rows across a batch', () => {
    const r = mapAndValidate(
      [
        { Contract: 'US-1', Premium: '100', Ccy: 'USD', 'Period End': '2026-01-01', Status: 'BOUND' },
        { Contract: 'nope', Premium: '200', Ccy: 'USD', 'Period End': '2026-01-01', Status: 'BOUND' },
        { Contract: 'EU-9', Premium: '300', Ccy: 'EUR', 'Period End': '2026-01-01', Status: 'DRAFT' },
      ],
      spec,
    );
    expect(r.summary).toEqual({ total: 3, valid: 2, invalid: 1 });
    expect(r.rows.map((x) => x.contractRef)).toEqual(['US-1', 'EU-9']);
  });
});
