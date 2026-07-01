/**
 * Tiny CSV helper for server-side exports (Excel-openable). RFC-4180 quoting.
 * Money is emitted from integer minor units → major with 2 decimals.
 */

export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function majorFromMinor(minor: number | string | null | undefined): string {
  if (minor === null || minor === undefined || minor === '') return '';
  return (Number(minor) / 100).toFixed(2);
}

/** Build a CSV string from a header row and value rows. */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvEscape).join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  return lines.join('\n');
}
