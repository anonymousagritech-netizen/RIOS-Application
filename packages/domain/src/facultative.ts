/**
 * Facultative placement & quote analytics - pure, deterministic, framework-free.
 *
 * A facultative risk is placed by writing lines (lead / follow / coinsurance /
 * retro) that must sign down to 100% of the order. This module rolls the lines
 * into a placement view (written vs signed, complete / over / short) and picks
 * the best market quote for comparison. Money is integer minor units. No I/O.
 */

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export interface PlacementLine {
  writtenPct: number;
  signedPct: number;
  premiumMinor: number;
}

export interface PlacementResult {
  lineCount: number;
  writtenPct: number;      // sum of written shares
  signedPct: number;       // sum of signed shares (the placed order)
  premiumMinor: number;    // sum of line premiums
  shortfallPct: number;    // 100 − signed, floored at 0
  oversubscribedPct: number; // signed − 100, floored at 0
  status: 'UNPLACED' | 'PARTIAL' | 'COMPLETE' | 'OVERSUBSCRIBED';
}

/** Roll placement lines into a signed-down order view. */
export function facPlacement(lines: PlacementLine[]): PlacementResult {
  const written = round3(lines.reduce((a, l) => a + Math.max(0, l.writtenPct), 0));
  const signed = round3(lines.reduce((a, l) => a + Math.max(0, l.signedPct), 0));
  const premium = lines.reduce((a, l) => a + Math.max(0, l.premiumMinor), 0);
  const shortfall = round3(Math.max(0, 100 - signed));
  const over = round3(Math.max(0, signed - 100));
  const status: PlacementResult['status'] =
    signed <= 0 ? 'UNPLACED' : signed > 100 ? 'OVERSUBSCRIBED' : signed >= 100 ? 'COMPLETE' : 'PARTIAL';
  return { lineCount: lines.length, writtenPct: written, signedPct: signed, premiumMinor: premium, shortfallPct: shortfall, oversubscribedPct: over, status };
}

export interface Quote {
  id?: string;
  reinsurerName?: string | null;
  sharePct: number;
  premiumMinor: number;
  ratePct?: number | null;
  status?: string;
}

/**
 * Pick the most competitive live quote: lowest rate on line (premium ÷ share).
 * Declined/expired quotes are ignored. Returns null when there is nothing live.
 */
export function bestQuote(quotes: Quote[], sumInsuredMinor?: number): Quote | null {
  const live = quotes.filter((qt) => !['DECLINED', 'EXPIRED'].includes((qt.status ?? '').toUpperCase()));
  if (!live.length) return null;
  const cost = (qt: Quote): number => {
    if (qt.ratePct != null) return qt.ratePct;
    // Fall back to premium per 1% share, or per unit of exposure if given.
    if (sumInsuredMinor && qt.sharePct > 0) return qt.premiumMinor / ((qt.sharePct / 100) * sumInsuredMinor);
    return qt.sharePct > 0 ? qt.premiumMinor / qt.sharePct : Number.POSITIVE_INFINITY;
  };
  return live.reduce((best, qt) => (cost(qt) < cost(best) ? qt : best));
}

/** Average quoted rate across live quotes (for a market benchmark). */
export function averageQuotedRate(quotes: Quote[]): number {
  const rates = quotes
    .filter((qt) => qt.ratePct != null && !['DECLINED', 'EXPIRED'].includes((qt.status ?? '').toUpperCase()))
    .map((qt) => qt.ratePct as number);
  if (!rates.length) return 0;
  return round3(rates.reduce((a, r) => a + r, 0) / rates.length);
}
