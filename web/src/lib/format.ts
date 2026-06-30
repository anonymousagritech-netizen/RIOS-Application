/** Money & display formatting helpers. */

const MINOR_UNITS: Record<string, number> = {
  USD: 2, EUR: 2, GBP: 2, CHF: 2, AUD: 2, CAD: 2, SGD: 2, HKD: 2,
  JPY: 0, KRW: 0,
  BHD: 3, KWD: 3,
};

export function minorUnitsFor(currency: string): number {
  return MINOR_UNITS[currency?.toUpperCase()] ?? 2;
}

/** Convert integer minor units to a localized currency string. */
export function formatMoney(amountMinor: number | null | undefined, currency = 'USD'): string {
  const minor = minorUnitsFor(currency);
  const value = (amountMinor ?? 0) / Math.pow(10, minor);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: minor,
      maximumFractionDigits: minor,
    }).format(value);
  } catch {
    return `${value.toLocaleString()} ${currency}`;
  }
}

/** Compact money for KPI cards (e.g. $1.2M). */
export function formatMoneyCompact(amountMinor: number | null | undefined, currency = 'USD'): string {
  const minor = minorUnitsFor(currency);
  const value = (amountMinor ?? 0) / Math.pow(10, minor);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    return `${value.toLocaleString()} ${currency}`;
  }
}

export function formatNumber(n: number | null | undefined): string {
  return new Intl.NumberFormat().format(n ?? 0);
}

export function formatPercent(value: number | null | undefined, fractionDigits = 2): string {
  if (value == null) return '—';
  // Values may arrive as fractions (0.25) or whole percentages (25). Heuristic:
  const pct = value <= 1 ? value * 100 : value;
  return `${pct.toFixed(fractionDigits).replace(/\.?0+$/, '')}%`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function titleCase(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
