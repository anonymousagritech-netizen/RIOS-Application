/**
 * Underwriting model catalog - pure, declarative, framework-free.
 *
 * Reinsurance is written through a handful of *structures* (quota share, surplus,
 * per-risk XL, cat XL, aggregate XL, stop loss, facultative) across many *lines
 * of business* (property, casualty, marine, aviation, agriculture, cyber, life,
 * health, …). Each structure and each line has its own vocabulary of terms an
 * underwriter must capture on the slip.
 *
 * Rather than hard-code a form per model (there are dozens of structure × line
 * combinations), this file describes every model *as data*: a list of typed field
 * definitions. The server serves the catalog and the web client renders the slip
 * from it, so a new model is a data change - never a redeployed form. This mirrors
 * the metadata-driven-config principle used elsewhere in RIOS (ADR 0004).
 *
 * Nothing here does I/O, math or persistence; it is the shared contract that the
 * submission's `terms` JSON is validated and rendered against.
 */

export type ModelFieldType = 'number' | 'percent' | 'money' | 'text' | 'select' | 'boolean';

export interface ModelField {
  /** Stable key stored in the submission `terms` JSON. */
  key: string;
  label: string;
  type: ModelFieldType;
  /** Grouping heading on the slip (fields with the same group render together). */
  group?: string;
  /** For 'select': the allowed values. */
  options?: string[];
  /** Unit suffix shown next to numeric inputs (e.g. 'years', 'hrs', 'ha'). */
  unit?: string;
  /** Short helper text shown under the field. */
  help?: string;
  required?: boolean;
}

/** How premium and loss share are computed - drives which terms matter. */
export type ModelBasis = 'PROPORTIONAL' | 'NON_PROPORTIONAL';

export interface ModelStructure {
  /** Stable key (matches the retrocession/treaty np-type vocabulary where they overlap). */
  key: string;
  label: string;
  basis: ModelBasis;
  /** One-line description of when this structure is used. */
  blurb: string;
  fields: ModelField[];
}

