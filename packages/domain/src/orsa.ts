/**
 * ORSA capital projection (brief §18.2, Pillar 2).
 *
 * A transparent, multi-year projection of own funds against the SCR - the
 * quantitative backbone of the Own Risk & Solvency Assessment. Each year rolls
 * own funds forward (result net of dividend and capital actions) and applies a
 * projected SCR, yielding the solvency ratio, headroom and the first breach
 * year. A stress scenario can shock both own funds and the SCR. Pure and
 * unit-tested; composes `@rios/domain/solvency2`.
 */

export interface OrsaYearInput {
  /** Projected profit/loss added to own funds (can be negative). */
  resultMinor: number;
  /** Dividends / capital returned (reduces own funds). */
  dividendMinor?: number;
  /** Capital raised / injected (increases own funds). */
  capitalActionMinor?: number;
  /** Projected SCR for the year. */
  scrMinor: number;
}

export interface OrsaProjectionInput {
  openingOwnFundsMinor: number;
  years: OrsaYearInput[];
  /** Board risk-appetite floor for the solvency ratio (e.g. 1.3 = 130%). */
  appetiteRatio?: number;
}

export interface OrsaYear {
  year: number;
  ownFundsMinor: number;
  scrMinor: number;
  /** Own funds / SCR. */
  solvencyRatio: number;
  /** Own funds - SCR (capital headroom). */
  surplusMinor: number;
  /** True when the ratio falls below 100% (SCR breach). */
  scrBreach: boolean;
  /** True when the ratio falls below the board appetite. */
  appetiteBreach: boolean;
}

export interface OrsaProjectionResult {
  years: OrsaYear[];
  /** First projection year (1-based) where own funds < SCR, or null. */
  firstBreachYear: number | null;
  /** Lowest solvency ratio across the horizon. */
  minSolvencyRatio: number;
  closingOwnFundsMinor: number;
}

/**
 * Roll own funds forward year by year and compare to the projected SCR. Own
 * funds move by result minus dividend plus capital actions; the solvency ratio,
 * surplus and breach flags are recorded each year.
 */
export function projectOrsa(input: OrsaProjectionInput): OrsaProjectionResult {
  const appetite = input.appetiteRatio ?? 1;
  let ownFunds = input.openingOwnFundsMinor;
  let firstBreachYear: number | null = null;
  let minRatio = Number.POSITIVE_INFINITY;
  const years: OrsaYear[] = [];

  input.years.forEach((y, i) => {
    ownFunds += y.resultMinor - (y.dividendMinor ?? 0) + (y.capitalActionMinor ?? 0);
    const ratio = y.scrMinor > 0 ? ownFunds / y.scrMinor : Number.POSITIVE_INFINITY;
    const scrBreach = ownFunds < y.scrMinor;
    if (scrBreach && firstBreachYear === null) firstBreachYear = i + 1;
    if (ratio < minRatio) minRatio = ratio;
    years.push({
      year: i + 1,
      ownFundsMinor: ownFunds,
      scrMinor: y.scrMinor,
      solvencyRatio: Math.round(ratio * 1000) / 1000,
      surplusMinor: ownFunds - y.scrMinor,
      scrBreach,
      appetiteBreach: ratio < appetite,
    });
  });

  return {
    years,
    firstBreachYear,
    minSolvencyRatio: years.length ? Math.round(minRatio * 1000) / 1000 : Number.POSITIVE_INFINITY,
    closingOwnFundsMinor: ownFunds,
  };
}

export interface OrsaStress {
  /** Fractional shock to own funds each year (e.g. -0.15 = -15%). */
  ownFundsShock?: number;
  /** Fractional shock to the SCR each year (e.g. 0.25 = +25%). */
  scrShock?: number;
  /** One-off additional loss to opening own funds. */
  openingLossMinor?: number;
}

/**
 * Apply a stress scenario to an ORSA base case and re-project: opening own funds
 * take a one-off loss, and each year's result and SCR are shocked. Returns the
 * stressed projection for comparison against the base case.
 */
export function stressOrsa(base: OrsaProjectionInput, stress: OrsaStress): OrsaProjectionResult {
  const ofShock = stress.ownFundsShock ?? 0;
  const scrShock = stress.scrShock ?? 0;
  const stressed: OrsaProjectionInput = {
    openingOwnFundsMinor: input0(base.openingOwnFundsMinor, stress.openingLossMinor),
    appetiteRatio: base.appetiteRatio,
    years: base.years.map((y) => ({
      resultMinor: Math.round(y.resultMinor * (1 + ofShock)),
      dividendMinor: y.dividendMinor,
      capitalActionMinor: y.capitalActionMinor,
      scrMinor: Math.round(y.scrMinor * (1 + scrShock)),
    })),
  };
  return projectOrsa(stressed);
}

function input0(opening: number, loss?: number): number {
  return opening - (loss ?? 0);
}
