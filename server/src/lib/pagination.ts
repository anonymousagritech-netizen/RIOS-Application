/**
 * Server-side pagination helpers (G-04).
 *
 * Implements keyset pagination with an opaque base64url cursor that encodes
 * (createdAt, id). Each list route selects these fields from its query,
 * encodes a cursor from the last row, and uses parameterised SQL to apply
 * the WHERE filter on the next request — no string interpolation of user data.
 */

export interface PageOpts {
  limit: number;
  cursor?: string;
}

/**
 * Parse and validate `limit` and `cursor` from a Fastify query object.
 * limit is clamped to [1, 200]; defaults to 50.
 */
export function parsePaginationQuery(query: Record<string, unknown>): PageOpts {
  const raw = Number(query.limit ?? 50);
  const limit = Math.min(Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : 50), 200);
  const cursor = typeof query.cursor === 'string' && query.cursor ? query.cursor : undefined;
  return { limit, cursor };
}

/**
 * Encode the last row's position as an opaque base64url cursor.
 * `createdAt` is an ISO-8601 / PostgreSQL timestamp string; `id` is a UUID string.
 * Neither contains a comma, so "," is a safe separator.
 */
export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt},${id}`).toString('base64url');
}

/**
 * Decode a cursor produced by encodeCursor.
 * Returns null if the cursor is malformed (so callers can ignore bad cursors
 * and fall back to the first page rather than throwing).
 */
export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf(',');
    if (sep === -1) return null;
    const createdAt = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    return createdAt && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}
