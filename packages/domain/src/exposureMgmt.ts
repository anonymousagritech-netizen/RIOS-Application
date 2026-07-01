/**
 * Exposure management - pure, deterministic, framework-free.
 *
 * Aggregation and accumulation control: given a register of exposure items (each
 * geolocated and tagged with peril and line of business, carrying a total insured
 * value and optional PML), roll them up by any dimension, find the peak
 * accumulations, build a heatmap matrix and measure concentration. Money is
 * integer minor units. No I/O.
 */

export interface ExposureItemInput {
  country?: string | null;
  admin1?: string | null;     // state / province
  city?: string | null;
  cresta?: string | null;
  peril?: string | null;
  lineOfBusiness?: string | null;
  tivMinor: number;
  pmlMinor?: number | null;
}

export type ExposureDimension = 'country' | 'admin1' | 'city' | 'cresta' | 'peril' | 'lineOfBusiness';

export interface ExposureBucket {
  key: string;
  items: number;
  tivMinor: number;
  pmlMinor: number;
  sharePct: number;           // share of total TIV
}

const dimValue = (it: ExposureItemInput, dim: ExposureDimension): string =>
  (it[dim] ?? 'Unknown') as string;

/** Aggregate exposure by a dimension, largest TIV first, with % share. */
export function aggregateExposure(items: ExposureItemInput[], dim: ExposureDimension): ExposureBucket[] {
  const total = items.reduce((a, it) => a + Math.max(0, it.tivMinor), 0);
  const map = new Map<string, { items: number; tiv: number; pml: number }>();
  for (const it of items) {
    const k = dimValue(it, dim);
    const cur = map.get(k) ?? { items: 0, tiv: 0, pml: 0 };
    cur.items += 1;
    cur.tiv += Math.max(0, it.tivMinor);
    cur.pml += Math.max(0, it.pmlMinor ?? 0);
    map.set(k, cur);
  }
  return [...map.entries()]
    .map(([key, v]) => ({ key, items: v.items, tivMinor: v.tiv, pmlMinor: v.pml, sharePct: total > 0 ? round1((v.tiv / total) * 100) : 0 }))
    .sort((a, b) => b.tivMinor - a.tivMinor);
}

export interface ExposureSummary {
  totalTivMinor: number;
  totalPmlMinor: number;
  itemCount: number;
  peakZone: ExposureBucket | null;      // largest CRESTA (or country) accumulation
  concentrationPct: number;             // top-zone share of TIV (accumulation risk)
  byCountry: ExposureBucket[];
  byPeril: ExposureBucket[];
  byLineOfBusiness: ExposureBucket[];
}

/** Book-level exposure summary with the peak accumulation zone. */
export function exposureSummary(items: ExposureItemInput[]): ExposureSummary {
  const totalTiv = items.reduce((a, it) => a + Math.max(0, it.tivMinor), 0);
  const totalPml = items.reduce((a, it) => a + Math.max(0, it.pmlMinor ?? 0), 0);
  // Peak accumulation uses CRESTA if present, else country.
  const hasCresta = items.some((it) => it.cresta);
  const zones = aggregateExposure(items, hasCresta ? 'cresta' : 'country');
  const peak = zones[0] ?? null;
  return {
    totalTivMinor: totalTiv,
    totalPmlMinor: totalPml,
    itemCount: items.length,
    peakZone: peak,
    concentrationPct: peak ? peak.sharePct : 0,
    byCountry: aggregateExposure(items, 'country'),
    byPeril: aggregateExposure(items, 'peril'),
    byLineOfBusiness: aggregateExposure(items, 'lineOfBusiness'),
  };
}

export interface HeatCell { row: string; col: string; tivMinor: number; }

/**
 * A heatmap matrix of TIV across two dimensions (e.g. peril × country). Returns
 * the ordered row/col keys and the populated cells for the UI to render.
 */
export function exposureHeatmap(items: ExposureItemInput[], rowDim: ExposureDimension, colDim: ExposureDimension): {
  rows: string[]; cols: string[]; cells: HeatCell[];
} {
  const rowSet = new Set<string>(), colSet = new Set<string>();
  const map = new Map<string, number>();
  for (const it of items) {
    const r = dimValue(it, rowDim), c = dimValue(it, colDim);
    rowSet.add(r); colSet.add(c);
    const key = `${r}||${c}`;
    map.set(key, (map.get(key) ?? 0) + Math.max(0, it.tivMinor));
  }
  const cells: HeatCell[] = [...map.entries()].map(([k, tiv]) => {
    const [row, col] = k.split('||');
    return { row: row!, col: col!, tivMinor: tiv };
  });
  return { rows: [...rowSet], cols: [...colSet], cells };
}

function round1(v: number): number { return Math.round(v * 10) / 10; }
