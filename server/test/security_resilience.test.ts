/**
 * Security & resilience batch (brief §14, §15, §19): KMS envelope encryption,
 * SOC/SIEM feed, backup/DR catalog, i18n bundles, SAML metadata. Skips without DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, ownerQuery, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

async function loginToken(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
});
afterAll(async () => {
  if (app) {
    await ownerQuery(`delete from kms_key where alias='test-dek'`).catch(() => {});
    await app.close();
  }
  await closePools();
});

describe('KMS envelope encryption', () => {
  it('creates a key and round-trips encrypt → decrypt', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const key = await app.inject({ method: 'POST', url: '/api/kms/keys', headers: auth, payload: { alias: 'test-dek' } });
    expect(key.statusCode).toBe(201);

    const enc = await app.inject({ method: 'POST', url: '/api/kms/encrypt', headers: auth, payload: { alias: 'test-dek', data: 'secret-account-number-42' } });
    expect(enc.statusCode).toBe(200);
    const ciphertext = enc.json().ciphertext;
    expect(ciphertext).not.toContain('secret-account');

    const dec = await app.inject({ method: 'POST', url: '/api/kms/decrypt', headers: auth, payload: { alias: 'test-dek', data: ciphertext } });
    expect(dec.json().plaintext).toBe('secret-account-number-42');
  });

  it('forbids KMS without admin:manage', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('uw@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/kms/keys', headers: auth });
    expect(res.statusCode).toBe(403);
  });
});

describe('SOC / SIEM', () => {
  it('surfaces security-relevant audit events and exports NDJSON', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    // Generate a security event (issue a KMS key) so the feed has content.
    await app.inject({ method: 'POST', url: '/api/kms/keys', headers: auth, payload: { alias: 'test-dek' } });
    const soc = await app.inject({ method: 'GET', url: '/api/soc/events', headers: auth });
    expect(soc.statusCode).toBe(200);
    expect(Array.isArray(soc.json().events)).toBe(true);

    const siem = await app.inject({ method: 'GET', url: '/api/soc/siem/export', headers: auth });
    expect(siem.statusCode).toBe(200);
    expect(siem.headers['content-type']).toContain('ndjson');
  });
});

describe('Backup / DR', () => {
  it('records a backup run and lists it', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const run = await app.inject({ method: 'POST', url: '/api/backup/runs', headers: auth, payload: { kind: 'full', note: 'pre-release' } });
    expect(run.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/api/backup/runs', headers: auth });
    expect(list.json().runs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('i18n & SAML', () => {
  it('resolves a French bundle with English fallback and reports RTL for Arabic', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const fr = await app.inject({ method: 'GET', url: '/api/i18n/bundle?locale=fr-FR', headers: auth });
    expect(fr.json().bundle['nav.dashboard']).toBe('Tableau de bord');
    expect(fr.json().bundle['action.bind']).toBe('Bind treaty'); // English fallback
    expect(fr.json().direction).toBe('ltr');

    const ar = await app.inject({ method: 'GET', url: '/api/i18n/bundle?locale=ar-SA', headers: auth });
    expect(ar.json().direction).toBe('rtl');
  });

  it('serves SP metadata XML and lists SAML providers', async () => {
    if (!dbUp) return;
    const meta = await app.inject({ method: 'GET', url: '/api/auth/saml/metadata' });
    expect(meta.statusCode).toBe(200);
    expect(meta.body).toContain('AssertionConsumerService');

    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const providers = await app.inject({ method: 'GET', url: '/api/auth/saml/providers', headers: auth });
    expect(providers.json().providers.some((p: { key: string }) => p.key === 'okta-saml')).toBe(true);
  });
});
