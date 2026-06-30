/**
 * Authentication & authorization.
 *
 * - Passwords are verified with pgcrypto bcrypt (`crypt`) so the seed and the
 *   app agree without shipping a JS hashing dependency.
 * - A signed JWT carries the tenant, user, roles and the resolved permission
 *   set. Authorization is permission-based (RBAC) and checked per route;
 *   attribute scopes (ABAC) ride along in the token for finer policies (§14.1).
 * - Login lookups use the owner pool (pre-tenant-context); everything after the
 *   token is issued runs tenant-scoped under RLS.
 */

import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { ownerQuery } from './db.js';
import type { AuthUser } from '@rios/shared';

export class AuthError extends Error {
  constructor(message: string, public readonly status = 401) {
    super(message);
  }
}

export async function login(email: string, password: string, tenantCode?: string): Promise<{ token: string; user: AuthUser }> {
  const { rows } = await ownerQuery<{
    id: string;
    tenant_id: string;
    email: string;
    display_name: string;
  }>(
    `select u.id, u.tenant_id, u.email, u.display_name
       from app_user u
       join tenant t on t.id = u.tenant_id
      where u.email = $1
        and u.status = 'active'
        and u.password_hash = crypt($2, u.password_hash)
        and ($3::citext is null or t.code = $3)`,
    [email, password, tenantCode ?? null],
  );
  const row = rows[0];
  if (!row) throw new AuthError('Invalid credentials');

  const { roles, permissions } = await loadAccess(row.id, row.tenant_id);
  const user: AuthUser = {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    tenantId: row.tenant_id,
    roles,
    permissions,
  };
  const token = jwt.sign(user, config.jwtSecret, { expiresIn: config.jwtExpiresIn } as jwt.SignOptions);

  await ownerQuery(`update app_user set last_login_at = now() where id = $1`, [row.id]);
  return { token, user };
}

async function loadAccess(userId: string, tenantId: string): Promise<{ roles: string[]; permissions: string[] }> {
  const roleRes = await ownerQuery<{ code: string }>(
    `select r.code from user_role ur join role r on r.id = ur.role_id where ur.user_id = $1 and r.tenant_id = $2`,
    [userId, tenantId],
  );
  const permRes = await ownerQuery<{ permission: string }>(
    `select distinct rp.permission
       from user_role ur join role_permission rp on rp.role_id = ur.role_id
      where ur.user_id = $1`,
    [userId],
  );
  return {
    roles: roleRes.rows.map((r) => r.code),
    permissions: permRes.rows.map((r) => r.permission),
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthUser;
  }
}

/** Verify the bearer token and attach req.auth. Throws 401 if missing/invalid. */
export async function authenticate(req: FastifyRequest): Promise<AuthUser> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AuthError('Missing bearer token');
  try {
    const decoded = jwt.verify(header.slice(7), config.jwtSecret) as AuthUser;
    req.auth = decoded;
    return decoded;
  } catch {
    throw new AuthError('Invalid or expired token');
  }
}

/** Fastify preHandler enforcing authentication and (optionally) a permission. */
export function requirePermission(permission?: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const user = await authenticate(req);
      if (permission && !user.permissions.includes(permission) && !user.permissions.includes('admin:manage')) {
        reply.code(403);
        throw new AuthError(`Missing permission: ${permission}`, 403);
      }
    } catch (err) {
      const e = err as AuthError;
      reply.code(e.status ?? 401).send({ error: e.message });
    }
  };
}

export function authContext(req: FastifyRequest): { tenantId: string; userId: string } {
  if (!req.auth) throw new AuthError('Not authenticated');
  return { tenantId: req.auth.tenantId, userId: req.auth.id };
}
