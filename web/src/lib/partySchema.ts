/**
 * Party KYC / compliance field registry (metadata for the Dynamic Form Engine).
 *
 * Counterparty onboarding in reinsurance systems captures know-your-customer and
 * sanctions data that adapts to what the party actually is and where it sits:
 * organisations carry incorporation, regulator and beneficial-ownership detail
 * an individual does not; parties domiciled in heightened-risk jurisdictions
 * require sanctions screening and enhanced due diligence that others skip.
 *
 * The `when(ctx)` predicates read the party kind and domicile that the create
 * modal injects into the FormContext, so the group reshapes as the user picks a
 * kind or types a country. Values persist into the party's `details` bag.
 */
import type { FieldGroup, FormContext } from './formEngine';

/**
 * Heightened-risk / sanctions-exposed domiciles (ISO 3166-1 alpha-2). Demo list;
 * in production this would be a maintained code list, not a hard-coded array.
 */
export const HIGH_RISK_COUNTRIES = ['RU', 'IR', 'KP', 'SY', 'CU', 'VE', 'BY', 'MM', 'AF'];

const isIndividual = (ctx: FormContext) => String(ctx.kind ?? '').toLowerCase() === 'individual';
const inHighRiskCountry = (ctx: FormContext) => HIGH_RISK_COUNTRIES.includes(String(ctx.country ?? '').toUpperCase());

export const PARTY_KYC_GROUPS: FieldGroup[] = [
  {
    id: 'kyc',
    title: 'KYC & compliance',
    description: 'Regulatory and financial-standing detail, adapting to the party kind.',
    fields: [
      // Entity identifiers — not applicable to a natural person. Required-by-kind:
      // an organisation cannot be onboarded without a registration number.
      {
        key: 'incorporationNo', label: 'Incorporation / registration no.', placeholder: 'e.g. HRB 12345',
        when: (ctx) => !isIndividual(ctx), required: true, maxLength: 40,
        pattern: { re: /^[A-Za-z0-9][A-Za-z0-9 .\-/]*$/, message: 'Use letters, digits, spaces, dots, dashes or slashes only' },
      },
      { key: 'regulator', label: 'Regulator / supervisory authority', placeholder: 'e.g. PRA, BMA, BaFin', when: (ctx) => !isIndividual(ctx), maxLength: 80 },
      {
        key: 'licenceNo', label: 'Licence / authorisation no.', placeholder: 'e.g. FRN 123456',
        when: (ctx) => !isIndividual(ctx), maxLength: 40,
        pattern: { re: /^[A-Za-z0-9][A-Za-z0-9 .\-/]*$/, message: 'Use letters, digits, spaces, dots, dashes or slashes only' },
      },
      // Individual identifiers instead — a natural person must be identifiable.
      { key: 'nationalId', label: 'National ID / passport no.', placeholder: 'e.g. passport number', when: isIndividual, required: true, maxLength: 40 },
      {
        key: 'pepExposure',
        label: 'PEP exposure',
        type: 'select',
        options: ['None', 'Domestic', 'Foreign', 'Family / close associate'],
        hint: 'Politically exposed person screening outcome.',
      },
      {
        key: 'creditRatingAgency',
        label: 'Credit rating agency',
        type: 'select',
        options: ['Unrated', 'S&P', "Moody's", 'AM Best', 'Fitch'],
      },
      {
        key: 'creditRating',
        label: 'Credit rating',
        placeholder: 'e.g. A+',
        // Cross-field: only ask for the grade once a rating agency is named.
        when: (ctx) => !!ctx.creditRatingAgency && ctx.creditRatingAgency !== 'Unrated',
      },
    ],
  },
  {
    id: 'kyc-ownership',
    title: 'Beneficial ownership',
    description: 'Group structure and ultimate beneficial owners.',
    when: (ctx) => !isIndividual(ctx),
    fields: [
      { key: 'ultimateParent', label: 'Ultimate parent / group', placeholder: 'e.g. Aurora Holdings AG' },
      { key: 'beneficialOwner', label: 'Beneficial owner(s) > 25%', placeholder: 'Named individuals with >25% holding' },
    ],
  },
  {
    id: 'kyc-sanctions',
    title: 'Sanctions & high-risk jurisdiction',
    description: 'Shown automatically when the domicile is a heightened-risk jurisdiction.',
    // Cross-field: this whole group only appears for high-risk domiciles.
    when: inHighRiskCountry,
    fields: [
      { key: 'sanctionsScreened', label: 'Sanctions screening completed?', type: 'select', required: true, options: ['No', 'Yes'] },
      { key: 'warRiskZone', label: 'Operates in war-risk / conflict zone?', type: 'select', options: ['No', 'Yes'] },
      {
        key: 'sanctionsNotes', label: 'Enhanced due diligence notes', type: 'textarea', fullWidth: true, maxLength: 2000,
        // Cross-field: a high-risk domicile that has NOT been screened must record
        // the enhanced due diligence rationale before the party can be onboarded.
        validate: (v, ctx) => (ctx.sanctionsScreened !== 'Yes' && !v ? 'Enhanced due diligence notes are required until sanctions screening is completed' : undefined),
      },
    ],
  },
];
