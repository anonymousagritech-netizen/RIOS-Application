/**
 * Regulatory filing content as VERSIONED CONFIG + a pure filing-validation
 * engine (moves "Regulatory / Returns" towards Delivered).
 *
 * The jurisdiction *packs* (server/src/content/jurisdictionPacks.ts) supply the
 * regulator-shaped line taxonomy the assembler binds live figures into. This
 * file supplies the *filing content* layered on top: the Schedule F provision
 * factor bands, the Solvency II QRT required-cell maps + control ties, and the
 * IRDAI return line map - the rules a real filing is validated against.
 *
 * This content is delivered as CODE DEFAULTS (the global, version-1 baseline)
 * that a deployment can OVERRIDE with newer, tenant-scoped versions persisted in
 * `regulatory_content_version`. The loader in the module prefers a tenant
 * override and falls back to these code defaults when none exists.
 *
 * HONESTY RULE (CLAUDE.md): every default below is labelled
 * `isCertified: false` and the factor bands carry an explicit "illustrative
 * default, not certified" note. The values reproduce the illustrative Schedule F
 * provision mechanics (`@rios/domain/scheduleF`) and the structural QRT/IRDAI
 * ties - they are NOT the certified NAIC factor tables or official EIOPA cell
 * codes, which are per-deployment jurisdiction configuration. Do not file these.
 *
 * The validation ENGINE (`runFilingValidation`) is pure (no I/O, no clock, no
 * DB) so it is unit-testable and reusable; the module orchestrates assembly and
 * persistence around it.
 */

import { ILLUSTRATIVE_OVERDUE_PROVISION_RATE } from '@rios/domain';

export const NOT_CERTIFIED_NOTE = 'illustrative default, not certified';

// ---------------------------------------------------------------------------
// Content shape
// ---------------------------------------------------------------------------

/** A provision/credit factor with a validity band. Illustrative, not certified. */
export interface FactorBand {
  /** Applied-factor code the validator looks up in the assembled pack (e.g. 'overdueProvisionRate'). */
  code: string;
  label: string;
  min: number;
  max: number;
  default: number;
  /** Always the honest not-certified note. */
  note: string;
}

/** A cell that MUST be present (resolved, non-null) in the assembled template. */
export interface RequiredCell {
  /** Report-pack template code the cell belongs to (e.g. 'SCHEDULE_F', 'S.02.01'). */
  template: string;
  code: string;
  label: string;
}

/**
 * A control-total tie: `left` must equal the sum of `rightOf`. Covers both
 * cross-foots (total = sum of parts) and balance ties (assets = liabilities +
 * equity) with the same shape.
 */
export interface ControlRule {
  template: string;
  /** Stable rule key surfaced in the validation item. */
  code: string;
  label: string;
  left: string;
  rightOf: string[];
}

export interface RegulatoryContentBody {
  /** The jurisdiction pack this content validates. */
  packCode: string;
  factorBands: FactorBand[];
  requiredCells: RequiredCell[];
  controls: ControlRule[];
  disclaimer: string;
}

export interface RegulatoryContentDefault {
  jurisdiction: string;
  contentKey: string;
  version: number;
  effectiveFrom: string;
  isCertified: boolean;
  body: RegulatoryContentBody;
}

const DISCLAIMER =
  'Filing content is versioned configuration. The shipped defaults are illustrative and NOT certified: ' +
  'factor bands reproduce the illustrative Schedule F provision mechanics and the QRT/IRDAI structural ties, ' +
  'not certified NAIC factor tables or official EIOPA cell codes. Certified content is per-deployment ' +
  'jurisdiction configuration supplied as a newer content version. Not for filing.';

// ---------------------------------------------------------------------------
// Shipped default content (global, version 1, is_certified=false)
// ---------------------------------------------------------------------------

/**
 * (US) NAIC Schedule F - provision factor bands + the recoverable control tie.
 * The band reproduces the illustrative overdue-provision rate of the pure
 * `scheduleFProvision` engine; it is an illustrative default, not certified.
 */
