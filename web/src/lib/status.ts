/** Maps status / code values to accent token names using code-list meta.color,
    with sensible fallbacks keyed by well-known status strings. */

export type TokenColor =
  | 'green' | 'blue' | 'amber' | 'violet' | 'slate' | 'red'
  | 'teal' | 'indigo' | 'orange' | 'rose' | 'gray';

const FALLBACK: Record<string, TokenColor> = {
  DRAFT: 'slate',
  QUOTED: 'blue',
  PLACING: 'amber',
  BOUND: 'indigo',
  ACTIVE: 'green',
  EXPIRING: 'orange',
  RUNOFF: 'violet',
  COMMUTED: 'teal',
  CANCELLED: 'red',
  // claims
  OPEN: 'amber',
  NOTIFIED: 'blue',
  RESERVED: 'indigo',
  PAID: 'teal',
  CLOSED: 'slate',
  REOPENED: 'orange',
  // statements
  POSTED: 'green',
  RECONCILED: 'green',
  UNPOSTED: 'slate',
  DRAFTED: 'slate',
};

/** Look up a token colour for a status given the loaded code lists' meta. */
export function colorForStatus(
  status: string | null | undefined,
  metaColors?: Record<string, string>,
): TokenColor {
  if (!status) return 'gray';
  const key = status.toUpperCase();
  const fromMeta = metaColors?.[status] ?? metaColors?.[key];
  if (fromMeta && isTokenColor(fromMeta)) return fromMeta;
  return FALLBACK[key] ?? 'gray';
}

export function isTokenColor(v: string): v is TokenColor {
  return ['green', 'blue', 'amber', 'violet', 'slate', 'red', 'teal', 'indigo', 'orange', 'rose', 'gray'].includes(v);
}

/** Legal lifecycle transitions for a treaty (mirrors the API contract). */
export const TREATY_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['QUOTED', 'PLACING', 'CANCELLED'],
  QUOTED: ['PLACING', 'BOUND', 'CANCELLED'],
  PLACING: ['BOUND', 'CANCELLED'],
  BOUND: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['EXPIRING', 'RUNOFF', 'COMMUTED', 'CANCELLED'],
};

export function legalTransitions(status: string | null | undefined): string[] {
  if (!status) return [];
  return TREATY_TRANSITIONS[status.toUpperCase()] ?? [];
}
