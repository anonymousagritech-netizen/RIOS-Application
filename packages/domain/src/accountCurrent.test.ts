/**
 * Account-current / dunning / pain.001 unit tests (industry-gap-analysis
 * Tier-2 item 9). Proves: exact minor→major rendering for 2- and 0-exponent
 * currencies, XML escaping, control sum = exact decimal sum, structural
 * pain.001 correctness, validation, and the dunning ladder boundaries.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPain001,
  pain001ControlSum,
  formatMinorAsMajor,
  minorToMajorString,
  xmlEscape,
  dunningLevel,
  daysOverdue,
  DEFAULT_DUNNING_LEVELS,
  type Pain001Input,
  type Pain001Item,
} from './accountCurrent.js';

const baseInput = (items: Pain001Item[]): Pain001Input => ({
  messageId: 'RIOS-PAY-2026-00001',
  debtorName: 'Demo Reinsurance AG',
  debtorIban: 'CH9300762011623852957',
  debtorBic: 'DEMOCHZZ',
  executionDate: '2026-07-15',
  items,
});

describe('formatMinorAsMajor / minorToMajorString', () => {
  it('renders 2-exponent currencies exactly', () => {
    expect(formatMinorAsMajor(123456, 2)).toBe('1234.56');
    expect(formatMinorAsMajor(5, 2)).toBe('0.05');
    expect(formatMinorAsMajor(100, 2)).toBe('1.00');
    expect(formatMinorAsMajor(-123456, 2)).toBe('-1234.56');
    expect(minorToMajorString(999999999999, 'USD')).toBe('9999999999.99');
  });

  it('renders 0-exponent currencies (JPY) with no decimal point', () => {
    expect(minorToMajorString(5000000, 'JPY')).toBe('5000000');
    expect(formatMinorAsMajor(0, 0)).toBe('0');
  });

  it('renders 3-exponent currencies (BHD)', () => {
    expect(minorToMajorString(1001, 'BHD')).toBe('1.001');
  });

  it('rejects non-integer minor amounts', () => {
    expect(() => formatMinorAsMajor(1.5, 2)).toThrow(RangeError);
    expect(() => formatMinorAsMajor(1, -1)).toThrow(RangeError);
  });
});

describe('xmlEscape', () => {
  it('escapes all five XML special characters', () => {
    expect(xmlEscape(`Böse & <Cie> "d'Assurance"`)).toBe(
      'Böse &amp; &lt;Cie&gt; &quot;d&apos;Assurance&quot;',
    );
  });
});

describe('pain001ControlSum', () => {
  it('is the exact decimal sum of major amounts (2-exponent)', () => {
    const items: Pain001Item[] = [
      { endToEndId: 'A', amountMinor: 10, currency: 'USD', creditorName: 'x', creditorIban: 'y' }, // 0.10
      { endToEndId: 'B', amountMinor: 20, currency: 'USD', creditorName: 'x', creditorIban: 'y' }, // 0.20
    ];
    // 0.1 + 0.2 must be exactly 0.30, not 0.30000000000000004.
    expect(pain001ControlSum(items)).toBe('0.30');
  });

  it('mixes exponents exactly (USD cents + JPY whole)', () => {
    const items: Pain001Item[] = [
      { endToEndId: 'A', amountMinor: 123456, currency: 'USD', creditorName: 'x', creditorIban: 'y' }, // 1234.56
      { endToEndId: 'B', amountMinor: 5000, currency: 'JPY', creditorName: 'x', creditorIban: 'y' }, // 5000
    ];
    expect(pain001ControlSum(items)).toBe('6234.56');
  });
});

describe('buildPain001', () => {
  const items: Pain001Item[] = [
    {
      endToEndId: 'E2E-002',
      amountMinor: 250075, // 2500.75 USD
      currency: 'USD',
      creditorName: 'Broker & Söhne <GmbH>',
      creditorIban: 'DE89370400440532013000',
      creditorBic: 'COBADEFF',
      remittanceInfo: 'Q2 statement "demo"',
    },
    {
      endToEndId: 'E2E-001',
      amountMinor: 5000000, // ¥5,000,000
      currency: 'JPY',
      creditorName: 'Tokyo Re',
      creditorIban: 'GB29NWBK60161331926819',
    },
  ];

  it('builds a well-formed document with escaped text, control sum and tx count', () => {
    const xml = buildPain001(baseInput(items));
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('urn:iso:std:iso:20022:tech:xsd:pain.001.001.03');
    expect(xml).toContain('<MsgId>RIOS-PAY-2026-00001</MsgId>');
    expect(xml).toContain('<NbOfTxs>2</NbOfTxs>');
    // Exact decimal control sum: 2500.75 + 5000000 = 5002500.75
    expect(xml).toContain('<CtrlSum>5002500.75</CtrlSum>');
    // Escaping: raw specials never appear in content.
    expect(xml).toContain('Broker &amp; Söhne &lt;GmbH&gt;');
    expect(xml).toContain('Q2 statement &quot;demo&quot;');
    expect(xml).not.toContain('Söhne <GmbH>');
    // Amounts: minor→major with the right exponent per currency.
    expect(xml).toContain('<InstdAmt Ccy="USD">2500.75</InstdAmt>');
    expect(xml).toContain('<InstdAmt Ccy="JPY">5000000</InstdAmt>');
    expect(xml).toContain('<IBAN>DE89370400440532013000</IBAN>');
    expect(xml).toContain('<ReqdExctnDt>2026-07-15</ReqdExctnDt>');
    expect(xml).toContain('<BIC>DEMOCHZZ</BIC>');
    // Agent without a BIC falls back to NOTPROVIDED.
    expect(xml).toContain('<Othr><Id>NOTPROVIDED</Id></Othr>');
  });

  it('is deterministic: instruction order is by endToEndId regardless of input order', () => {
    const a = buildPain001(baseInput(items));
    const b = buildPain001(baseInput([...items].reverse()));
    expect(a).toBe(b);
    expect(a.indexOf('E2E-001')).toBeLessThan(a.indexOf('E2E-002'));
  });

  it('validates input', () => {
    expect(() => buildPain001(baseInput([]))).toThrow(/at least one/);
    expect(() =>
      buildPain001(baseInput([{ ...items[0]!, amountMinor: 0 }])),
    ).toThrow(/positive integer/);
    expect(() =>
      buildPain001(baseInput([{ ...items[0]!, amountMinor: -5 }])),
    ).toThrow(/positive integer/);
    expect(() =>
      buildPain001(baseInput([{ ...items[0]!, amountMinor: 10.5 }])),
    ).toThrow(/positive integer/);
    expect(() => buildPain001({ ...baseInput(items), executionDate: '15/07/2026' })).toThrow(/YYYY-MM-DD/);
    expect(() => buildPain001({ ...baseInput(items), messageId: ' ' })).toThrow(/messageId/);
  });

  it('allows per-instruction currencies (no same-currency requirement)', () => {
    expect(() => buildPain001(baseInput(items))).not.toThrow();
  });
});

describe('dunningLevel', () => {
  it('returns 0 before and on the due date', () => {
    expect(dunningLevel({ dueDate: '2026-07-01', asOf: '2026-06-15' })).toBe(0);
    expect(dunningLevel({ dueDate: '2026-07-01', asOf: '2026-07-01' })).toBe(0);
  });

  it('escalates at the default boundaries (1 / 30 / 60 days, inclusive)', () => {
    expect(dunningLevel({ dueDate: '2026-06-01', asOf: '2026-06-02' })).toBe(1); // 1 day
    expect(dunningLevel({ dueDate: '2026-06-01', asOf: '2026-06-30' })).toBe(1); // 29 days
    expect(dunningLevel({ dueDate: '2026-06-01', asOf: '2026-07-01' })).toBe(2); // exactly 30
    expect(dunningLevel({ dueDate: '2026-06-01', asOf: '2026-07-30' })).toBe(2); // 59 days
    expect(dunningLevel({ dueDate: '2026-06-01', asOf: '2026-07-31' })).toBe(3); // exactly 60
    expect(dunningLevel({ dueDate: '2024-01-01', asOf: '2026-07-01' })).toBe(3); // way past
  });

  it('honours a custom ladder and unsorted rungs', () => {
    const levels = [
      { level: 2, afterDaysOverdue: 15 },
      { level: 1, afterDaysOverdue: 5 },
    ];
    expect(dunningLevel({ dueDate: '2026-06-01', asOf: '2026-06-05', levels })).toBe(0); // 4 days
    expect(dunningLevel({ dueDate: '2026-06-01', asOf: '2026-06-06', levels })).toBe(1); // 5 days
    expect(dunningLevel({ dueDate: '2026-06-01', asOf: '2026-06-16', levels })).toBe(2); // 15 days
  });

  it('daysOverdue is signed and the default ladder is exported', () => {
    expect(daysOverdue('2026-07-01', '2026-06-29')).toBe(-2);
    expect(daysOverdue('2026-07-01', '2026-07-04')).toBe(3);
    expect(DEFAULT_DUNNING_LEVELS.length).toBe(3);
  });
});
