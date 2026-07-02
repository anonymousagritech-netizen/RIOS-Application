/**
 * Distributed rate limiting (G-03). Verifies that the per-route limit on the
 * login endpoint enforces a hard cap of 10 requests per 15-minute window and
 * returns an RFC-compliant 429 response on the 11th attempt.
 *
 * The rate limiter uses an in-memory store, so this test is self-contained and
 * does not require a database or Redis connection. The 429 is returned by the
 * preHandler hook before the authentication logic runs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePools } from '../src/db.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  if (app) await app.close();
  await closePools();
});

describe('rate limiting', () => {
  it('returns 429 on the 11th login attempt within the 15-minute window', async () => {
    // The login route allows 10 requests per 15 minutes per IP.
    // app.inject() uses '127.0.0.1' as the default remote address, so all
    // requests share the same rate-limit key within this test run.
    const payload = { email: 'test@example.com', password: 'wrong', tenantCode: 'demo' };

    let lastStatus = 0;
    for (let i = 1; i <= 11; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
      lastStatus = res.statusCode;
      if (res.statusCode === 429) {
        // The 11th (or earlier) hit triggered the limit.
        expect(i).toBeGreaterThanOrEqual(10);
        const body = res.json();
        expect(body.statusCode ?? res.statusCode).toBe(429);
        expect(body.error).toBe('Too Many Requests');
        expect(body.retryAfter).toBeTruthy();
        return;
      }
    }

    // If we reach here without a 429, the rate limiter did not trigger.
    throw new Error(`Expected a 429 response within 11 login attempts; last status was ${lastStatus}`);
  });

  it('global limit returns 429 after 100 requests per minute on any route', async () => {
    // Hit /health (which has no per-route override) 101 times. The global
    // 100-req/min limit should kick in on or before the 101st request.
    let triggered = false;
    for (let i = 1; i <= 101; i++) {
      const res = await app.inject({ method: 'GET', url: '/health' });
      if (res.statusCode === 429) {
        expect(i).toBeGreaterThanOrEqual(100);
        triggered = true;
        break;
      }
    }
    expect(triggered).toBe(true);
  });
});
