/**
 * Jurisdiction report packs as CONTENT (industry-gap-analysis Tier-3 #12).
 *
 * The governed report-pack assembler (`@rios/domain/reportPack`) consumes
 * `ReportPackTemplate` objects directly - there is no report-definition table
 * today - so the shipped jurisdiction content lives here as
 * **definitions-as-data**: plain template objects the jurisdictionPacks module
 * binds live tenant figures into. Nothing in this file executes; it is the
 * regulator-shaped line taxonomy only.
 *
 * HONESTY RULE (CLAUDE.md): every pack below is a structurally correct,
 * clearly-labelled **template, not certified content**. The section/line
 * shapes follow the public structure of each return; the certified line
 * taxonomies, factor tables and filing validations are jurisdiction
 * configuration a real Phase-2 engagement would supply. Do not file these.
 */

import type { ReportPackTemplate } from '@rios/domain';

export interface JurisdictionPackDefinition {
  /** Stable pack code used in the API path. */
  code: string;
  jurisdiction: string;
  regulator: string;
  title: string;
  /** Always carries the honest 'template, not certified content' label. */
  description: string;
  /** Returned verbatim with every assembly. */
  disclaimer: string;
  /** One or more report-pack templates assembled together (e.g. several QRTs). */
  templates: ReportPackTemplate[];
}

const TEMPLATE_NOT_CERTIFIED =
  'Template, not certified content: structurally correct mapping of live system data into the ' +
  "regulator's return shape. Line taxonomy is illustrative; certified factors, official line codes and " +
  'filing validations are jurisdiction configuration and are NOT shipped. Not for filing.';

/**
 * (a) NAIC Schedule F (US) - ceded reinsurance by counterparty with the
 * security-driven provision for reinsurance. Provision maths comes from the
 * pure `scheduleFProvision` engine (`@rios/domain/scheduleF`), whose overdue
 * rate and secure-rating sets are ILLUSTRATIVE DEFAULTS, not certified NAIC
 * factors.
 */
const naicScheduleF: JurisdictionPackDefinition = {
  code: 'NAIC_SCHEDULE_F',
  jurisdiction: 'US',
  regulator: 'NAIC',
  title: 'NAIC Schedule F - Ceded Reinsurance (template, not certified content)',
  description:
    'Ceded-reinsurance schedule: recoverables by counterparty split authorized vs unauthorized/unrated, ' +
    'collateral held, overdue balances, and the security-driven provision for reinsurance. ' +
    TEMPLATE_NOT_CERTIFIED,
  disclaimer: TEMPLATE_NOT_CERTIFIED,
  templates: [
    {
      code: 'SCHEDULE_F',
      title: 'Schedule F - ceded reinsurance and provision (template, not certified content)',
      totalLineCode: 'SF_NET_RECOVERABLE',
      controls: [{ code: 'SF_TOTAL_RECOVERABLE', equals: 'SF_TOTAL_CHECK' }],
      sections: [
        {
          code: 'SF_RECOVERABLES',
          title: 'Reinsurance recoverable by counterparty security status',
          lines: [
            { code: 'SF_AUTH_RECOVERABLE', label: 'Recoverable from authorized/secure-rated reinsurers', kind: 'input', required: true },
            { code: 'SF_UNAUTH_RECOVERABLE', label: 'Recoverable from unauthorized/unrated reinsurers', kind: 'input', required: true },
            { code: 'SF_TOTAL_RECOVERABLE', label: 'Total reinsurance recoverable', kind: 'sum', of: ['SF_AUTH_RECOVERABLE', 'SF_UNAUTH_RECOVERABLE'] },
            { code: 'SF_TOTAL_CHECK', label: 'Total recoverable (control: ceded losses less recoveries)', kind: 'input', required: true },
          ],
        },
        {
          code: 'SF_SECURITY',
          title: 'Counterparty security',
          lines: [
            { code: 'SF_COLLATERAL_HELD', label: 'Qualifying collateral held (LOC / funds withheld / trust / cash)', kind: 'input', required: true },
            { code: 'SF_OVERDUE_RECOVERABLE', label: 'Recoverable balances overdue', kind: 'input', required: true },
          ],
        },
        {
          code: 'SF_PROVISION',
          title: 'Provision for reinsurance (illustrative default factors, configurable)',
          lines: [
            { code: 'SF_PROVISION_AUTH', label: 'Provision - authorized reinsurers (overdue penalty)', kind: 'input', required: true },
            { code: 'SF_PROVISION_UNAUTH', label: 'Provision - unauthorized/unrated reinsurers (uncollateralized + overdue penalty)', kind: 'input', required: true },
            { code: 'SF_PROVISION_TOTAL', label: 'Total provision for reinsurance', kind: 'sum', of: ['SF_PROVISION_AUTH', 'SF_PROVISION_UNAUTH'] },
            { code: 'SF_NET_RECOVERABLE', label: 'Net recoverable after provision', kind: 'diff', of: ['SF_TOTAL_RECOVERABLE', 'SF_PROVISION_TOTAL'] },
          ],
        },
      ],
    },
  ],
};

