/**
 * Account-current, dunning and ISO 20022 payment-file generation
 * (industry-gap-analysis Tier-2 item 9).
 *
 * Pure functions only: `buildPain001` renders a pain.001.001.03 customer credit
 * transfer initiation as a deterministic XML string from typed input (no clock,
 * no I/O - the caller supplies every date), and `dunningLevel` is the pure
 * dunning ladder mapping days-overdue to a configurable escalation level.
 * Money stays integer minor units throughout; major-unit decimals appear only
 * in the rendered XML text, produced by exact string arithmetic (never floats).
 */

import { minorUnitsFor } from './money.js';
import { epochDay } from './aging.js';

// ---------------------------------------------------------------------------
// Minor→major decimal rendering (exact, string-based - no float division)
// ---------------------------------------------------------------------------

/**
 * Render an integer minor-unit amount as a major-unit decimal string with
 * exactly `exponent` fraction digits (e.g. 123456 @ 2 → "1234.56";
 * 5000 @ 0 → "5000"). Pure string arithmetic: no floating point.
 */
export function formatMinorAsMajor(amountMinor: number, exponent: number): string {
  if (!Number.isInteger(amountMinor)) {
    throw new RangeError(`amountMinor must be an integer count of minor units, got ${amountMinor}`);
  }
  if (!Number.isInteger(exponent) || exponent < 0) {
    throw new RangeError(`exponent must be a non-negative integer, got ${exponent}`);
  }
  const neg = amountMinor < 0;
  const digits = Math.abs(amountMinor).toString();
  if (exponent === 0) return (neg ? '-' : '') + digits;
  const padded = digits.padStart(exponent + 1, '0');
  return (neg ? '-' : '') + padded.slice(0, -exponent) + '.' + padded.slice(-exponent);
}

/** Major-unit decimal string for a minor amount in `currency` (ISO exponent). */
export function minorToMajorString(amountMinor: number, currency: string): string {
  return formatMinorAsMajor(amountMinor, minorUnitsFor(currency));
}

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

/** Escape a text value for use in XML element content or attribute values. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// pain.001.001.03 - customer credit transfer initiation
// ---------------------------------------------------------------------------

export interface Pain001Item {
  /** End-to-end identification carried through the payment chain. */
  endToEndId: string;
  /** Instructed amount in integer minor units of `currency`. Must be > 0. */
  amountMinor: number;
  /** ISO-4217 currency of this instruction (pain.001 allows per-instruction currency). */
  currency: string;
  creditorName: string;
  creditorIban: string;
  creditorBic?: string;
  /** Unstructured remittance information. */
  remittanceInfo?: string;
}

export interface Pain001Input {
  /** Group-header message id (max 35 chars per schema; enforced loosely here). */
  messageId: string;
  /**
   * Creation timestamp (ISO 8601). Supplied by the caller so the domain core
   * stays clock-free; defaults to midnight of the execution date.
   */
  creationDateTime?: string;
  debtorName: string;
  debtorIban: string;
  debtorBic?: string;
  /** Requested execution date, YYYY-MM-DD. */
  executionDate: string;
  items: Pain001Item[];
}

/**
 * Control sum for a set of instructions: the exact arithmetic sum of the
 * major-unit instructed amounts (per the ISO definition, currencies are NOT
 * converted - it is a plain decimal checksum). Computed on scaled integers at
 * the highest exponent present, so it is exact.
 */
export function pain001ControlSum(items: Pain001Item[]): string {
  const maxExp = items.reduce((m, it) => Math.max(m, minorUnitsFor(it.currency)), 0);
  let total = 0;
  for (const it of items) {
    total += it.amountMinor * Math.pow(10, maxExp - minorUnitsFor(it.currency));
  }
  return formatMinorAsMajor(total, maxExp);
}

function financialInstitution(bic: string | undefined, indent: string, tag: string): string {
  // Without a BIC the schema still requires an agent; NOTPROVIDED is the
  // conventional Othr/Id used by banks for IBAN-only (e.g. SEPA) files.
  const inner = bic
    ? `${indent}  <FinInstnId><BIC>${xmlEscape(bic)}</BIC></FinInstnId>`
    : `${indent}  <FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId>`;
  return `${indent}<${tag}>\n${inner}\n${indent}</${tag}>`;
}

/**
 * Build an ISO 20022 pain.001.001.03 customer credit transfer initiation XML
 * document. Deterministic: same input, same string; instructions are emitted
 * sorted by endToEndId so output does not depend on caller ordering. All text
 * is XML-escaped. Amounts are exact minor→major decimal renderings; the group
 * header carries NbOfTxs and the exact decimal CtrlSum.
 */
