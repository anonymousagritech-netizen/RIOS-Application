/**
 * Immutable, tamper-evident audit writer (brief §14.3).
 *
 * Each entry hashes (prev_hash ‖ canonical payload), forming a per-tenant chain.
 * Any retroactive edit breaks the chain and is detectable. The app role has no
 * UPDATE/DELETE on audit_log (db migration 0008), so this is append-only.
 */

import { createHash } from 'node:crypto';
import type { Db } from './db.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  actorLabel?: string;
  context?: Record<string, unknown>;
}

export async function writeAudit(
  db: Db,
  ctx: { tenantId: string; userId: string | null },
  entry: AuditEntry,
): Promise<void> {
  // Serialise appends per tenant so the "read latest hash → insert" is atomic:
  // without this, concurrent writers can read the same tip and fork the chain.
  // pg_advisory_xact_lock releases automatically at the end of the caller's tx.
  await db.query(`select pg_advisory_xact_lock(hashtext($1))`, [`audit:${ctx.tenantId}`]);

  const prev = await db.query<{ row_hash: Buffer | null }>(
    `select row_hash from audit_log where tenant_id = $1 order by id desc limit 1`,
    [ctx.tenantId],
  );
  const prevHash = prev.rows[0]?.row_hash ?? null;

  const canonical = JSON.stringify({
    tenantId: ctx.tenantId,
    actor: ctx.userId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
  const hash = createHash('sha256');
  if (prevHash) hash.update(prevHash);
  hash.update(canonical);
  const rowHash = hash.digest();

  await db.query(
    `insert into audit_log
       (tenant_id, actor_user_id, actor_label, action, entity_type, entity_id, before, after, context, prev_hash, row_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      ctx.tenantId,
      ctx.userId,
      entry.actorLabel ?? null,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.before ? JSON.stringify(entry.before) : null,
      entry.after ? JSON.stringify(entry.after) : null,
      JSON.stringify(entry.context ?? {}),
      prevHash,
      rowHash,
    ],
  );
}
