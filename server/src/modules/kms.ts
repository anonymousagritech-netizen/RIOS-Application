/**
 * Key management (brief §14.2). Envelope encryption: a per-alias data-encryption
 * key (DEK) is generated, wrapped by a master key and stored wrapped - the raw
 * DEK is never persisted. Encrypt/decrypt unwrap the DEK in memory and use
 * AES-256-GCM. The dev master key is derived from JWT_SECRET; production injects
 * a managed HSM/KMS master key (docs/open-questions.md). admin:manage only.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

/** 32-byte master key (dev: derived from JWT_SECRET; prod: managed KMS). */
function masterKey(): Buffer {
  return crypto.createHash('sha256').update(`${config.jwtSecret}:kms-master`).digest();
}

/** AES-256-GCM seal → base64(iv | authTag | ciphertext). */
function seal(key: Buffer, plaintext: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/** Reverse of seal. */
function open(key: Buffer, packed: string): Buffer {
  const buf = Buffer.from(packed, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

const cryptoSchema = z.object({ alias: z.string().min(1), data: z.string().min(1) });

export async function kmsModule(app: FastifyInstance): Promise<void> {
  app.get('/api/kms/keys', { preHandler: requirePermission('admin:manage') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, alias, version, algorithm, status, created_at as "createdAt"
           from kms_key order by alias, version desc`,
      );
      return { keys: rows };
    });
  });

  // Create a new wrapped DEK for an alias (or a rotated version).
  app.post<{ Body: { alias: string } }>('/api/kms/keys', { preHandler: requirePermission('admin:manage') }, async (req, reply) => {
    const ctx = authContext(req);
    const alias = (req.body?.alias ?? '').trim();
    if (!alias) { reply.code(400); return { error: 'alias is required' }; }
    const dek = crypto.randomBytes(32);
    const wrapped = seal(masterKey(), dek);
    return runAs(ctx, async (db) => {
      const v = await db.query<{ v: number }>(`select coalesce(max(version),0)+1 as v from kms_key where alias = $1`, [alias]);
      if (v.rows[0]!.v > 1) {
        await db.query(`update kms_key set status='rotated' where alias=$1 and status='active'`, [alias]);
      }
      const { rows } = await db.query<{ id: string }>(
        `insert into kms_key (tenant_id, alias, version, wrapped_key, status) values ($1,$2,$3,$4,'active') returning id`,
        [ctx.tenantId, alias, v.rows[0]!.v, wrapped],
      );
      await writeAudit(db, ctx, { action: 'create_key', entityType: 'kms_key', entityId: rows[0]!.id, after: { alias, version: v.rows[0]!.v }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { id: rows[0]!.id, alias, version: v.rows[0]!.v };
    });
  });

  app.post('/api/kms/encrypt', { preHandler: requirePermission('admin:manage') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = cryptoSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'alias and data are required' }; }
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ wrapped_key: string }>(`select wrapped_key from kms_key where alias=$1 and status='active'`, [parsed.data.alias]);
      if (!rows[0]) { reply.code(404); return { error: 'Active key not found' }; }
      const dek = open(masterKey(), rows[0].wrapped_key);
      return { alias: parsed.data.alias, ciphertext: seal(dek, Buffer.from(parsed.data.data, 'utf8')) };
    });
  });

  app.post('/api/kms/decrypt', { preHandler: requirePermission('admin:manage') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = cryptoSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'alias and data are required' }; }
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ wrapped_key: string }>(`select wrapped_key from kms_key where alias=$1 and status='active'`, [parsed.data.alias]);
      if (!rows[0]) { reply.code(404); return { error: 'Active key not found' }; }
      const dek = open(masterKey(), rows[0].wrapped_key);
      try {
        return { alias: parsed.data.alias, plaintext: open(dek, parsed.data.data).toString('utf8') };
      } catch {
        reply.code(400);
        return { error: 'Decryption failed (wrong key or corrupted ciphertext)' };
      }
    });
  });
}
