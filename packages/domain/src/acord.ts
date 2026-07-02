/**
 * ACORD bureau messaging - EBOT / ECOT message model, builders and validators.
 *
 * London-market / bureau reinsurance is settled and reported through ACORD
 * Global Reinsurance & Large Commercial (GRLC) messages carried over the DXC /
 * bureau network:
 *   - EBOT (Electronic Back-Office Transaction) carries *technical accounting* -
 *     premium, brokerage, taxes and the net settlement due to/from the market.
 *   - ECOT (Electronic Claims Office Transaction) carries a *claim movement* -
 *     paid and outstanding amounts for a loss under a contract.
 *
 * This module is PURE (no I/O, DB, clock or randomness): it maps RIOS statement
 * and claim data into typed ACORD message objects, validates them against the
 * mandatory-field rules a bureau would enforce, and produces a deterministic
 * canonical serialization. The serialization here is a stable, sorted-key JSON
 * envelope that stands in for the ACORD AL3 / XML wire format - the server's
 * bureau connector is the labelled seam that would translate this envelope to
 * the real market schema and transport it to DXC. All money is integer minor
 * units; cross-currency mixing is rejected at validation time.
 */

/** A bureau message is one of these ACORD transaction kinds. */
export type AcordMessageType = 'EBOT' | 'ECOT';

/** Money carried on a message - always minor units, single currency per field. */
export interface AcordAmount {
  amountMinor: number;
  currency: string;
}

/** A party on the message with its market role. */
export interface AcordParty {
  /** e.g. 'REINSURER', 'CEDENT', 'BROKER'. */
  role: string;
  name: string;
  /** Optional market/bureau code (e.g. broker pseudonym, cedent code). */
  reference?: string;
}

/** Common header carried by every ACORD message. */
export interface AcordHeader {
  messageType: AcordMessageType;
  /** Unique Transaction Reference - the market-wide id for this message. */
  uti: string;
  /** Unique Market Reference of the underlying contract (the slip/UMR). */
  umr?: string;
  senderReference: string;
  currency: string;
  parties: AcordParty[];
}

/** EBOT - a technical-accounting settlement advice built from a statement. */
export interface EbotMessage {
  header: AcordHeader;
  /** Business date the accounting relates to (YYYY-MM-DD). */
  accountingDate: string;
  /** Date settlement is due to/from the market (YYYY-MM-DD). */
  settlementDueDate: string;
  /** Gross premium ceded for the period. */
  premium: AcordAmount;
  /** Ceding / broker commission deducted. */
  brokerage: AcordAmount;
  /** Taxes and levies deducted. */
  taxes: AcordAmount;
  /**
   * Net technical-account amount settling through the bureau. Positive = due to
   * the reinsurer; negative = due to the cedent. Must equal
   * premium - brokerage - taxes (all same currency).
   */
  settlementAmount: AcordAmount;
}

/** ECOT - a claim movement advice built from a claim transaction. */
export interface EcotMessage {
  header: AcordHeader;
  /** Market loss reference / UCR for the claim. */
  lossReference: string;
  /** Catastrophe / event code if the loss is aggregated to an event. */
  catCode?: string;
  lossDate?: string;
  /** Amount paid on this movement. */
  paid: AcordAmount;
  /** Outstanding (case reserve) carried after this movement. */
  outstanding: AcordAmount;
  /** Net cash settling through the bureau for this movement. */
  settlementAmount: AcordAmount;
}

export type AcordMessage = EbotMessage | EcotMessage;

