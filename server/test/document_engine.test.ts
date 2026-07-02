/**
 * Document Engine tests (real-file storage, versioning, cross-entity links,
 * approval workflow, search, configurable per-record limit, AI extraction).
 *
 * Skips cleanly when Postgres is unreachable so it never false-fails without a DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, ownerQuery, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;
let tenantId = '';
let treatyId = '';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const TXT = 'text/plain';

async function login(email: string): Promise<{ token: string; tenantId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'demo1234', tenantCode: 'demo' },
  });
  const body = res.json();
  return { token: body.token as string, tenantId: body.user.tenantId as string };
}

function authFor(token: string) {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  try {
    await appPool.query('select 1');
  } catch {
    dbUp = false;
    return;
  }
  app = await buildApp();
  const admin = await login('admin@demo.rios');
  tenantId = admin.tenantId;
  // Set a low per-record cap so the limit is testable without bulk uploads.
  await ownerQuery(
    `insert into app_setting (tenant_id, key, value)
     values ($1, 'documents.maxAttachmentsPerRecord', '2')
     on conflict (tenant_id, key) do update set value = excluded.value`,
    [tenantId],
  );
  const treaties = await app.inject({ method: 'GET', url: '/api/treaties', headers: authFor(admin.token) });
  treatyId = (treaties.json().treaties?.[0]?.id as string) ?? randomUUID();
});

afterAll(async () => {
  if (app) await app.close();
  await closePools();
});

describe('document engine', () => {
  it('uploads a txt document to a treaty: stored, linked, ocr_text captured', async () => {
    if (!dbUp) return;
    const { token } = await login('admin@demo.rios');
    const auth = authFor(token);
    const up = await app.inject({
      method: 'POST',
      url: '/api/documents/upload',
      headers: auth,
      payload: {
        fileName: 'cover-note.txt',
        mimeType: TXT,
        contentBase64: b64('Cedent Acme Re, premium 1,000,000, hours clause 168.'),
        category: 'SLIP',
        entityType: 'treaty',
        entityId: treatyId,
        tags: ['cover', 'slip'],
      },
    });
    expect(up.statusCode).toBe(201);
    const doc = up.json();
    expect(doc.id).toBeTruthy();
    expect(doc.docStatus).toBe('UPLOADED');
    expect(doc.currentVersion).toBe(1);
    expect(doc.ocrText).toContain('Cedent Acme Re');
    expect(doc.checksum).toMatch(/^[0-9a-f]{64}$/);

    // Listed via document_link join for the entity.
    const list = await app.inject({
      method: 'GET',
      url: `/api/documents?entityType=treaty&entityId=${treatyId}`,
      headers: auth,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().documents.some((d: { id: string }) => d.id === doc.id)).toBe(true);

    // Content endpoint returns the base64 payload.
    const content = await app.inject({ method: 'GET', url: `/api/documents/${doc.id}/content`, headers: auth });
    expect(content.statusCode).toBe(200);
    expect(content.json().contentBase64).toBe(b64('Cedent Acme Re, premium 1,000,000, hours clause 168.'));
  });

  it('rejects a disallowed MIME type (400)', async () => {
    if (!dbUp) return;
    const { token } = await login('admin@demo.rios');
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents/upload',
      headers: authFor(token),
      payload: {
        fileName: 'evil.exe',
        mimeType: 'application/x-msdownload',
        contentBase64: b64('nope'),
        entityType: 'treaty',
        entityId: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an oversize payload (400)', async () => {
    if (!dbUp) return;
    const { token } = await login('admin@demo.rios');
    const big = Buffer.alloc(11 * 1024 * 1024, 0x41).toString('base64'); // ~11 MB decoded
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents/upload',
      headers: authFor(token),
      payload: {
        fileName: 'huge.txt',
        mimeType: TXT,
        contentBase64: big,
        entityType: 'treaty',
        entityId: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('enforces the configurable per-record attachment limit (409)', async () => {
    if (!dbUp) return;
    const { token } = await login('admin@demo.rios');
    const auth = authFor(token);
    const entityId = randomUUID();

    const cfg = await app.inject({ method: 'GET', url: '/api/documents/config', headers: auth });
    expect(cfg.json().maxAttachmentsPerRecord).toBe(2);

    for (let i = 0; i < 2; i++) {
      const ok = await app.inject({
        method: 'POST',
        url: '/api/documents/upload',
        headers: auth,
        payload: {
          fileName: `doc-${i}.txt`,
          mimeType: TXT,
          contentBase64: b64(`file ${i}`),
          entityType: 'claim',
          entityId,
        },
      });
      expect(ok.statusCode).toBe(201);
    }
    const over = await app.inject({
      method: 'POST',
      url: '/api/documents/upload',
      headers: auth,
      payload: {
        fileName: 'doc-3.txt',
        mimeType: TXT,
        contentBase64: b64('file 3'),
        entityType: 'claim',
        entityId,
      },
    });
    expect(over.statusCode).toBe(409);
  });

  it('adds a version and lists history (2 entries)', async () => {
    if (!dbUp) return;
    const { token } = await login('admin@demo.rios');
    const auth = authFor(token);
    const up = await app.inject({
      method: 'POST',
      url: '/api/documents/upload',
      headers: auth,
      payload: {
        fileName: 'v1.txt',
        mimeType: TXT,
        contentBase64: b64('version one'),
        entityType: 'submission',
        entityId: randomUUID(),
      },
    });
    const id = up.json().id as string;

    const v2 = await app.inject({
      method: 'POST',
      url: `/api/documents/${id}/versions`,
      headers: auth,
      payload: {
        fileName: 'v2.txt',
        mimeType: TXT,
        contentBase64: b64('version two'),
        changeSummary: 'Revised wording',
      },
    });
    expect(v2.statusCode).toBe(201);
    expect(v2.json().version).toBe(2);

    const hist = await app.inject({ method: 'GET', url: `/api/documents/${id}/versions`, headers: auth });
    expect(hist.json().versions).toHaveLength(2);
    expect(hist.json().versions[0].changeSummary).toBe('Revised wording');
    // History omits the base64 blobs.
    expect(hist.json().versions[0].contentBase64).toBeUndefined();

    // Fetch a specific historical version's content.
    const v1content = await app.inject({
      method: 'GET',
      url: `/api/documents/${id}/content?version=1`,
      headers: auth,
    });
    expect(v1content.json().contentBase64).toBe(b64('version one'));
  });

  it('cross-links one document to a second entity and lists from both', async () => {
    if (!dbUp) return;
    const { token } = await login('admin@demo.rios');
    const auth = authFor(token);
    const entityA = randomUUID();
    const entityB = randomUUID();

    const up = await app.inject({
      method: 'POST',
      url: '/api/documents/upload',
      headers: auth,
      payload: {
        fileName: 'shared.txt',
        mimeType: TXT,
        contentBase64: b64('shared across records'),
        entityType: 'treaty',
        entityId: entityA,
      },
    });
    const id = up.json().id as string;

    const link = await app.inject({
      method: 'POST',
      url: `/api/documents/${id}/links`,
      headers: auth,
      payload: { entityType: 'claim', entityId: entityB },
    });
    expect(link.statusCode).toBe(201);

    const links = await app.inject({ method: 'GET', url: `/api/documents/${id}/links`, headers: auth });
    expect(links.json().links).toHaveLength(2);

    const fromA = await app.inject({
      method: 'GET',
      url: `/api/documents?entityType=treaty&entityId=${entityA}`,
      headers: auth,
    });
    const fromB = await app.inject({
      method: 'GET',
      url: `/api/documents?entityType=claim&entityId=${entityB}`,
      headers: auth,
    });
    expect(fromA.json().documents.some((d: { id: string }) => d.id === id)).toBe(true);
    expect(fromB.json().documents.some((d: { id: string }) => d.id === id)).toBe(true);
  });

  it('runs the approval workflow: happy path + illegal transition (409)', async () => {
    if (!dbUp) return;
    const { token } = await login('admin@demo.rios');
    const auth = authFor(token);
    const up = await app.inject({
      method: 'POST',
      url: '/api/documents/upload',
      headers: auth,
      payload: {
        fileName: 'wording.txt',
        mimeType: TXT,
        contentBase64: b64('treaty wording'),
        entityType: 'treaty',
        entityId: randomUUID(),
      },
    });
    const id = up.json().id as string; // starts UPLOADED

    const toReviewed = await app.inject({
      method: 'POST',
      url: `/api/documents/${id}/transition`,
      headers: auth,
      payload: { to: 'REVIEWED' },
    });
    expect(toReviewed.statusCode).toBe(200);
    expect(toReviewed.json().to).toBe('REVIEWED');

    const toApproved = await app.inject({
      method: 'POST',
      url: `/api/documents/${id}/transition`,
      headers: auth,
      payload: { to: 'APPROVED' },
    });
    expect(toApproved.statusCode).toBe(200);

    // Illegal: APPROVED -> ARCHIVED (must go through LOCKED first).
    const illegal = await app.inject({
      method: 'POST',
      url: `/api/documents/${id}/transition`,
      headers: auth,
      payload: { to: 'ARCHIVED' },
    });
    expect(illegal.statusCode).toBe(409);
  });

  it('searches by text and by category', async () => {
    if (!dbUp) return;
    const { token } = await login('admin@demo.rios');
    const auth = authFor(token);
    const marker = `ZephyrMarker${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: '/api/documents/upload',
      headers: auth,
      payload: {
        fileName: 'searchable.txt',
        mimeType: TXT,
        contentBase64: b64(`Contains the ${marker} token`),
        category: 'ENDORSEMENT',
        entityType: 'treaty',
        entityId: randomUUID(),
      },
    });

    const byText = await app.inject({ method: 'GET', url: `/api/documents/search?q=${marker}`, headers: auth });
    expect(byText.json().documents).toHaveLength(1);

    const byCategory = await app.inject({
      method: 'GET',
      url: '/api/documents/search?category=ENDORSEMENT',
      headers: auth,
    });
    expect(byCategory.json().documents.length).toBeGreaterThanOrEqual(1);
  });

  it('extraction returns a structured, honest result shape (no LLM key)', async () => {
    if (!dbUp) return;
    const { token } = await login('admin@demo.rios');
    const auth = authFor(token);
    const up = await app.inject({
      method: 'POST',
      url: '/api/documents/upload',
      headers: auth,
      payload: {
        fileName: 'slip.txt',
        mimeType: TXT,
        contentBase64: b64('Cedent: Acme Re; Broker: Guy Re; Premium 1,000,000'),
        entityType: 'treaty',
        entityId: randomUUID(),
      },
    });
    const id = up.json().id as string;
    const ex = await app.inject({ method: 'POST', url: `/api/documents/${id}/extract`, headers: auth });
    expect(ex.statusCode).toBe(200);
    const extraction = ex.json().extraction;
    expect(extraction).toHaveProperty('llmUsed');
    expect(extraction).toHaveProperty('note');
    expect(extraction.fields).toHaveProperty('cedent');
    expect(extraction.fields.cedent).toHaveProperty('value');
    expect(extraction.fields.cedent).toHaveProperty('confidence');
    // Without a configured key, no values are fabricated.
    if (!extraction.llmUsed) {
      expect(extraction.fields.premium.value).toBeNull();
      expect(extraction.fields.premium.confidence).toBe(0);
    }
  });

  it('rejects upload from a role lacking documents:write (403)', async () => {
    if (!dbUp) return;
    const { token } = await login('claims@demo.rios');
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents/upload',
      headers: authFor(token),
      payload: {
        fileName: 'note.txt',
        mimeType: TXT,
        contentBase64: b64('claims cannot write documents'),
        entityType: 'treaty',
        entityId: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(403);
  });
});
