import { describe, it, expect } from 'vitest';
import {
  buildEbot, buildEcot, validateAcordMessage, serializeAcord, isEbot, isEcot,
  type AcordParty,
} from '../src/index.js';

const parties: AcordParty[] = [
  { role: 'REINSURER', name: 'RIOS Re', reference: 'RIOS' },
  { role: 'CEDENT', name: 'Atlas Insurance', reference: 'ATL' },
  { role: 'BROKER', name: 'Marsh', reference: 'MAR' },
];

describe('ACORD EBOT', () => {
  it('builds a balancing net settlement by default', () => {
    const msg = buildEbot({
      uti: 'UTI-1', umr: 'B1234ABC', senderReference: 'RIOS-STMT-1', currency: 'USD',
      parties, accountingDate: '2026-01-31', settlementDueDate: '2026-03-01',
      premiumMinor: 1_000_000, brokerageMinor: 100_000, taxesMinor: 25_000,
    });
    expect(msg.settlementAmount.amountMinor).toBe(875_000); // 1,000,000 - 100,000 - 25,000
    expect(validateAcordMessage(msg).valid).toBe(true);
    expect(isEbot(msg)).toBe(true);
  });

  it('rejects a settlement that does not reconcile', () => {
    const msg = buildEbot({
      uti: 'UTI-2', senderReference: 'S2', currency: 'USD', parties,
      accountingDate: '2026-01-31', settlementDueDate: '2026-03-01',
      premiumMinor: 1_000_000, brokerageMinor: 100_000, taxesMinor: 25_000,
      settlementAmountMinor: 999_999,
    });
    const r = validateAcordMessage(msg);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('reconcile'))).toBe(true);
  });

  it('rejects mandatory-field and currency violations', () => {
    const msg = buildEbot({
      uti: '', senderReference: 'S3', currency: 'US', parties: [],
      accountingDate: 'bad', settlementDueDate: '2026-03-01', premiumMinor: -5,
    });
    const r = validateAcordMessage(msg);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('uti'))).toBe(true);
    expect(r.errors.some((e) => e.includes('currency'))).toBe(true);
    expect(r.errors.some((e) => e.includes('parties'))).toBe(true);
    expect(r.errors.some((e) => e.includes('accountingDate'))).toBe(true);
    expect(r.errors.some((e) => e.includes('non-negative'))).toBe(true);
  });
});

describe('ACORD ECOT', () => {
  it('builds a claim movement defaulting settlement to the paid amount', () => {
    const msg = buildEcot({
      uti: 'UTI-C1', senderReference: 'RIOS-CLM-1', currency: 'EUR', parties,
      lossReference: 'UCR-9', catCode: 'CAT-2026-EU-STORM', lossDate: '2026-01-15',
      paidMinor: 500_000, outstandingMinor: 250_000,
    });
    expect(msg.settlementAmount.amountMinor).toBe(500_000);
    expect(isEcot(msg)).toBe(true);
    expect(validateAcordMessage(msg).valid).toBe(true);
  });

  it('requires a loss reference', () => {
    const msg = buildEcot({
      uti: 'UTI-C2', senderReference: 'S', currency: 'EUR', parties,
      lossReference: '  ', paidMinor: 100, outstandingMinor: 0,
    });
    const r = validateAcordMessage(msg);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('lossReference'))).toBe(true);
  });
});

describe('canonical serialization', () => {
  it('is deterministic and independent of key insertion order', () => {
    const a = buildEbot({
      uti: 'UTI-D', senderReference: 'S', currency: 'GBP', parties,
      accountingDate: '2026-02-28', settlementDueDate: '2026-04-01', premiumMinor: 200,
    });
    const b = buildEbot({
      // same values, different call ordering of optional fields
      taxesMinor: 0, brokerageMinor: 0, premiumMinor: 200, currency: 'GBP',
      settlementDueDate: '2026-04-01', accountingDate: '2026-02-28',
      parties, senderReference: 'S', uti: 'UTI-D',
    });
    expect(serializeAcord(a)).toBe(serializeAcord(b));
    // undefined optionals (umr) must not appear in the canonical form
    expect(serializeAcord(a).includes('umr')).toBe(false);
  });
});