const scheduleF: RegulatoryContentDefault = {
  jurisdiction: 'US',
  contentKey: 'NAIC_SCHEDULE_F',
  version: 1,
  effectiveFrom: '2024-01-01',
  isCertified: false,
  body: {
    packCode: 'NAIC_SCHEDULE_F',
    factorBands: [
      {
        code: 'overdueProvisionRate',
        label: 'Provision rate on overdue recoverable balances',
        min: ILLUSTRATIVE_OVERDUE_PROVISION_RATE,
        max: ILLUSTRATIVE_OVERDUE_PROVISION_RATE,
        default: ILLUSTRATIVE_OVERDUE_PROVISION_RATE,
        note: NOT_CERTIFIED_NOTE,
      },
    ],
    requiredCells: [
      { template: 'SCHEDULE_F', code: 'SF_AUTH_RECOVERABLE', label: 'Recoverable from authorized/secure-rated reinsurers' },
      { template: 'SCHEDULE_F', code: 'SF_UNAUTH_RECOVERABLE', label: 'Recoverable from unauthorized/unrated reinsurers' },
      { template: 'SCHEDULE_F', code: 'SF_TOTAL_RECOVERABLE', label: 'Total reinsurance recoverable' },
      { template: 'SCHEDULE_F', code: 'SF_TOTAL_CHECK', label: 'Total recoverable control (ceded losses less recoveries)' },
      { template: 'SCHEDULE_F', code: 'SF_COLLATERAL_HELD', label: 'Qualifying collateral held' },
      { template: 'SCHEDULE_F', code: 'SF_PROVISION_TOTAL', label: 'Total provision for reinsurance' },
      { template: 'SCHEDULE_F', code: 'SF_NET_RECOVERABLE', label: 'Net recoverable after provision' },
    ],
    controls: [
      {
        template: 'SCHEDULE_F',
        code: 'SF_TOTAL_RECOVERABLE_TIES_CHECK',
        label: 'Total recoverable ties to ceded losses less recoveries',
        left: 'SF_TOTAL_CHECK',
        rightOf: ['SF_TOTAL_RECOVERABLE'],
      },
      {
        template: 'SCHEDULE_F',
        code: 'SF_TOTAL_RECOVERABLE_IS_SUM_OF_PARTS',
        label: 'Total recoverable = authorized + unauthorized',
        left: 'SF_TOTAL_RECOVERABLE',
        rightOf: ['SF_AUTH_RECOVERABLE', 'SF_UNAUTH_RECOVERABLE'],
      },
      {
        template: 'SCHEDULE_F',
        code: 'SF_NET_RECOVERABLE_TIE',
        label: 'Net recoverable = total recoverable - total provision',
        left: 'SF_TOTAL_RECOVERABLE',
        rightOf: ['SF_NET_RECOVERABLE', 'SF_PROVISION_TOTAL'],
      },
    ],
    disclaimer: DISCLAIMER,
  },
};

/**
 * (EU) Solvency II QRT - required-cell maps + control ties for S.02.01 (balance
 * sheet: assets = liabilities + equity) and S.31.01 (share of reinsurers:
 * total = rated + unrated). Illustrative cell codes, not the official EIOPA
 * taxonomy.
 */
const solvency2Qrt: RegulatoryContentDefault = {
  jurisdiction: 'EU',
  contentKey: 'SOLVENCY2_QRT',
  version: 1,
  effectiveFrom: '2024-01-01',
  isCertified: false,
  body: {
    packCode: 'SOLVENCY2_QRT',
    factorBands: [],
    requiredCells: [
      { template: 'S.02.01', code: 'S02_REINSURANCE_RECOVERABLES', label: 'Reinsurance recoverables (memo)' },
      { template: 'S.02.01', code: 'S02_TOTAL_ASSETS', label: 'Total assets (GL)' },
      { template: 'S.02.01', code: 'S02_TECHNICAL_PROVISIONS', label: 'Technical provisions (memo)' },
      { template: 'S.02.01', code: 'S02_TOTAL_LIABILITIES', label: 'Total liabilities (GL)' },
      { template: 'S.02.01', code: 'S02_EXCESS_ASSETS_OVER_LIABILITIES', label: 'Excess of assets over liabilities' },
      { template: 'S.02.01', code: 'S02_EQUITY_CHECK', label: 'Equity + retained earnings (control)' },
      { template: 'S.31.01', code: 'S31_RECOVERABLE_RATED', label: 'Recoverable from rated reinsurers' },
      { template: 'S.31.01', code: 'S31_RECOVERABLE_UNRATED', label: 'Recoverable from unrated reinsurers' },
      { template: 'S.31.01', code: 'S31_TOTAL_RECOVERABLE', label: 'Total recoverable from reinsurers' },
      { template: 'S.31.01', code: 'S31_COLLATERAL_HELD', label: 'Collateral held against recoverables' },
    ],
    controls: [
      {
        template: 'S.02.01',
        code: 'S02_BALANCE_SHEET_TIE',
        label: 'Balance sheet ties: total assets = total liabilities + equity',
        left: 'S02_TOTAL_ASSETS',
        rightOf: ['S02_TOTAL_LIABILITIES', 'S02_EQUITY_CHECK'],
      },
      {
        template: 'S.02.01',
        code: 'S02_EXCESS_TIE',
        label: 'Excess of assets over liabilities = equity + retained earnings',
        left: 'S02_EXCESS_ASSETS_OVER_LIABILITIES',
        rightOf: ['S02_EQUITY_CHECK'],
      },
      {
        template: 'S.31.01',
        code: 'S31_RECOVERABLE_SUM_TIE',
        label: 'Total recoverable = rated + unrated',
        left: 'S31_TOTAL_RECOVERABLE',
        rightOf: ['S31_RECOVERABLE_RATED', 'S31_RECOVERABLE_UNRATED'],
      },
    ],
    disclaimer: DISCLAIMER,
  },
};

