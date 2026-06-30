/**
 * Database access with per-request tenant context.
 *
 * The application pool connects as the low-privilege `rios_app` role. Every
 * tenant-scoped operation runs inside a transaction that sets `app.tenant_id`
 * and `app.user_id` as LOCAL settings, so the RLS policies (db migration 0008)
 * restrict all rows to the active tenant. This is the data-layer half of the
 * zero-trust posture in brief §14.2 / §14.5 — isolation is enforced by the
 * database, not merely by application WHERE clauses.
 */

import pg from 'pg';
import { config } from './config.js';

// Postgres returns BIGINT as a string by default to avoid precision loss. Our
// money is integer minor units that fit safely in a JS number for realistic
// magnitudes; parse bigint to number at the boundary and rely on Money math.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8 / bigint
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric

export const appPool = new pg.Pool({ connectionString: config.databaseAppUrl, max: 10 });
export const ownerPool = new pg.Pool({ connectionString: config.databaseUrl, max: 4 });

export type TenantContext = { tenantId: string; userId: string | null };

export interface Db {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

/**
 * Run `fn` inside a transaction bound to a tenant (and optionally a user).
 * All queries issued through the provided Db see only that tenant's rows.
 */
export async function runAs<T>(
  ctx: TenantContext,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('begin');
    // set_config(..., true) => LOCAL to this transaction; cannot leak across pooled connections.
    await client.query('select set_config($1, $2, true), set_config($3, $4, true)', [
      'app.tenant_id',
      ctx.tenantId,
      'app.user_id',
      ctx.userId ?? '',
    ]);
    const db: Db = { query: (text, params) => client.query(text, params as never) };
    const result = await fn(db);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** Owner-level query for platform operations that must bypass RLS (login lookup, migrations). */
export async function ownerQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return ownerPool.query<T>(text, params as never);
}

export async function closePools(): Promise<void> {
  await Promise.all([appPool.end(), ownerPool.end()]);
}
