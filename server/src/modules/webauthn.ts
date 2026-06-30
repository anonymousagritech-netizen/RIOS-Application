/**
 * WebAuthn / passkeys (brief §14.1). Completes the authentication surface beyond
 * TOTP/OIDC/SAML: the registration and authentication *ceremonies* (challenge
 * issuance, credential registry, sign-count tracking) are implemented and tested.
 * Full attestation/assertion signature verification needs a WebAuthn library and
 * a real authenticator/browser - wired at deployment (docs/open-questions.md).
 * Self-service: an authenticated user manages their own passkeys.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const RP = { name: 'RIOS', id: 'rios' };

const finishSchema = z.object({
  credentialId: z.string().min(1),
  publicKey: z.string().min(1),
  transports: z.string().optional(),
  label: z.string().optional(),
});

export async function webauthnModule(app: FastifyInstance): Promise<void> {
  // Begin registration: issue a challenge + the parameters the authenticator needs.
  app.post('/api/auth/webauthn/register/begin', { preHandler: requirePermission() }, async (req) => {
    const challenge = crypto.randomBytes(32).toString('base64url');
    return {
      challenge,
      rp: RP,
      user: { id: req.auth!.id, name: req.auth!.email, displayName: req.auth!.displayName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      timeout: 60000,
      attestation: 'none',
    };
  });

  // Finish registration: store the credential returned by the authenticator.
  app.post('/api/auth/webauthn/register/finish', { preHandler: requirePermission() }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = finishSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid credential', details: parsed.error.flatten() }; }
    const c = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into webauthn_credential (tenant_id, user_id, credential_id, public_key, transports, label)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (tenant_id, credential_id) do update set public_key = excluded.public_key
         returning id`,
        [ctx.tenantId, ctx.userId, c.credentialId, c.publicKey, c.transports ?? null, c.label ?? 'Passkey'],
      );
      await writeAudit(db, ctx, { action: 'register_passkey', entityType: 'webauthn_credential', entityId: rows[0]!.id, after: { label: c.label ?? 'Passkey' }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // List the current user's passkeys.
  app.get('/api/auth/webauthn/credentials', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, label, credential_id as "credentialId", sign_count as "signCount",
                created_at as "createdAt", last_used_at as "lastUsedAt"
           from webauthn_credential where user_id = $1 order by created_at desc`,
        [ctx.userId],
      );
      return { credentials: rows };
    });
  });

  // Begin authentication: challenge + the user's allowed credentials.
  app.post('/api/auth/webauthn/authenticate/begin', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    const challenge = crypto.randomBytes(32).toString('base64url');
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ credential_id: string; transports: string | null }>(
        `select credential_id, transports from webauthn_credential where user_id = $1`, [ctx.userId],
      );
      return {
        challenge, timeout: 60000, rpId: RP.id,
        allowCredentials: rows.map((r) => ({ type: 'public-key', id: r.credential_id, transports: r.transports ? [r.transports] : undefined })),
      };
    });
  });

  app.post<{ Params: { id: string } }>('/api/auth/webauthn/credentials/:id', { preHandler: requirePermission() }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rowCount } = await db.query(`delete from webauthn_credential where id = $1 and user_id = $2`, [req.params.id, ctx.userId]);
      if (!rowCount) { reply.code(404); return { error: 'Passkey not found' }; }
      await writeAudit(db, ctx, { action: 'remove_passkey', entityType: 'webauthn_credential', entityId: req.params.id, actorLabel: req.auth?.displayName });
      return { id: req.params.id, removed: true };
    });
  });
}