/**
 * (b) Solvency II QRT skeletons (EU) - S.02.01 balance sheet bound to the
 * tenant's GL (assets / liabilities / excess, tied to equity + retained
 * earnings) and S.31.01 share-of-reinsurers bound to ceded recoverables and
 * counterparty ratings. Skeletons only: the official EIOPA cell codes and full
 * row taxonomy are not shipped.
 */
const solvency2Qrt: JurisdictionPackDefinition = {
  code: 'SOLVENCY2_QRT',
  jurisdiction: 'EU',
  regulator: 'EIOPA',
  title: 'Solvency II QRT skeletons - S.02.01 & S.31.01 (template, not certified content)',
  description:
    'QRT skeletons: S.02.01 balance sheet (GL-derived, with the excess-of-assets-over-liabilities tie) ' +
    'and S.31.01 share of reinsurers (ceded recoverables by counterparty rating). ' +
    TEMPLATE_NOT_CERTIFIED,
  disclaimer: TEMPLATE_NOT_CERTIFIED,
  templates: [
    {
      code: 'S.02.01',
      title: 'S.02.01 - Balance sheet (skeleton; template, not certified content)',
      totalLineCode: 'S02_EXCESS_ASSETS_OVER_LIABILITIES',
      controls: [{ code: 'S02_EXCESS_ASSETS_OVER_LIABILITIES', equals: 'S02_EQUITY_CHECK' }],
      sections: [
        {
          code: 'S02_ASSETS',
          title: 'Assets',
          lines: [
            { code: 'S02_REINSURANCE_RECOVERABLES', label: 'Reinsurance recoverables (memo, technical sub-ledger)', kind: 'input', required: true },
            { code: 'S02_TOTAL_ASSETS', label: 'Total assets (GL)', kind: 'input', required: true },
          ],
        },
        {
          code: 'S02_LIABILITIES',
          title: 'Liabilities',
          lines: [
            { code: 'S02_TECHNICAL_PROVISIONS', label: 'Technical provisions (memo, IFRS 17 measurements)', kind: 'input', required: true },
            { code: 'S02_TOTAL_LIABILITIES', label: 'Total liabilities (GL)', kind: 'input', required: true },
          ],
        },
        {
          code: 'S02_EXCESS',
          title: 'Excess of assets over liabilities',
          lines: [
            { code: 'S02_EXCESS_ASSETS_OVER_LIABILITIES', label: 'Excess of assets over liabilities', kind: 'diff', of: ['S02_TOTAL_ASSETS', 'S02_TOTAL_LIABILITIES'] },
            { code: 'S02_EQUITY_CHECK', label: 'Equity + retained earnings (control)', kind: 'input', required: true },
          ],
        },
      ],
    },
    {
      code: 'S.31.01',
      title: 'S.31.01 - Share of reinsurers (skeleton; template, not certified content)',
      totalLineCode: 'S31_TOTAL_RECOVERABLE',
      sections: [
        {
          code: 'S31_SHARE',
          title: 'Reinsurance recoverables by counterparty rating',
          lines: [
            { code: 'S31_RECOVERABLE_RATED', label: 'Recoverable from rated reinsurers', kind: 'input', required: true },
            { code: 'S31_RECOVERABLE_UNRATED', label: 'Recoverable from unrated reinsurers', kind: 'input', required: true },
            { code: 'S31_TOTAL_RECOVERABLE', label: 'Total recoverable from reinsurers', kind: 'sum', of: ['S31_RECOVERABLE_RATED', 'S31_RECOVERABLE_UNRATED'] },
            { code: 'S31_COLLATERAL_HELD', label: 'Collateral held against recoverables', kind: 'input', required: true },
          ],
        },
      ],
    },
  ],
};