export interface AcordValidationResult {
  valid: boolean;
  errors: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function amt(amountMinor: number, currency: string): AcordAmount {
  return { amountMinor: Math.round(amountMinor), currency };
}

/** Inputs to build an EBOT - typically drawn from a statement of account. */
export interface EbotInput {
  uti: string;
  umr?: string;
  senderReference: string;
  currency: string;
  parties: AcordParty[];
  accountingDate: string;
  settlementDueDate: string;
  premiumMinor: number;
  brokerageMinor?: number;
  taxesMinor?: number;
  /** If omitted, computed as premium - brokerage - taxes. */
  settlementAmountMinor?: number;
}

/**
 * Build an EBOT technical-accounting message. The net settlement defaults to
 * premium - brokerage - taxes so the message always balances unless the caller
 * deliberately overrides it (which validation will then flag if inconsistent).
 */
export function buildEbot(input: EbotInput): EbotMessage {
  const brokerage = input.brokerageMinor ?? 0;
  const taxes = input.taxesMinor ?? 0;
  const settlement =
    input.settlementAmountMinor ?? input.premiumMinor - brokerage - taxes;
  return {
    header: {
      messageType: 'EBOT',
      uti: input.uti,
      umr: input.umr,
      senderReference: input.senderReference,
      currency: input.currency,
      parties: input.parties,
    },
    accountingDate: input.accountingDate,
    settlementDueDate: input.settlementDueDate,
    premium: amt(input.premiumMinor, input.currency),
    brokerage: amt(brokerage, input.currency),
    taxes: amt(taxes, input.currency),
    settlementAmount: amt(settlement, input.currency),
  };
}

/** Inputs to build an ECOT - typically drawn from a claim movement. */
export interface EcotInput {
  uti: string;
  umr?: string;
  senderReference: string;
  currency: string;
  parties: AcordParty[];
  lossReference: string;
  catCode?: string;
  lossDate?: string;
  paidMinor: number;
  outstandingMinor: number;
  /** If omitted, the settlement equals the paid amount for this movement. */
  settlementAmountMinor?: number;
}

/** Build an ECOT claim-movement message. */
export function buildEcot(input: EcotInput): EcotMessage {
  return {
    header: {
      messageType: 'ECOT',
      uti: input.uti,
      umr: input.umr,
      senderReference: input.senderReference,
      currency: input.currency,
      parties: input.parties,
    },
    lossReference: input.lossReference,
    catCode: input.catCode,
    lossDate: input.lossDate,
    paid: amt(input.paidMinor, input.currency),
    outstanding: amt(input.outstandingMinor, input.currency),
    settlementAmount: amt(input.settlementAmountMinor ?? input.paidMinor, input.currency),
  };
}

export function isEbot(msg: AcordMessage): msg is EbotMessage {
  return msg.header.messageType === 'EBOT';
}

export function isEcot(msg: AcordMessage): msg is EcotMessage {
  return msg.header.messageType === 'ECOT';
}

function validateHeader(h: AcordHeader, errors: string[]): void {
  if (!h.uti || !h.uti.trim()) errors.push('header.uti is required');
  if (!h.senderReference || !h.senderReference.trim()) errors.push('header.senderReference is required');
  if (!/^[A-Za-z]{3}$/.test(h.currency)) errors.push(`header.currency must be a 3-letter code, got '${h.currency}'`);
  if (!h.parties || h.parties.length === 0) errors.push('header.parties must have at least one party');
  else {
    h.parties.forEach((p, i) => {
      if (!p.role || !p.role.trim()) errors.push(`header.parties[${i}].role is required`);
      if (!p.name || !p.name.trim()) errors.push(`header.parties[${i}].name is required`);
    });
  }
}

function sameCcy(a: AcordAmount, ccy: string, field: string, errors: string[]): void {
  if (a.currency !== ccy) errors.push(`${field}.currency '${a.currency}' does not match header currency '${ccy}'`);
  if (!Number.isInteger(a.amountMinor)) errors.push(`${field}.amountMinor must be an integer (minor units)`);
}

/**
 * Validate a message against the bureau's mandatory-field and consistency rules.
 * Rejects mixed currencies and an EBOT whose net settlement does not reconcile
 * to premium - brokerage - taxes.
 */
export function validateAcordMessage(msg: AcordMessage): AcordValidationResult {
  const errors: string[] = [];
  validateHeader(msg.header, errors);
  const ccy = msg.header.currency;

  if (isEbot(msg)) {
    if (!DATE_RE.test(msg.accountingDate)) errors.push('accountingDate must be YYYY-MM-DD');
    if (!DATE_RE.test(msg.settlementDueDate)) errors.push('settlementDueDate must be YYYY-MM-DD');
    sameCcy(msg.premium, ccy, 'premium', errors);
    sameCcy(msg.brokerage, ccy, 'brokerage', errors);
    sameCcy(msg.taxes, ccy, 'taxes', errors);
    sameCcy(msg.settlementAmount, ccy, 'settlementAmount', errors);
    if (msg.premium.amountMinor < 0) errors.push('premium.amountMinor must be non-negative');
    const expected = msg.premium.amountMinor - msg.brokerage.amountMinor - msg.taxes.amountMinor;
    if (msg.settlementAmount.amountMinor !== expected) {
      errors.push(
        `settlementAmount ${msg.settlementAmount.amountMinor} does not reconcile to ` +
          `premium - brokerage - taxes (${expected})`,
      );
    }
  } else {
    if (!msg.lossReference || !msg.lossReference.trim()) errors.push('lossReference is required');
    if (msg.lossDate && !DATE_RE.test(msg.lossDate)) errors.push('lossDate must be YYYY-MM-DD');
    sameCcy(msg.paid, ccy, 'paid', errors);
    sameCcy(msg.outstanding, ccy, 'outstanding', errors);
    sameCcy(msg.settlementAmount, ccy, 'settlementAmount', errors);
    if (msg.outstanding.amountMinor < 0) errors.push('outstanding.amountMinor must be non-negative');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Deterministic canonical serialization (sorted keys, stable ordering). Stands
 * in for the ACORD AL3 / XML wire format; the bureau connector translates this
 * envelope to the real market schema. Deterministic so two builds of the same
 * message are byte-identical (idempotent transmission, hashing, replay).
 */
export function serializeAcord(msg: AcordMessage): string {
  return JSON.stringify(sortKeys(msg));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}
