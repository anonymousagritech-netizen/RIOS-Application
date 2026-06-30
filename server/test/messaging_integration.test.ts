/**
 * Messaging & integration batch (brief §3, §12): email/SMS outbox, event bus
 * outbox + relay, connector registry (with config validation + secret
 * redaction), and developer-portal API keys. Skips cleanly without a DB.
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
    await ownerQuery(`delete from message_outbox`).catch(() => {});
    await ownerQuery(`delete from event_outbox`).catch(() => {});
    await ownerQuery(`delete from api_key`).catch(() => {});
    await app.close();
  }
  await closePools();
});

describe('Email/SMS outbox', () => {
  it('enqueues and delivers a message', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const send = await app.inject({ method: 'POST', url: '/api/messaging/send', headers: auth, payload: { channel: 'email', to: 'broker@x.com', subject: 'Hi', body: 'Statement ready' } });
    expect(send.statusCode).toBe(201);
    expect(send.json().status).toBe('queued');

    const deliver = await app.inject({ method: 'POST', url: '/api/messaging/deliver', headers: auth });
    expect(deliver.json().delivered).toBeGreaterThanOrEqual(1);

    const list = await app.inject({ method: 'GET', url: '/api/messaging/outbox?status=sent', headers: auth });
    expect(list.json().messages.some((m: { to: string }) => m.to === 'broker@x.com')).toBe(true);
  });
});

describe('Event bus / outbox', () => {
  it('publishes to the outbox then relays', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const pub = await app.inject({ method: 'POST', url: '/api/events/publish', headers: auth, payload: { eventType: 'treaty.bound', aggregateType: 'contract', payload: { ref: 'T-1' } } });
    expect(pub.statusCode).toBe(201);

    const before = await app.inject({ method: 'GET', url: '/api/events?status=pending', headers: auth });
    expect(before.json().pending).toBeGreaterThanOrEqual(1);

    const relay = await app.inject({ method: 'POST', url: '/api/events/relay', headers: auth });
    expect(relay.json().published).toBeGreaterThanOrEqual(1);

    const after = await app.inject({ method: 'GET', url: '/api/events?status=pending', headers: auth });
    expect(after.json().pending).toBe(0);
  });
});

describe('Connector framework', () => {
  it('redacts secrets on read and validates on test', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const list = await app.inject({ method: 'GET', url: '/api/connectors', headers: auth });
    const rest = list.json().connectors.find((c: { key: string }) => c.key === 'bureau-rest');
    expect(rest.config.apiKey).toBe('••••••');     // secret redacted
    expect(rest.config.baseUrl).toBe('https://bureau.example.com/api');

    const test = await app.inject({ method: 'POST', url: `/api/connectors/${rest.id}/test`, headers: auth });
    expect(test.json().status).toBe('ok');
  });

  it('rejects an invalid connector config (422)', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'POST', url: '/api/connectors', headers: auth, payload: { key: 'bad', name: 'Bad', kind: 'rest', config: {} } });
    expect(res.statusCode).toBe(422);
  });
});

describe('Developer portal', () => {
  it('issues an API key once and stores only a hash', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const issue = await app.inject({ method: 'POST', url: '/api/devportal/keys', headers: auth, payload: { name: 'CI key', scopes: ['read'] } });
    expect(issue.statusCode).toBe(201);
    expect(issue.json().key).toMatch(/^rios_/);

    const list = await app.inject({ method: 'GET', url: '/api/devportal/keys', headers: auth });
    const k = list.json().keys.find((x: { name: string }) => x.name === 'CI key');
    expect(k.prefix).toMatch(/^rios_/);
    expect(k.key).toBeUndefined(); // raw key never returned again
  });

  it('forbids issuing a key without admin:manage', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('uw@demo.rios')}` };
    const res = await app.inject({ method: 'POST', url: '/api/devportal/keys', headers: auth, payload: { name: 'nope' } });
    expect(res.statusCode).toBe(403);
  });
});
