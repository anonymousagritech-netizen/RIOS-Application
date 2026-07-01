/**
 * Cash-flow & liquidity projection (brief §9.8, §16).
 *
 * Roll a cash balance forward across periods from expected inflows (premium,
 * recoveries, investment income) and outflows (claims, commission, expenses,
 * dividends), surfacing the running balance, the minimum balance, any liquidity
 * shortfall and a stressed view. Pure, integer-exact minor units.
 */

export interface CashFlowPeriod {
  label: string;
  inflowsMinor: number;
  outflowsMinor: number;
}

export interface ProjectedPeriod {
  label: string;
  openingMinor: number;
  inflowsMinor: number;
  outflowsMinor: number;
  netMinor: number;
  closingMinor: number;
  shortfall: boolean;
}

export interface CashFlowProjection {
  periods: ProjectedPeriod[];
  closingMinor: number;
  minClosingMinor: number;
  /** Labels of periods that end with a negative balance. */
  shortfallPeriods: string[];
  totalInflowsMinor: number;
  totalOutflowsMinor: number;
}

/** Roll opening cash forward across the supplied periods. */
export function projectCashFlow(openingMinor: number, periods: CashFlowPeriod[]): CashFlowProjection {
  const out: ProjectedPeriod[] = [];
  let balance = openingMinor;
  let minClosing = openingMinor;
  let totalIn = 0, totalOut = 0;
  const shortfalls: string[] = [];

  for (const p of periods) {
    const opening = balance;
    const net = p.inflowsMinor - p.outflowsMinor;
    balance = opening + net;
    totalIn += p.inflowsMinor;
    totalOut += p.outflowsMinor;
    if (balance < minClosing) minClosing = balance;
    const shortfall = balance < 0;
    if (shortfall) shortfalls.push(p.label);
    out.push({
      label: p.label,
      openingMinor: opening,
      inflowsMinor: p.inflowsMinor,
      outflowsMinor: p.outflowsMinor,
      netMinor: net,
      closingMinor: balance,
      shortfall,
    });
  }

  return {
    periods: out,
    closingMinor: balance,
    minClosingMinor: minClosing,
    shortfallPeriods: shortfalls,
    totalInflowsMinor: totalIn,
    totalOutflowsMinor: totalOut,
  };
}

export interface LiquidityStress {
  /** Haircut applied to every inflow (e.g. 0.2 = receive 20% less / later). */
  inflowHaircut?: number;
  /** Uplift applied to every outflow (e.g. 0.15 = pay 15% more, e.g. a cat). */
  outflowUplift?: number;
}

/**
 * Re-project under a liquidity stress: inflows are haircut and outflows uplifted.
 * Returns the stressed projection so the base and stressed minimum balances can
 * be compared against the liquidity buffer.
 */
export function stressCashFlow(openingMinor: number, periods: CashFlowPeriod[], stress: LiquidityStress): CashFlowProjection {
  const hc = stress.inflowHaircut ?? 0;
  const up = stress.outflowUplift ?? 0;
  const stressed = periods.map((p) => ({
    label: p.label,
    inflowsMinor: Math.round(p.inflowsMinor * (1 - hc)),
    outflowsMinor: Math.round(p.outflowsMinor * (1 + up)),
  }));
  return projectCashFlow(openingMinor, stressed);
}