/**
 * (IN) IRDAI reinsurance returns - line map + the net-premium tie
 * (net = inward - outward). Illustrative line map, not the official IRDAI
 * annexure formats.
 */
const irdaiReturns: RegulatoryContentDefault = {
  jurisdiction: 'IN',
  contentKey: 'IRDAI_REINSURANCE_RETURNS',
  version: 1,
  effectiveFrom: '2024-01-01',
  isCertified: false,
  body: {
    packCode: 'IRDAI_REINSURANCE_RETURNS',
    factorBands: [],
    requiredCells: [
      { template: 'IRDAI_RI_SUMMARY', code: 'IRDAI_INWARD_PREMIUM', label: 'Premium on reinsurance accepted' },
      { template: 'IRDAI_RI_SUMMARY', code: 'IRDAI_INWARD_CLAIMS_PAID', label: 'Claims paid on reinsurance accepted' },
      { template: 'IRDAI_RI_SUMMARY', code: 'IRDAI_OUTWARD_PREMIUM', label: 'Premium on reinsurance ceded' },
      { template: 'IRDAI_RI_SUMMARY', code: 'IRDAI_OUTWARD_RECOVERIES', label: 'Claim recoveries under reinsurance ceded' },
      { template: 'IRDAI_RI_SUMMARY', code: 'IRDAI_NET_PREMIUM', label: 'Net premium (accepted less ceded)' },
      { template: 'IRDAI_RI_SUMMARY', code: 'IRDAI_NET_PREMIUM_CHECK', label: 'Net premium control' },
    ],
    controls: [
      {
        template: 'IRDAI_RI_SUMMARY',
        code: 'IRDAI_NET_PREMIUM_TIE',
        label: 'Net premium ties to control',
        left: 'IRDAI_NET_PREMIUM_CHECK',
        rightOf: ['IRDAI_NET_PREMIUM'],
      },
      {
        template: 'IRDAI_RI_SUMMARY',
        code: 'IRDAI_NET_PREMIUM_IS_INWARD_LESS_OUTWARD',
        label: 'Net premium = inward premium - outward premium',
        left: 'IRDAI_INWARD_PREMIUM',
        rightOf: ['IRDAI_NET_PREMIUM', 'IRDAI_OUTWARD_PREMIUM'],
      },
    ],
    disclaimer: DISCLAIMER,
  },
};

/** The shipped default filing content, keyed by pack/content code. */
export const REGULATORY_CONTENT_DEFAULTS: readonly RegulatoryContentDefault[] = [
  scheduleF,
  solvency2Qrt,
  irdaiReturns,
];

export function findContentDefault(jurisdiction: string, contentKey: string): RegulatoryContentDefault | undefined {
  return REGULATORY_CONTENT_DEFAULTS.find(
    (c) => c.jurisdiction.toUpperCase() === jurisdiction.toUpperCase() && c.contentKey.toUpperCase() === contentKey.toUpperCase(),
  );
}

export function findContentDefaultByPack(packCode: string): RegulatoryContentDefault | undefined {
  return REGULATORY_CONTENT_DEFAULTS.find((c) => c.body.packCode.toUpperCase() === packCode.toUpperCase());
}

// ---------------------------------------------------------------------------
// Pure filing-validation engine
// ---------------------------------------------------------------------------

