/**
 * Security module: MFA enrollment/management and federated SSO (OIDC).
 * Brief §14.1 (MFA enforced by policy; SSO via OAuth2/OIDC, Azure AD, …).
 *
 * MFA management runs in the authenticated user's tenant context (RLS). The SSO
 * authorize/callback endpoints are pre-authentication, so they use the owner
 * connection to read provider config and create the session, exactly like login.
 * The OIDC flow uses authorization-code + PKCE (S256) with a signed, short-lived
 * state token; the token exchange and id_token decode happen server-side.
 */

import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { runAs } from '../db.js';
import { ownerQuery } from '../db.js';
import { config } from '../config.js';
import { authContext, authenticate, requirePermission, buildSession, AuthError } from '../auth.js';
import { writeAudit } from '../audit.js';
import { generateSecret, otpauthUri, verifyTotp } from '../auth/totp.js';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function securityModule(app: FastifyInstance): Promise<void> {
  // -----------------------------------------------------------------------
  // MFA management (authenticated user, own credential)
  // -----------------------------------------------------------------------
  app.get('/api/auth/mfa/status', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const r = await db.query<{ enabled: boolean }>(
        `select enabled from mfa_credential where user_id = $1 and type = 'totp'`,
        [ctx.userId],
      );
      return { enabled: r.rows[0]?.enabled ?? false, enrolled: r.rows.length > 0 };
    });
  });

  // Begin enrollment: generate a secret + otpauth URI (not yet enabled).
  app.post('/api/auth/mfa/enroll', { preHandler: requirePermission() }, async (req) => {
    const user = await authenticate(req);
    const ctx = authContext(req);
    const secret = generateSecret();
    const uri = otpauthUri({ secret, account: user.email, issuer: 'RIOS' });
    return runAs(ctx, async (db) => {
      await db.query(
        `insert into mfa_credential (tenant_id, user_id, type, secret, enabled)
         values ($1,$2,'totp',$3,false)
         on conflict (user_id, type) do update set secret = excluded.secret, enabled = false, verified_at = null`,
        [ctx.tenantId, ctx.userId, secret],
      );
      await writeAudit(db, ctx, { action: 'mfa_enroll', entityType: 'mfa_credential', entityId: ctx.userId, actorLabel: user.displayName });
      return { secret, otpauthUri: uri };
    });
  });

  // Confirm enrollment by verifying a code, then enable MFA.
  app.post<{ Body: { code: string } }>('/api/auth/mfa/verify', { preHandler: requirePermission() }, async (req, reply) => {
    const user = await authenticate(req);
    const ctx = authContext(req);
    const code = String(req.body?.code ?? '');
    return runAs(ctx, async (db) => {
      const r = await db.query<{ secret: string }>(`select secret from mfa_credential where user_id = $1 and type = 'totp'`, [ctx.userId]);
      if (!r.rows[0]) {
        reply.code(400);
        return { error: 'Start enrollment first' };
      }
      if (!verifyTotp(r.rows[0].secret, code, Date.now())) {
        reply.code(400);
        return { error: 'Invalid code - check your authenticator and try again' };
      }
      await db.query(`update mfa_credential set enabled = true, verified_at = now() where user_id = $1 and type = 'totp'`, [ctx.userId]);
      await writeAudit(db, ctx, { action: 'mfa_enable', entityType: 'mfa_credential', entityId: ctx.userId, actorLabel: user.displayName });
      return { enabled: true };
    });
  });

  // Disable MFA (requires a current code as proof of possession).
  app.post<{ Body: { code: string } }>('/api/auth/mfa/disable', { preHandler: requirePermission() }, async (req, reply) => {
    const user = await authenticate(req);
    const ctx = authContext(req);
    const code = String(req.body?.code ?? '');
    return runAs(ctx, async (db) => {
      const r = await db.query<{ secret: string; enabled: boolean }>(`select secret, enabled from mfa_credential where user_id = $1 and type = 'totp'`, [ctx.userId]);
      if (!r.rows[0]?.enabled) {
        reply.code(400);
        return { error: 'MFA is not enabled' };
      }
      if (!verifyTotp(r.rows[0].secret, code, Date.now())) {
        reply.code(400);
        return { error: 'Invalid code' };
      }
      await db.query(`delete from mfa_credential where user_id = $1 and type = 'totp'`, [ctx.userId]);
      await writeAudit(db, ctx, { action: 'mfa_disable', entityType: 'mfa_credential', entityId: ctx.userId, actorLabel: user.displayName });
      return { enabled: false };
    });
  });

  // -----------------------------------------------------------------------
  // SSO provider configuration (admin)
  // -----------------------------------------------------------------------
  app.get('/api/auth/sso/providers', { preHandler: requirePermission('admin:manage') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const r = await db.query(
        `select key, name, type, issuer, client_id as "clientId", scopes, match_claim as "matchClaim", enabled
           from identity_provider order by name`,
      );
      return { providers: r.rows };
    });
  });

  app.post<{ Body: Record<string, unknown> }>('/api/auth/sso/providers', { preHandler: requirePermission('admin:manage') }, async (req, reply) => {
    const user = await authenticate(req);
    const ctx = authContext(req);
    const b = req.body ?? {};
    if (!b.key || !b.name) {
      reply.code(400);
      return { error: 'key and name are required' };
    }
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into identity_provider
           (tenant_id, key, name, type, issuer, authorization_endpoint, token_endpoint, userinfo_endpoint, jwks_uri, client_id, client_secret, scopes, match_claim, enabled)
         values ($1,$2,$3,coalesce($4,'oidc'),$5,$6,$7,$8,$9,$10,$11,coalesce($12,'openid email profile'),coalesce($13,'email'),coalesce($14,true))
         on conflict (tenant_id, key) do update set
           name=excluded.name, issuer=excluded.issuer, authorization_endpoint=excluded.authorization_endpoint,
           token_endpoint=excluded.token_endpoint, userinfo_endpoint=excluded.userinfo_endpoint, jwks_uri=excluded.jwks_uri,
           client_id=excluded.client_id, client_secret=coalesce(excluded.client_secret, identity_provider.client_secret),
           scopes=excluded.scopes, match_claim=excluded.match_claim, enabled=excluded.enabled
         returning id`,
        [ctx.tenantId, b.key, b.name, b.type ?? null, b.issuer ?? null, b.authorizationEndpoint ?? null, b.tokenEndpoint ?? null,
         b.userinfoEndpoint ?? null, b.jwksUri ?? null, b.clientId ?? null, b.clientSecret ?? null, b.scopes ?? null, b.matchClaim ?? null, b.enabled ?? null],
      );
      await writeAudit(db, ctx, { action: 'create', entityType: 'identity_provider', entityId: rows[0]!.id, after: { key: b.key, name: b.name }, actorLabel: user.displayName });
      return { ok: true, id: rows[0]!.id };
    });
  });

  // -----------------------------------------------------------------------
  // SSO authorization-code flow (pre-authentication)
  // -----------------------------------------------------------------------
  // Step 1: redirect the browser to the IdP with PKCE + signed state.
  app.get<{ Params: { key: string }; Querystring: { tenantCode: string } }>(
    '/api/auth/sso/:key/authorize',
    async (req, reply) => {
      const tenantCode = req.query.tenantCode;
      if (!tenantCode) {
        reply.code(400);
        return { error: 'tenantCode is required' };
      }
      const p = await ownerQuery<{ authorization_endpoint: string; client_id: string; scopes: string }>(
        `select ip.authorization_endpoint, ip.client_id, ip.scopes
           from identity_provider ip join tenant t on t.id = ip.tenant_id
          where t.code = $1 and ip.key = $2 and ip.enabled`,
        [tenantCode, req.params.key],
      );
      if (!p.rows[0]?.authorization_endpoint || !p.rows[0]?.client_id) {
        reply.code(404);
        return { error: 'SSO provider not configured' };
      }
      const codeVerifier = b64url(randomBytes(32));
      const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());
      const state = jwt.sign(
        { tenantCode, providerKey: req.params.key, codeVerifier, nonce: b64url(randomBytes(8)) },
        config.jwtSecret,
        { expiresIn: '10m' },
      );
      const redirectUri = `${req.protocol}://${req.headers.host}/api/auth/sso/callback`;
      const url = new URL(p.rows[0].authorization_endpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', p.rows[0].client_id);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', p.rows[0].scopes);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      reply.redirect(url.toString());
    },
  );

  // Step 2: IdP redirects back with ?code&state. Exchange the code, map the
  // identity to an app_user, and hand the SPA an access token.
  app.get<{ Querystring: { code?: string; state?: string } }>('/api/auth/sso/callback', async (req, reply) => {
    const { code, state } = req.query;
    if (!code || !state) {
      reply.code(400);
      return { error: 'code and state are required' };
    }
    let s: { tenantCode: string; providerKey: string; codeVerifier: string };
    try {
      s = jwt.verify(state, config.jwtSecret) as typeof s;
    } catch {
      reply.code(400);
      return { error: 'Invalid or expired SSO state' };
    }
    const p = await ownerQuery<{
      tenant_id: string; token_endpoint: string; client_id: string; client_secret: string; match_claim: string;
    }>(
      `select ip.tenant_id, ip.token_endpoint, ip.client_id, ip.client_secret, ip.match_claim
         from identity_provider ip join tenant t on t.id = ip.tenant_id
        where t.code = $1 and ip.key = $2 and ip.enabled`,
      [s.tenantCode, s.providerKey],
    );
    const prov = p.rows[0];
    if (!prov?.token_endpoint) {
      reply.code(404);
      return { error: 'SSO provider not configured' };
    }

    const redirectUri = `${req.protocol}://${req.headers.host}/api/auth/sso/callback`;
    try {
      const tokenRes = await fetch(prov.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: prov.client_id,
          client_secret: prov.client_secret ?? '',
          code_verifier: s.codeVerifier,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!tokenRes.ok) throw new AuthError('Token exchange failed');
      const tokens = (await tokenRes.json()) as { id_token?: string };
      const claims = decodeJwtPayload(tokens.id_token);
      const matchValue = String(claims?.[prov.match_claim] ?? claims?.email ?? '');
      const subject = String(claims?.sub ?? matchValue);
      if (!matchValue) throw new AuthError('No identity claim in token');

      // Find an existing federated identity, else match an app_user by the claim.
      const userId = await resolveFederatedUser(prov.tenant_id, s.providerKey, subject, matchValue);
      if (!userId) throw new AuthError('No RIOS account is linked to this identity', 403);

      const session = await buildSession(userId);
      // Hand the SPA the token via a fragment so it never lands in server logs.
      reply.redirect(`/login#sso_token=${encodeURIComponent(session.token)}`);
    } catch (err) {
      const e = err as AuthError;
      reply.code(e.status ?? 502);
      return { error: e.message ?? 'SSO sign-in failed' };
    }
  });

  // Allow the SPA to exchange the SSO fragment token for the user record.
  app.get('/api/auth/sso/me', { preHandler: requirePermission() }, async (req) => {
    const user = await authenticate(req);
    return { user };
  });
}

function decodeJwtPayload(token?: string): Record<string, unknown> | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function resolveFederatedUser(tenantId: string, providerKey: string, subject: string, matchValue: string): Promise<string | null> {
  const existing = await ownerQuery<{ user_id: string }>(
    `select user_id from user_identity where tenant_id = $1 and provider_key = $2 and subject = $3`,
    [tenantId, providerKey, subject],
  );
  if (existing.rows[0]) return existing.rows[0].user_id;

  // Just-in-time link by email to an existing active user.
  const u = await ownerQuery<{ id: string }>(
    `select id from app_user where tenant_id = $1 and email = $2 and status = 'active'`,
    [tenantId, matchValue],
  );
  if (!u.rows[0]) return null;
  await ownerQuery(
    `insert into user_identity (tenant_id, provider_key, subject, email, user_id) values ($1,$2,$3,$4,$5)
     on conflict (tenant_id, provider_key, subject) do nothing`,
    [tenantId, providerKey, subject, matchValue, u.rows[0].id],
  );
  return u.rows[0].id;
}
