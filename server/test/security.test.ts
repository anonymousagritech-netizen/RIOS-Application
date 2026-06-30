/**
 * MFA & SSO (brief §14.1). Drives the full TOTP MFA lifecycle through the API
 * (enroll → verify → two-step login → disable) and checks the OIDC authorize
 * redirect. Skips cleanly without a DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, ownerQuery, closePools } from '../src/db.js';
import { totp } from '../src/auth/totp.js';

let app: FastifyInstance;
let dbUp = true;

async function loginToken(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
  // Ensure a clean slate for the claims user's MFA across reruns.
  await ownerQuery(`delete from mfa_credential where user_id in (select id from app_user where email='claims@demo.rios')`);
});
afterAll(async () => {
  if (app) {
    await ownerQuery(`delete from mfa_credential where user_id in (select id from app_user where email='claims@demo.rios')`).catch(() => {});
    await app.close();
  }
  await closePools();
});

describe('TOTP MFA lifecycle', () => {
  it('enrolls, verifies, enforces a second factor at login, then disables', async () => {
    if (!dbUp) return;
    const tkn = await loginToken('claims@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // Enroll → get a secret.
    const enroll = await app.inject({ method: 'POST', url: '/api/auth/mfa/enroll', headers: auth });
    expect(enroll.statusCode).toBe(200);
    const secret = enroll.json().secret as string;
    expect(enroll.json().otpauthUri).toMatch(/^otpauth:\/\/totp\//);

    // A wrong code is rejected.
    const bad = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', headers: auth, payload: { code: '000000' } });
    expect(bad.statusCode).toBe(400);

    // The correct current code enables MFA.
    const good = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', headers: auth, payload: { code: totp(secret, Date.now()) } });
    expect(good.statusCode).toBe(200);
    expect(good.json().enabled).toBe(true);

    // Now password login returns an MFA challenge, not an access token.
    const pwd = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'claims@demo.rios', password: 'demo1234', tenantCode: 'demo' } });
    expect(pwd.json().mfaRequired).toBe(true);
    expect(pwd.json().token).toBeUndefined();
    const mfaToken = pwd.json().mfaToken as string;

    // Completing with a fresh code yields the real access token.
    const step2 = await app.inject({ method: 'POST', url: '/api/auth/mfa/login', payload: { mfaToken, code: totp(secret, Date.now()) } });
    expect(step2.statusCode).toBe(200);
    expect(step2.json().token).toBeTruthy();
    expect(step2.json().user.email).toBe('claims@demo.rios');

    // A wrong second factor is refused.
    const step2bad = await app.inject({ method: 'POST', url: '/api/auth/mfa/login', payload: { mfaToken, code: '000000' } });
    expect(step2bad.statusCode).toBe(401);

    // Disable restores single-factor login.
    const newTkn = step2.json().token as string;
    const dis = await app.inject({ method: 'POST', url: '/api/auth/mfa/disable', headers: { authorization: `Bearer ${newTkn}` }, payload: { code: totp(secret, Date.now()) } });
    expect(dis.statusCode).toBe(200);
    const after = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'claims@demo.rios', password: 'demo1234', tenantCode: 'demo' } });
    expect(after.json().token).toBeTruthy();
  });
});

describe('SSO (OIDC)', () => {
  it('admin can register a provider and authorize redirects with PKCE', async () => {
    if (!dbUp) return;
    const admin = await loginToken('admin@demo.rios');
    const create = await app.inject({
      method: 'POST', url: '/api/auth/sso/providers',
      headers: { authorization: `Bearer ${admin}` },
      payload: {
        key: 'test-oidc', name: 'Test OIDC', type: 'oidc',
        authorizationEndpoint: 'https://idp.example.com/authorize',
        tokenEndpoint: 'https://idp.example.com/token',
        clientId: 'rios-client', clientSecret: 'shh', scopes: 'openid email profile', matchClaim: 'email',
      },
    });
    expect(create.statusCode).toBe(200);

    const auth = await app.inject({ method: 'GET', url: '/api/auth/sso/test-oidc/authorize?tenantCode=demo' });
    expect(auth.statusCode).toBe(302);
    const loc = auth.headers.location as string;
    expect(loc).toContain('https://idp.example.com/authorize?');
    expect(loc).toContain('client_id=rios-client');
    expect(loc).toContain('code_challenge_method=S256');
    expect(loc).toMatch(/state=/);
    expect(loc).toMatch(/code_challenge=/);
  });
});