export type Severity = 'ERROR' | 'WARN';
export type FilingStatus = 'PASS' | 'WARN' | 'FAIL';

/** One assembled template's resolved values, plus any applied factors to band-check. */
export interface AssembledForValidation {
  templateCode: string;
  values: Record<string, number | null>;
  /** e.g. { overdueProvisionRate: 0.2 } - checked against the factor bands. */
  appliedFactors?: Record<string, number>;
}

export interface FilingValidationItem {
  ruleKey: string;
  severity: Severity;
  message: string;
  expected: unknown;
  actual: unknown;
  ok: boolean;
}

export interface FilingValidationResult {
  status: FilingStatus;
  items: FilingValidationItem[];
}

/**
 * Validate assembled templates against a content version's required cells,
 * control ties and factor bands. Pure and deterministic.
 *
 * - required cell  (ERROR): the cell must be present (resolved, non-null).
 * - control tie    (ERROR): `left` must equal the integer sum of `rightOf`.
 * - factor band    (WARN):  an applied factor must fall within [min,max].
 *
 * Verdict: any failing ERROR => FAIL; else any failing WARN => WARN; else PASS.
 */
export function runFilingValidation(
  body: RegulatoryContentBody,
  assembled: AssembledForValidation[],
): FilingValidationResult {
  const items: FilingValidationItem[] = [];
  const byTemplate = new Map(assembled.map((a) => [a.templateCode, a]));
  // Tolerate partial JSONB overrides: any missing rule array is simply empty.
  const requiredCells = body.requiredCells ?? [];
  const controls = body.controls ?? [];
  const factorBands = body.factorBands ?? [];

  // 1) Required cells present.
  for (const rc of requiredCells) {
    const t = byTemplate.get(rc.template);
    const v = t ? t.values[rc.code] : undefined;
    const ok = v !== undefined && v !== null;
    items.push({
      ruleKey: `required:${rc.template}:${rc.code}`,
      severity: 'ERROR',
      message: ok
        ? `Required cell ${rc.code} present in ${rc.template}`
        : `Missing required cell ${rc.code} (${rc.label}) in ${rc.template}`,
      expected: 'present',
      actual: ok ? v : null,
      ok,
    });
  }

  // 2) Control totals tie (left == sum(rightOf)).
  for (const c of controls) {
    const t = byTemplate.get(c.template);
    const left = t ? t.values[c.left] : undefined;
    const rightVals = c.rightOf.map((code) => (t ? t.values[code] : undefined));
    const missing =
      left === undefined || left === null || rightVals.some((x) => x === undefined || x === null);
    const rightSum = rightVals.reduce<number>((a, x) => a + (x ?? 0), 0);
    const ok = !missing && left === rightSum;
    items.push({
      ruleKey: `control:${c.template}:${c.code}`,
      severity: 'ERROR',
      message: missing
        ? `Control ${c.code} (${c.label}) cannot evaluate: an operand is missing`
        : ok
          ? `Control ${c.code} ties (${c.label})`
          : `Control ${c.code} broken (${c.label}): ${c.left}=${left} != sum(${c.rightOf.join('+')})=${rightSum}`,
      expected: missing ? null : rightSum,
      actual: left ?? null,
      ok,
    });
  }

  // 3) Factor bands (applied factor within [min,max]) - WARN severity.
  for (const fb of factorBands) {
    let applied: number | undefined;
    for (const a of assembled) {
      if (a.appliedFactors && Object.prototype.hasOwnProperty.call(a.appliedFactors, fb.code)) {
        applied = a.appliedFactors[fb.code];
        break;
      }
    }
    if (applied === undefined) continue; // factor not applicable to this pack
    const ok = applied >= fb.min && applied <= fb.max;
    items.push({
      ruleKey: `factorBand:${fb.code}`,
      severity: 'WARN',
      message: ok
        ? `Factor ${fb.code}=${applied} within configured band [${fb.min},${fb.max}] (${fb.note})`
        : `Factor ${fb.code}=${applied} outside configured band [${fb.min},${fb.max}] (${fb.note})`,
      expected: { min: fb.min, max: fb.max },
      actual: applied,
      ok,
    });
  }

  const hasFail = items.some((i) => !i.ok && i.severity === 'ERROR');
  const hasWarn = items.some((i) => !i.ok && i.severity === 'WARN');
  const status: FilingStatus = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';
  return { status, items };
}