/**
 * (c) IRDAI reinsurance returns (India) - the outward/inward summary shape:
 * inward (accepted) vs outward (ceded) premium and claims with the net
 * position and a premium tie-out. Shape only; the official IRDAI return
 * formats/annexures are not shipped.
 */
const irdaiReinsuranceReturns: JurisdictionPackDefinition = {
  code: 'IRDAI_REINSURANCE_RETURNS',
  jurisdiction: 'IN',
  regulator: 'IRDAI',
  title: 'IRDAI reinsurance returns - inward/outward summary (template, not certified content)',
  description:
    'Inward (accepted) vs outward (ceded) reinsurance summary: premium and claims each way with the net ' +
    'retained position. ' +
    TEMPLATE_NOT_CERTIFIED,
  disclaimer: TEMPLATE_NOT_CERTIFIED,
  templates: [
    {
      code: 'IRDAI_RI_SUMMARY',
      title: 'IRDAI reinsurance summary (template, not certified content)',
      totalLineCode: 'IRDAI_NET_PREMIUM',
      controls: [{ code: 'IRDAI_NET_PREMIUM', equals: 'IRDAI_NET_PREMIUM_CHECK' }],
      sections: [
        {
          code: 'IRDAI_INWARD',
          title: 'Inward (accepted) reinsurance',
          lines: [
            { code: 'IRDAI_INWARD_PREMIUM', label: 'Premium on reinsurance accepted', kind: 'input', required: true },
            { code: 'IRDAI_INWARD_CLAIMS_PAID', label: 'Claims paid on reinsurance accepted', kind: 'input', required: true },
          ],
        },
        {
          code: 'IRDAI_OUTWARD',
          title: 'Outward (ceded) reinsurance',
          lines: [
            { code: 'IRDAI_OUTWARD_PREMIUM', label: 'Premium on reinsurance ceded', kind: 'input', required: true },
            { code: 'IRDAI_OUTWARD_RECOVERIES', label: 'Claim recoveries under reinsurance ceded (ceded loss share)', kind: 'input', required: true },
          ],
        },
        {
          code: 'IRDAI_NET',
          title: 'Net retained position',
          lines: [
            { code: 'IRDAI_NET_PREMIUM', label: 'Net premium (accepted less ceded)', kind: 'diff', of: ['IRDAI_INWARD_PREMIUM', 'IRDAI_OUTWARD_PREMIUM'] },
            { code: 'IRDAI_NET_INCURRED', label: 'Net claims (paid less recovered)', kind: 'diff', of: ['IRDAI_INWARD_CLAIMS_PAID', 'IRDAI_OUTWARD_RECOVERIES'] },
            { code: 'IRDAI_NET_PREMIUM_CHECK', label: 'Net premium (control)', kind: 'input', required: true },
          ],
        },
      ],
    },
  ],
};

/** The shipped jurisdiction packs, in listing order. */
export const JURISDICTION_PACKS: readonly JurisdictionPackDefinition[] = [
  naicScheduleF,
  solvency2Qrt,
  irdaiReinsuranceReturns,
];

export function findJurisdictionPack(code: string): JurisdictionPackDefinition | undefined {
  return JURISDICTION_PACKS.find((p) => p.code.toUpperCase() === code.toUpperCase());
}