export function buildPain001(input: Pain001Input): string {
  if (!input.messageId.trim()) throw new RangeError('messageId must be non-empty');
  if (!input.debtorName.trim()) throw new RangeError('debtorName must be non-empty');
  if (!input.debtorIban.trim()) throw new RangeError('debtorIban must be non-empty');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.executionDate)) {
    throw new RangeError(`executionDate must be YYYY-MM-DD, got ${input.executionDate}`);
  }
  if (input.items.length === 0) throw new RangeError('pain.001 requires at least one credit transfer');
  for (const it of input.items) {
    if (!Number.isInteger(it.amountMinor) || it.amountMinor <= 0) {
      throw new RangeError(`Instruction ${it.endToEndId}: amountMinor must be a positive integer, got ${it.amountMinor}`);
    }
    if (!it.endToEndId.trim()) throw new RangeError('Every instruction needs a non-empty endToEndId');
    if (!it.creditorName.trim() || !it.creditorIban.trim()) {
      throw new RangeError(`Instruction ${it.endToEndId}: creditorName and creditorIban are required`);
    }
  }

  const items = [...input.items].sort((a, b) => (a.endToEndId < b.endToEndId ? -1 : a.endToEndId > b.endToEndId ? 1 : 0));
  const ctrlSum = pain001ControlSum(items);
  const creDtTm = input.creationDateTime ?? `${input.executionDate}T00:00:00`;

  const txBlocks = items.map((it) => {
    const amt = minorToMajorString(it.amountMinor, it.currency);
    const lines = [
      '      <CdtTrfTxInf>',
      `        <PmtId><EndToEndId>${xmlEscape(it.endToEndId)}</EndToEndId></PmtId>`,
      `        <Amt><InstdAmt Ccy="${xmlEscape(it.currency.toUpperCase())}">${amt}</InstdAmt></Amt>`,
      financialInstitution(it.creditorBic, '        ', 'CdtrAgt'),
      `        <Cdtr><Nm>${xmlEscape(it.creditorName)}</Nm></Cdtr>`,
      `        <CdtrAcct><Id><IBAN>${xmlEscape(it.creditorIban)}</IBAN></Id></CdtrAcct>`,
    ];
    if (it.remittanceInfo) lines.push(`        <RmtInf><Ustrd>${xmlEscape(it.remittanceInfo)}</Ustrd></RmtInf>`);
    lines.push('      </CdtTrfTxInf>');
    return lines.join('\n');
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">',
    '  <CstmrCdtTrfInitn>',
    '    <GrpHdr>',
    `      <MsgId>${xmlEscape(input.messageId)}</MsgId>`,
    `      <CreDtTm>${xmlEscape(creDtTm)}</CreDtTm>`,
    `      <NbOfTxs>${items.length}</NbOfTxs>`,
    `      <CtrlSum>${ctrlSum}</CtrlSum>`,
    `      <InitgPty><Nm>${xmlEscape(input.debtorName)}</Nm></InitgPty>`,
    '    </GrpHdr>',
    '    <PmtInf>',
    `      <PmtInfId>${xmlEscape(input.messageId)}-01</PmtInfId>`,
    '      <PmtMtd>TRF</PmtMtd>',
    `      <NbOfTxs>${items.length}</NbOfTxs>`,
    `      <CtrlSum>${ctrlSum}</CtrlSum>`,
    `      <ReqdExctnDt>${xmlEscape(input.executionDate)}</ReqdExctnDt>`,
    `      <Dbtr><Nm>${xmlEscape(input.debtorName)}</Nm></Dbtr>`,
    `      <DbtrAcct><Id><IBAN>${xmlEscape(input.debtorIban)}</IBAN></Id></DbtrAcct>`,
    financialInstitution(input.debtorBic, '      ', 'DbtrAgt'),
    ...txBlocks,
    '    </PmtInf>',
    '  </CstmrCdtTrfInitn>',
    '</Document>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Dunning ladder
// ---------------------------------------------------------------------------

export interface DunningLevelDef {
  /** The level this rung assigns (1 = reminder, 2 = formal notice, 3 = final demand…). */
  level: number;
  /** Minimum days overdue (inclusive) for this level to apply. */
  afterDaysOverdue: number;
  label?: string;
}

/** Default ladder: 1+ days → reminder, 30+ → formal notice, 60+ → final demand. */
export const DEFAULT_DUNNING_LEVELS: readonly DunningLevelDef[] = [
  { level: 1, afterDaysOverdue: 1, label: 'Reminder' },
  { level: 2, afterDaysOverdue: 30, label: 'Formal notice' },
  { level: 3, afterDaysOverdue: 60, label: 'Final demand' },
];

export interface DunningInput {
  /** Item due date, YYYY-MM-DD. */
  dueDate: string;
  /** Evaluation date, YYYY-MM-DD (caller-supplied - no clock in the domain). */
  asOf: string;
  /** Configurable ladder; defaults to DEFAULT_DUNNING_LEVELS. */
  levels?: readonly DunningLevelDef[];
}

/**
 * Pure dunning ladder: the highest configured level whose `afterDaysOverdue`
 * threshold is met, or 0 (no dunning) when the item is not yet overdue or no
 * rung applies. Boundaries are inclusive: dpd >= afterDaysOverdue triggers.
 */
export function dunningLevel({ dueDate, asOf, levels = DEFAULT_DUNNING_LEVELS }: DunningInput): number {
  const dpd = epochDay(asOf) - epochDay(dueDate);
  let result = 0;
  for (const rung of [...levels].sort((a, b) => a.afterDaysOverdue - b.afterDaysOverdue)) {
    if (dpd >= rung.afterDaysOverdue) result = rung.level;
  }
  return result;
}

/** Days overdue (asOf − dueDate), negative when not yet due. */
export function daysOverdue(dueDate: string, asOf: string): number {
  return epochDay(asOf) - epochDay(dueDate);
}
