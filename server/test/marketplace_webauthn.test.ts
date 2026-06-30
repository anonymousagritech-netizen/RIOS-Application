/**
 * Final batch (brief §14.1, §26, §5, §12.7): WebAuthn ceremonies, API marketplace,
 * AI Automation Studio, and the assistant evaluation harness. Skips without a DB.
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
    await ownerQuery(`delete from webauthn_credential where label = 'CI passkey'`).catch(() => {});
    await app.close();
  }
  await closePools();
});

describe('WebAuthn', () => {
  it('runs the registration ceremony and lists the credential', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const begin = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register/begin', headers: auth });
    expect(begin.statusCode).toBe(200);
    expect(begin.json().challenge).toBeTruthy();
    expect(begin.json().pubKeyCredParams.length).toBeGreaterThan(0);

    const finish = await app.inject({ method: 'POST', url: '/api/auth/webauthn/register/finish', headers: auth, payload: { credentialId: 'cred-ci-1', publicKey: 'pk-ci-1', label: 'CI passkey' } });
    expect(finish.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/api/auth/webauthn/credentials', headers: auth });
    expect(list.json().credentials.some((c: { label: string }) => c.label === 'CI passkey')).toBe(true);

    const authBegin = await app.inject({ method: 'POST', url: '/api/auth/webauthn/authenticate/begin', headers: auth });
    expect(authBegin.json().allowCredentials.length).toBeGreaterThan(0);
  });
});

describe('API marketplace', () => {
  it('lists the catalog and installs/uninstalls a listing', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const listings = await app.inject({ method: 'GET', url: '/api/marketplace/listings', headers: auth });
    expect(listings.json().listings.some((l: { key: string; installed: boolean }) => l.key === 'slack-alerts' && l.installed)).toBe(true);

    const install = await app.inject({ method: 'POST', url: '/api/marketplace/installs', headers: auth, payload: { listingKey: 'docusign-esign' } });
    expect(install.statusCode).toBe(201);
    const after = await app.inject({ method: 'GET', url: '/api/marketplace/listings', headers: auth });
    expect(after.json().listings.find((l: { key: string }) => l.key === 'docusign-esign').installed).toBe(true);

    const uninstall = await app.inject({ method: 'POST', url: '/api/marketplace/installs/docusign-esign/uninstall', headers: auth });
    expect(uninstall.statusCode).toBe(200);
  });
});

describe('AI Automation Studio', () => {
  it('runs the seeded flow - passes the rule set and returns its actions', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const list = await app.inject({ method: 'GET', url: '/api/automation-studio/flows', headers: auth });
    expect(list.json().flows.some((f: { key: string }) => f.key === 'treaty.bind.autocheck')).toBe(true);

    // A clean context (premium present, small line) passes the bind guards → actions dispatched.
    const run = await app.inject({
      method: 'POST', url: '/api/automation-studio/flows/treaty.bind.autocheck/run', headers: auth,
      payload: { context: { premiumMinor: 500000, lob: 'MOTOR', brokeragePct: 10 } },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().dispatched).toBe(true);
    expect(run.json().actions.length).toBeGreaterThan(0);

    // A failing context (missing premium) → not dispatched.
    const blocked = await app.inject({
      method: 'POST', url: '/api/automation-studio/flows/treaty.bind.autocheck/run', headers: auth,
      payload: { context: { lob: 'MOTOR' } },
    });
    expect(blocked.json().dispatched).toBe(false);
    expect(blocked.json().actions).toEqual([]);
  });
});

describe('Assistant evaluation', () => {
  it('runs the eval suite and reports a pass rate', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'POST', url: '/api/assistant/eval/run', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThan(0);
    // The deterministic intent engine should pass the navigation cases at least.
    expect(res.json().passed).toBeGreaterThan(0);
  });
});
