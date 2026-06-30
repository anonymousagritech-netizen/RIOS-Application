/**
 * Localization & translation (brief §19). Pure helpers for resolving a message
 * bundle for a locale with fallback, interpolating placeholders, and deciding
 * text direction. The server stores locale_message rows; this module assembles
 * and resolves them. No I/O.
 */

/** Right-to-left base languages (by primary subtag). */
const RTL = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'dv', 'sd', 'yi']);

/** Text direction for a locale tag (e.g. 'ar-EG' → 'rtl'). */
export function direction(locale: string): 'ltr' | 'rtl' {
  const primary = (locale ?? '').toLowerCase().split('-')[0]!;
  return RTL.has(primary) ? 'rtl' : 'ltr';
}

/**
 * Build a resolved bundle for `locale`, falling back to `fallback` for any key
 * the locale does not define. Both inputs are flat key→string maps.
 */
export function resolveBundle(
  locale: Record<string, string>,
  fallback: Record<string, string>,
): Record<string, string> {
  return { ...(fallback ?? {}), ...(locale ?? {}) };
}

/** Interpolate {name} placeholders in a message from a params map. Unknown keys are left intact. */
export function interpolate(message: string, params?: Record<string, unknown>): string {
  if (!params) return message;
  return (message ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

/** Translate a key against a resolved bundle, with interpolation; falls back to the key itself. */
export function translate(bundle: Record<string, string>, key: string, params?: Record<string, unknown>): string {
  const msg = (bundle ?? {})[key];
  return msg == null ? key : interpolate(msg, params);
}
