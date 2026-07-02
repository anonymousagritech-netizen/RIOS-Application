/**
 * Line-of-business field registry (metadata for the Dynamic Form Engine).
 *
 * Each class of business exposes only the risk fields it actually needs. Groups
 * are matched by keyword against the LOB code+label (case-insensitive) via each
 * group's `when` predicate, so a new code-list LOB value that contains the word
 * "Marine" automatically picks up the marine fields with no code change. Values
 * persist into a `classDetails` object on the entity's terms/details bag.
 *
 * Shared by every form that captures risk against a line of business (treaty,
 * facultative, claim FNOL, ...), so the same LOB shows the same fields everywhere.
 */
import type { FieldGroup, FormContext } from './formEngine';

/** A group `when` predicate that matches any of the given keywords in ctx.lob. */
const lob = (...keywords: string[]) => (ctx: FormContext): boolean => {
  const u = (ctx.lob ?? '').toUpperCase();
  return keywords.some((k) => u.includes(k));
};

export const LOB_CLASS_GROUPS: FieldGroup[] = [
  {
    id: 'property', title: 'Property risk details', description: 'Shown automatically for property business.',
    when: lob('PROPERTY', 'FIRE', 'ENGINEERING', 'PROP'),
    fields: [
      { key: 'construction', label: 'Construction', placeholder: 'e.g. Concrete / steel frame' },
      { key: 'occupancy', label: 'Occupancy', placeholder: 'e.g. Commercial / industrial' },
      { key: 'catPeril', label: 'CAT peril(s)', placeholder: 'e.g. Windstorm, Earthquake, Flood', maxLength: 200 },
      { key: 'pml', label: 'PML %', type: 'number', min: 0, max: 100, placeholder: 'e.g. 35', hint: 'Probable maximum loss' },
      { key: 'totalInsuredValue', label: 'Total insured value (TIV)', type: 'number', min: 0, placeholder: 'e.g. 250000000' },
    ],
  },
  {
    id: 'marine', title: 'Marine risk details', description: 'Shown automatically for marine business.',
    when: lob('MARINE', 'CARGO', 'HULL', 'MAT'),
    fields: [
      { key: 'cargo', label: 'Cargo type', placeholder: 'e.g. Containerised general goods' },
      { key: 'vessel', label: 'Vessel / hull', placeholder: 'e.g. Bulk carrier, 45,000 GT' },
      { key: 'port', label: 'Port(s)', placeholder: 'e.g. Rotterdam, Singapore' },
      {
        key: 'route', label: 'Voyage / route', placeholder: 'e.g. Rotterdam – Singapore',
        // Cross-field: once war risk is written into cover, the exposed voyage must be stated.
        validate: (v, ctx) => (ctx.warRisk === 'Included' && !v ? 'Voyage / route is required when war risk is included' : undefined),
      },
      { key: 'warRisk', label: 'War risk', type: 'select', required: true, options: ['Excluded', 'Included', 'Separate placement'] },
    ],
  },
  {
    id: 'aviation', title: 'Aviation risk details', description: 'Shown automatically for aviation business.',
    when: lob('AVIATION', 'AIRLINE', 'AEROSPACE', 'AVI'),
    fields: [
      { key: 'aircraft', label: 'Aircraft type', placeholder: 'e.g. Airbus A320 family' },
      { key: 'hullValue', label: 'Hull value', type: 'number', min: 0, placeholder: 'e.g. 45000000' },
      { key: 'airport', label: 'Airport(s)', placeholder: 'e.g. LHR, JFK' },
      { key: 'fleetSize', label: 'Fleet size', type: 'number', min: 0, placeholder: 'e.g. 120' },
    ],
  },
  {
    id: 'casualty', title: 'Casualty / liability details', description: 'Shown automatically for casualty and liability business.',
    when: lob('CASUALTY', 'LIABILITY', 'MOTOR_LIAB', 'GL', 'D&O', 'PROF'),
    fields: [
      { key: 'industry', label: 'Industry', placeholder: 'e.g. Manufacturing' },
      { key: 'revenue', label: 'Annual revenue', type: 'number', min: 0, placeholder: 'e.g. 500000000' },
      { key: 'employees', label: 'Employees', type: 'number', min: 0, placeholder: 'e.g. 5000' },
      { key: 'products', label: 'Products / activities', placeholder: 'e.g. Industrial machinery' },
    ],
  },
  {
    id: 'energy', title: 'Energy risk details', description: 'Shown automatically for energy business.',
    when: lob('ENERGY', 'OIL', 'GAS', 'POWER', 'OFFSHORE'),
    fields: [
      { key: 'platform', label: 'Platform / asset', placeholder: 'e.g. Fixed production platform' },
      { key: 'offshore', label: 'Onshore / offshore', type: 'select', options: ['Onshore', 'Offshore', 'Both'] },
      { key: 'wellType', label: 'Well type', placeholder: 'e.g. Deepwater, HPHT' },
      { key: 'pressure', label: 'Pressure / conditions', placeholder: 'e.g. High pressure / high temperature' },
    ],
  },
  {
    id: 'cyber', title: 'Cyber risk details', description: 'Shown automatically for cyber business.',
    when: lob('CYBER', 'TECH', 'DATA'),
    fields: [
      { key: 'industry', label: 'Industry', placeholder: 'e.g. Financial services' },
      { key: 'records', label: 'Records held', type: 'number', min: 0, placeholder: 'e.g. 2000000', hint: 'PII/PCI records exposed' },
      { key: 'cloud', label: 'Cloud posture', placeholder: 'e.g. AWS multi-region' },
      { key: 'security', label: 'Security controls', placeholder: 'e.g. MFA, EDR, SOC 2' },
    ],
  },
  {
    id: 'motor', title: 'Motor risk details', description: 'Shown automatically for motor business.',
    when: lob('MOTOR', 'AUTO', 'FLEET'),
    fields: [
      { key: 'vehicle', label: 'Vehicle type', placeholder: 'e.g. Commercial trucks' },
      { key: 'fleetSize', label: 'Fleet size', type: 'number', min: 0, placeholder: 'e.g. 350' },
      { key: 'region', label: 'Region of operation', placeholder: 'e.g. EU + UK' },
      { key: 'driver', label: 'Driver profile', placeholder: 'e.g. Professional, avg age 42' },
    ],
  },
  {
    id: 'crop', title: 'Crop / agriculture details', description: 'Shown automatically for crop and agriculture business.',
    when: lob('CROP', 'AGRI', 'YIELD', 'WEATHER', 'PARAMETRIC'),
    fields: [
      { key: 'crop', label: 'Crop', placeholder: 'e.g. Wheat, Rice' },
      { key: 'season', label: 'Season', placeholder: 'e.g. Kharif 2026' },
      { key: 'district', label: 'District / region', placeholder: 'e.g. Punjab' },
      { key: 'yield', label: 'Expected yield', type: 'number', min: 0, placeholder: 'e.g. 4200', hint: 'kg/ha' },
      { key: 'satellite', label: 'Satellite index', placeholder: 'e.g. NDVI threshold' },
      { key: 'weather', label: 'Weather trigger', placeholder: 'e.g. Rainfall < 400mm' },
    ],
  },
];