export interface ModelLine {
  key: string;
  label: string;
  /** Default class-of-business hazard weight (1 benign … 5 hazardous) - seeds the risk score. */
  hazard: number;
  /** Whether business in this line is typically catastrophe-exposed. */
  catExposed: boolean;
  blurb: string;
  fields: ModelField[];
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

export const STRUCTURES: ModelStructure[] = [
  {
    key: 'QUOTA_SHARE',
    label: 'Quota Share',
    basis: 'PROPORTIONAL',
    blurb: 'Cedent and reinsurer share every risk in the portfolio in a fixed proportion.',
    fields: [
      { key: 'cessionPct', label: 'Cession', type: 'percent', unit: '%', group: 'Cession', required: true, help: 'Share of every risk ceded to the reinsurer.' },
      { key: 'maxCessionMinor', label: 'Max cession per risk', type: 'money', group: 'Cession', help: 'Monetary cap on the ceded share of any single risk.' },
      { key: 'commissionPct', label: 'Ceding commission', type: 'percent', unit: '%', group: 'Commission' },
      { key: 'profitCommissionPct', label: 'Profit commission', type: 'percent', unit: '%', group: 'Commission' },
      { key: 'eventLimitMinor', label: 'Event limit', type: 'money', group: 'Limits', help: 'Aggregate cap per catastrophe event, if any.' },
    ],
  },
  {
    key: 'SURPLUS',
    label: 'Surplus',
    basis: 'PROPORTIONAL',
    blurb: 'Reinsurer takes the surplus above the cedent’s retained line, in multiples of that line.',
    fields: [
      { key: 'retentionMinor', label: 'Cedent retention (line)', type: 'money', group: 'Structure', required: true, help: 'The cedent’s retained line; the treaty covers multiples of it.' },
      { key: 'numberOfLines', label: 'Number of lines', type: 'number', unit: 'lines', group: 'Structure', required: true },
      { key: 'maxLimitMinor', label: 'Maximum limit', type: 'money', group: 'Structure', help: 'retention × lines (the treaty’s top capacity).' },
      { key: 'commissionPct', label: 'Ceding commission', type: 'percent', unit: '%', group: 'Commission' },
      { key: 'profitCommissionPct', label: 'Profit commission', type: 'percent', unit: '%', group: 'Commission' },
    ],
  },
  {
    key: 'PER_RISK_XL',
    label: 'Per-Risk Excess of Loss',
    basis: 'NON_PROPORTIONAL',
    blurb: 'Protects the cedent’s retention on any single risk above an attachment point.',
    fields: [
      { key: 'attachmentMinor', label: 'Attachment (priority)', type: 'money', group: 'Layer', required: true },
      { key: 'limitMinor', label: 'Limit (cover)', type: 'money', group: 'Layer', required: true, help: 'Amount of cover above the attachment.' },
      { key: 'numberOfLayers', label: 'Number of layers', type: 'number', unit: 'layers', group: 'Layer' },
      { key: 'reinstatements', label: 'Reinstatements', type: 'number', group: 'Reinstatement' },
      { key: 'reinstatementPremiumPct', label: 'Reinstatement premium', type: 'percent', unit: '%', group: 'Reinstatement' },
      { key: 'rateOnLinePct', label: 'Rate on line', type: 'percent', unit: '%', group: 'Pricing', help: 'Premium as a % of the layer limit.' },
      { key: 'aggregateDeductibleMinor', label: 'Aggregate deductible', type: 'money', group: 'Pricing' },
    ],
  },
  {
    key: 'CAT_XL',
    label: 'Catastrophe Excess of Loss',
    basis: 'NON_PROPORTIONAL',
    blurb: 'Protects against accumulation from a single catastrophe event (quake, wind, flood).',
    fields: [
      { key: 'attachmentMinor', label: 'Attachment (priority)', type: 'money', group: 'Layer', required: true },
      { key: 'limitMinor', label: 'Limit (cover)', type: 'money', group: 'Layer', required: true },
      { key: 'peril', label: 'Peril covered', type: 'select', group: 'Peril', required: true,
        options: ['Earthquake', 'Windstorm', 'Flood', 'Wildfire', 'Severe convective storm', 'Multi-peril'] },
      { key: 'hoursClause', label: 'Hours clause', type: 'number', unit: 'hrs', group: 'Peril', help: 'Window in which losses aggregate to one event (e.g. 72h wind, 168h quake).' },
      { key: 'reinstatements', label: 'Reinstatements', type: 'number', group: 'Reinstatement' },
      { key: 'reinstatementPremiumPct', label: 'Reinstatement premium', type: 'percent', unit: '%', group: 'Reinstatement' },
      { key: 'rateOnLinePct', label: 'Rate on line', type: 'percent', unit: '%', group: 'Pricing' },
      { key: 'returnPeriodYears', label: 'Modelled return period', type: 'number', unit: 'yrs', group: 'Pricing', help: 'Return period the attachment corresponds to in the cat model.' },
    ],
  },
  {
    key: 'AGG_XL',
    label: 'Aggregate Excess of Loss',
    basis: 'NON_PROPORTIONAL',
    blurb: 'Protects the annual aggregate of losses above an aggregate attachment.',
    fields: [
      { key: 'aggAttachmentMinor', label: 'Aggregate attachment', type: 'money', group: 'Aggregate', required: true },
      { key: 'aggLimitMinor', label: 'Aggregate limit', type: 'money', group: 'Aggregate', required: true },
      { key: 'franchiseMinor', label: 'Per-loss franchise', type: 'money', group: 'Aggregate', help: 'Losses below the franchise do not erode the aggregate.' },
      { key: 'rateOnLinePct', label: 'Rate on line', type: 'percent', unit: '%', group: 'Pricing' },
    ],
  },
  {
    key: 'STOP_LOSS',
    label: 'Stop Loss',
    basis: 'NON_PROPORTIONAL',
    blurb: 'Caps the cedent’s annual loss ratio between an attachment and an exit loss ratio.',
    fields: [
      { key: 'attachmentLossRatioPct', label: 'Attachment loss ratio', type: 'percent', unit: '%', group: 'Loss ratio', required: true },
      { key: 'exitLossRatioPct', label: 'Exit loss ratio', type: 'percent', unit: '%', group: 'Loss ratio', required: true },
      { key: 'annualLimitMinor', label: 'Annual limit', type: 'money', group: 'Loss ratio' },
      { key: 'rateOnLinePct', label: 'Rate on line', type: 'percent', unit: '%', group: 'Pricing' },
    ],
  },
  {
    key: 'FAC_PROPORTIONAL',
    label: 'Facultative Proportional',
    basis: 'PROPORTIONAL',
    blurb: 'A single risk shared in proportion - written facultatively, risk by risk.',
    fields: [
      { key: 'cessionPct', label: 'Cession', type: 'percent', unit: '%', group: 'Cession', required: true },
      { key: 'sumInsuredMinor', label: 'Sum insured (100%)', type: 'money', group: 'Cession', required: true },
      { key: 'commissionPct', label: 'Ceding commission', type: 'percent', unit: '%', group: 'Commission' },
    ],
  },
  {
    key: 'FAC_XL',
    label: 'Facultative Excess of Loss',
    basis: 'NON_PROPORTIONAL',
    blurb: 'Excess-of-loss protection placed facultatively on a single named risk.',
    fields: [
      { key: 'attachmentMinor', label: 'Attachment (priority)', type: 'money', group: 'Layer', required: true },
      { key: 'limitMinor', label: 'Limit (cover)', type: 'money', group: 'Layer', required: true },
      { key: 'rateOnLinePct', label: 'Rate on line', type: 'percent', unit: '%', group: 'Pricing' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Lines of business
// ---------------------------------------------------------------------------

export const LINES_OF_BUSINESS: ModelLine[] = [
  {
    key: 'PROPERTY', label: 'Property', hazard: 3, catExposed: true,
    blurb: 'Fire, engineering perils and natural catastrophe on physical assets.',
    fields: [
      { key: 'totalInsuredValueMinor', label: 'Total insured value', type: 'money', group: 'Exposure', required: true },
      { key: 'construction', label: 'Construction', type: 'select', group: 'Exposure',
        options: ['Frame', 'Joisted masonry', 'Non-combustible', 'Masonry non-combustible', 'Fire resistive'] },
      { key: 'occupancy', label: 'Occupancy', type: 'text', group: 'Exposure' },
      { key: 'largestLocationMinor', label: 'Largest single location', type: 'money', group: 'Accumulation' },
      { key: 'natCatZone', label: 'Nat-cat zone', type: 'text', group: 'Accumulation', help: 'Peak-peril accumulation zone (e.g. FL Wind, JP Quake).' },
    ],
  },
  {
    key: 'CASUALTY', label: 'Casualty / Liability', hazard: 4, catExposed: false,
    blurb: 'Third-party liability - long-tail, sensitive to claims basis and aggregation.',
    fields: [
      { key: 'occurrenceLimitMinor', label: 'Occurrence limit', type: 'money', group: 'Limits', required: true },
      { key: 'aggregateLimitMinor', label: 'Aggregate limit', type: 'money', group: 'Limits' },
      { key: 'claimsBasis', label: 'Claims basis', type: 'select', group: 'Terms', options: ['Occurrence', 'Claims-made'], required: true },
      { key: 'tailYears', label: 'Expected tail', type: 'number', unit: 'yrs', group: 'Terms', help: 'Years to full development - drives reserving risk.' },
    ],
  },
  {
    key: 'ENGINEERING', label: 'Engineering (CAR/EAR)', hazard: 3, catExposed: true,
    blurb: 'Construction / erection all-risks on projects over a build and maintenance period.',
    fields: [
      { key: 'projectValueMinor', label: 'Project value', type: 'money', group: 'Project', required: true },
      { key: 'projectType', label: 'Project type', type: 'select', group: 'Project', options: ['Civil', 'Building', 'Power', 'Oil & gas', 'Infrastructure', 'Renewables'] },
      { key: 'constructionMonths', label: 'Construction period', type: 'number', unit: 'months', group: 'Period' },
      { key: 'maintenanceMonths', label: 'Maintenance period', type: 'number', unit: 'months', group: 'Period' },
    ],
  },
  {
    key: 'MARINE_HULL', label: 'Marine Hull', hazard: 3, catExposed: false,
    blurb: 'Physical damage to vessels and their machinery.',
    fields: [
      { key: 'vesselValueMinor', label: 'Vessel / fleet value', type: 'money', group: 'Exposure', required: true },
      { key: 'vesselType', label: 'Vessel type', type: 'select', group: 'Exposure', options: ['Tanker', 'Bulk carrier', 'Container', 'Passenger', 'Fishing', 'Offshore', 'Yacht'] },
      { key: 'fleetSize', label: 'Fleet size', type: 'number', unit: 'vessels', group: 'Exposure' },
      { key: 'navigationLimits', label: 'Navigation limits', type: 'text', group: 'Terms', help: 'Trading area / warranties.' },
    ],
  },
  {
    key: 'MARINE_CARGO', label: 'Marine Cargo', hazard: 2, catExposed: true,
    blurb: 'Goods in transit by sea, air or land.',
    fields: [
      { key: 'annualTurnoverMinor', label: 'Annual turnover', type: 'money', group: 'Exposure', required: true },
      { key: 'commodityType', label: 'Commodity', type: 'text', group: 'Exposure' },
      { key: 'conveyance', label: 'Conveyance', type: 'select', group: 'Exposure', options: ['Ocean', 'Air', 'Road', 'Rail', 'Multimodal'] },
      { key: 'maxTransitValueMinor', label: 'Max value per transit', type: 'money', group: 'Accumulation', help: 'Peak accumulation on a single conveyance / location.' },
    ],
  },
  {
    key: 'AVIATION', label: 'Aviation', hazard: 5, catExposed: false,
    blurb: 'Hull and liability on aircraft and aviation operations.',
    fields: [
      { key: 'hullValueMinor', label: 'Hull value', type: 'money', group: 'Exposure', required: true },
      { key: 'fleetValueMinor', label: 'Fleet value', type: 'money', group: 'Exposure' },
      { key: 'aircraftType', label: 'Aircraft type', type: 'select', group: 'Exposure', options: ['Airline', 'General aviation', 'Rotorwing', 'Cargo', 'Manufacturer'] },
      { key: 'passengerSeats', label: 'Passenger seats', type: 'number', unit: 'seats', group: 'Liability' },
      { key: 'warRisk', label: 'War / terror cover', type: 'boolean', group: 'Terms' },
    ],
  },
  {
    key: 'ENERGY', label: 'Energy', hazard: 5, catExposed: true,
    blurb: 'Onshore / offshore energy - physical damage and business interruption.',
    fields: [
      { key: 'assetValueMinor', label: 'Asset value', type: 'money', group: 'Exposure', required: true },
      { key: 'segment', label: 'Segment', type: 'select', group: 'Exposure', options: ['Upstream', 'Midstream', 'Downstream', 'Power', 'Renewables'] },
      { key: 'blowoutCover', label: 'Control-of-well cover', type: 'boolean', group: 'Terms' },
      { key: 'operator', label: 'Operator', type: 'text', group: 'Exposure' },
    ],
  },
  {
    key: 'AGRICULTURE', label: 'Agriculture', hazard: 3, catExposed: true,
    blurb: 'Crop and livestock - increasingly written on parametric / index bases.',
    fields: [
      { key: 'insuredArea', label: 'Insured area', type: 'number', unit: 'ha', group: 'Exposure', required: true },
      { key: 'cropType', label: 'Crop / livestock', type: 'text', group: 'Exposure' },
      { key: 'indexBasis', label: 'Index basis', type: 'select', group: 'Basis', options: ['Named peril', 'Yield index', 'Weather index', 'NDVI / satellite', 'Area-yield'] },
      { key: 'sumInsuredPerHectareMinor', label: 'Sum insured / hectare', type: 'money', group: 'Exposure' },
    ],
  },
  {
    key: 'CYBER', label: 'Cyber', hazard: 4, catExposed: true,
    blurb: 'Data breach, business interruption and cyber liability - systemic accumulation risk.',
    fields: [
      { key: 'aggregateLimitMinor', label: 'Aggregate limit', type: 'money', group: 'Limits', required: true },
      { key: 'retentionMinor', label: 'Retention', type: 'money', group: 'Limits' },
      { key: 'dataRecords', label: 'Records held', type: 'number', unit: 'records', group: 'Exposure' },
      { key: 'industrySector', label: 'Industry sector', type: 'text', group: 'Exposure' },
      { key: 'priorBreach', label: 'Prior breach', type: 'boolean', group: 'Underwriting' },
    ],
  },
  {
    key: 'FINANCIAL_LINES', label: 'Financial Lines', hazard: 4, catExposed: false,
    blurb: 'D&O, professional indemnity, crime and specie.',
    fields: [
      { key: 'policyType', label: 'Policy type', type: 'select', group: 'Cover', options: ['D&O', 'Professional indemnity', 'Crime', 'Specie', 'Transaction liability'], required: true },
      { key: 'limitMinor', label: 'Limit', type: 'money', group: 'Cover', required: true },
      { key: 'retentionMinor', label: 'Retention', type: 'money', group: 'Cover' },
      { key: 'revenueMinor', label: 'Insured revenue', type: 'money', group: 'Exposure' },
    ],
  },
  {
    key: 'LIFE', label: 'Life', hazard: 2, catExposed: false,
    blurb: 'Mortality / morbidity reinsurance on portfolios of lives.',
    fields: [
      { key: 'sumAtRiskMinor', label: 'Sum at risk', type: 'money', group: 'Exposure', required: true },
      { key: 'numberOfLives', label: 'Number of lives', type: 'number', unit: 'lives', group: 'Exposure', required: true },
      { key: 'mortalityBasis', label: 'Mortality basis', type: 'text', group: 'Basis', help: 'Standard table used (e.g. CSO, A67/70).' },
      { key: 'medicalUnderwriting', label: 'Medical underwriting', type: 'boolean', group: 'Basis' },
    ],
  },
  {
    key: 'HEALTH', label: 'Health', hazard: 2, catExposed: false,
    blurb: 'Medical expense and accident & health portfolios.',
    fields: [
      { key: 'numberOfLives', label: 'Number of lives', type: 'number', unit: 'lives', group: 'Exposure', required: true },
      { key: 'averageAge', label: 'Average age', type: 'number', unit: 'yrs', group: 'Exposure' },
      { key: 'benefitLimitMinor', label: 'Benefit limit / life', type: 'money', group: 'Cover' },
      { key: 'waitingPeriodMonths', label: 'Waiting period', type: 'number', unit: 'months', group: 'Terms' },
    ],
  },
  {
    key: 'MOTOR', label: 'Motor', hazard: 3, catExposed: false,
    blurb: 'Motor own-damage and third-party liability fleets.',
    fields: [
      { key: 'fleetSize', label: 'Fleet size', type: 'number', unit: 'vehicles', group: 'Exposure', required: true },
      { key: 'vehicleType', label: 'Vehicle type', type: 'select', group: 'Exposure', options: ['Private car', 'Commercial', 'Motorcycle', 'Public transport', 'Mixed fleet'] },
      { key: 'sumInsuredPerVehicleMinor', label: 'Sum insured / vehicle', type: 'money', group: 'Exposure' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Lookups & helpers
// ---------------------------------------------------------------------------

const STRUCTURE_BY_KEY = new Map(STRUCTURES.map((s) => [s.key, s]));
const LINE_BY_KEY = new Map(LINES_OF_BUSINESS.map((l) => [l.key, l]));

export function getStructure(key: string | null | undefined): ModelStructure | undefined {
  return key ? STRUCTURE_BY_KEY.get(key) : undefined;
}
export function getLine(key: string | null | undefined): ModelLine | undefined {
  return key ? LINE_BY_KEY.get(key) : undefined;
}

/** Every field an underwriter should capture for a given structure × line,
 *  structure terms first then line-specific exposure fields. */
export function modelFieldsFor(structureKey?: string | null, lineKey?: string | null): ModelField[] {
  const s = getStructure(structureKey);
  const l = getLine(lineKey);
  return [...(s?.fields ?? []), ...(l?.fields ?? [])];
}

export interface TermsValidation { ok: boolean; missing: string[]; unknown: string[]; }

/**
 * Validate a `terms` object against the fields a model expects. Returns which
 * required fields are missing and which supplied keys aren't part of the model
 * (informational - the server may still store them). Pure; does no coercion.
 */
export function validateTerms(
  structureKey: string | null | undefined,
  lineKey: string | null | undefined,
  terms: Record<string, unknown> | null | undefined,
): TermsValidation {
  const fields = modelFieldsFor(structureKey, lineKey);
  const t = terms ?? {};
  const known = new Set(fields.map((f) => f.key));
  const missing = fields
    .filter((f) => f.required)
    .filter((f) => t[f.key] === undefined || t[f.key] === null || t[f.key] === '')
    .map((f) => f.key);
  // Well-known non-model term keys the workbench stores alongside model terms.
  const reserved = new Set(['capacityUtilPct', 'notes']);
  const unknown = Object.keys(t).filter((k) => !known.has(k) && !reserved.has(k));
  return { ok: missing.length === 0, missing, unknown };
}

/** The full catalog, ready to serve to the client as JSON. */
export function modelCatalog(): { structures: ModelStructure[]; lines: ModelLine[] } {
  return { structures: STRUCTURES, lines: LINES_OF_BUSINESS };
}
