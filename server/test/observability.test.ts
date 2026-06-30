/**
 * Observability endpoints (brief §15.6). Verifies the probes and that the
 * Prometheus exposition records request metrics. Skips cleanly without a DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

beforeAll(async () => {
  try {
    await appPool.query('select 1');
  } catch {
    dbUp = false;
    return;
  }
  app = await buildApp();
});

afterAll(async () => {
  if (app) await app.close();
  await closePools();
});

describe('observability', () => {
  it('serves liveness and version without auth', async () => {
    if (!dbUp) return;
    const live = await app.inject({ method: 'GET', url: '/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json().status).toBe('live');

    const version = await app.inject({ method: 'GET', url: '/version' });
    expect(version.json().service).toBe('rios-server');
  });

  it('readiness reflects database connectivity', async () => {
    if (!dbUp) return;
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe('ready');
  });

  it('exposes Prometheus metrics that record requests', async () => {
    if (!dbUp) return;
    // Generate a request to record.
    await app.inject({ method: 'GET', url: '/health' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const body = res.body;
    expect(body).toContain('rios_build_info');
    expect(body).toContain('rios_http_requests_total');
    expect(body).toContain('rios_http_request_duration_seconds_bucket');
    // The /health request we just made should be counted.
    expect(body).toMatch(/rios_http_requests_total\{method="GET",route="\/health",status="200"\} \d+/);
  });

  it('uses low-cardinality route labels (ids collapsed)', async () => {
    if (!dbUp) return;
    // Hit a parameterised route; the label should be the pattern, not the id.
    await app.inject({ method: 'GET', url: '/api/treaties/00000000-0000-0000-0000-000000000000' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    // Either the matched pattern /api/treaties/:id or sanitised — never the raw uuid.
    expect(res.body).not.toContain('00000000-0000-0000-0000-000000000000');
  });
});
