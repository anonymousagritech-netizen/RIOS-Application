/**
 * HTTP security headers + CORS allow-list tests (task G-02).
 *
 * These tests use Fastify's inject() which bypasses the network, so they
 * run without a database connection and always execute (unlike the
 * integration.test.ts vertical-slice which skips without Postgres).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;

beforeAll(async () => {
  // Ensure CORS_ORIGINS is set for the allow-list test.
  process.env.CORS_ORIGINS = 'http://localhost:5173';
  app = await buildApp();
});

afterAll(async () => {
  if (app) await app.close();
});

describe('HTTP security headers (helmet)', () => {
  it('returns x-content-type-options: nosniff on every response', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns x-frame-options header', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    // helmet sets X-Frame-Options to SAMEORIGIN by default
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  it('returns referrer-policy header', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});

describe('CORS allow-list', () => {
  it('reflects allowed origin (localhost:5173) in access-control-allow-origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('does NOT reflect a disallowed origin in access-control-allow-origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://evil.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).not.toBe('http://evil.example.com');
  });
});
