/**
 * Documents / templates module (brief §9.4 - template engine + document generation).
 *
 * Reusable, versioned templates live in `document_template`; generated artifacts
 * (slips, statements, wordings) are recorded in `document` with their merge
 * context. Rendering is a PURE, allowlist-free string merge - a regex replace of
 * `{{ dotted.path }}` placeholders resolved against a plain context object. No
 * eval, no template library: the engine cannot execute caller-supplied code.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { isLlmEnabled, llmAnswer } from '../ai/llm.js';

// ---------------------------------------------------------------------------
// Document Engine: real-file storage, versioning, links, workflow, extraction.
// ---------------------------------------------------------------------------

/** Allowlisted MIME types (pdf, docx, xlsx, csv, txt, jpg/jpeg, png, tiff, zip, eml). */
const ALLOWED_MIME = new Set<string>([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'text/csv',
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'application/zip',
  'message/rfc822', // eml
]);

/** Formats whose bytes are plain text - we can capture searchable text directly. */
const TEXT_MIME = new Set<string>(['text/plain', 'text/csv', 'message/rfc822']);

const MAX_BYTES = 10 * 1024 * 1024; // ~10 MB decoded
const DEFAULT_MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENTS_KEY = 'documents.maxAttachmentsPerRecord';

/** Reinsurance fields the extractor targets (empty + low-confidence when no LLM). */
const EXTRACTION_FIELDS = [
  'cedent',
  'broker',
  'treatyNumber',
  'limits',
  'premium',
  'commission',
  'effectiveDate',
  'expiryDate',
  'conditions',
  'clauses',
  'exclusions',
  'reinstatements',
  'hoursClause',
  'cashCallTerms',
] as const;

/** Legal approval-workflow transitions. ARCHIVED is terminal. */
const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['UPLOADED'],
  UPLOADED: ['REVIEWED'],
  REVIEWED: ['APPROVED'],
  APPROVED: ['LOCKED', 'REVIEWED'], // may step back to REVIEWED before LOCKED
  LOCKED: ['ARCHIVED'],
  ARCHIVED: [],
};

interface ValidatedFile {
  sizeBytes: number;
  checksum: string;
  ocrText: string | null;
}

/**
 * Validate an uploaded base64 payload: MIME allowlist + size cap; compute a
 * sha256 checksum and (for text formats) the searchable text. Returns an error
 * string on rejection, or the derived metadata on success.
 */
function validateFile(mimeType: string, contentBase64: string): { error: string } | ValidatedFile {
  if (!ALLOWED_MIME.has(mimeType)) {
    return { error: `Unsupported MIME type: ${mimeType}` };
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(contentBase64, 'base64');
  } catch {
    return { error: 'contentBase64 is not valid base64' };
  }
  if (buf.length > MAX_BYTES) {
    return { error: `File exceeds ${MAX_BYTES} bytes (got ${buf.length})` };
  }
  const checksum = createHash('sha256').update(buf).digest('hex');
  const ocrText = TEXT_MIME.has(mimeType) ? buf.toString('utf8') : null;
  return { sizeBytes: buf.length, checksum, ocrText };
}

/** Resolve the per-record attachment cap from app_setting, defaulting to 10. */
async function maxAttachmentsPerRecord(db: Db, tenantId: string): Promise<number> {
  const { rows } = await db.query<{ value: string }>(
    `select value from app_setting where tenant_id = $1 and key = $2`,
    [tenantId, MAX_ATTACHMENTS_KEY],
  );
  const n = rows[0] ? Number(rows[0].value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_ATTACHMENTS;
}

/** A clearly-labelled empty extraction result (used when no LLM / no text). */
function emptyExtraction(note: string): Record<string, unknown> {
  const fields: Record<string, { value: null; confidence: number }> = {};
  for (const f of EXTRACTION_FIELDS) fields[f] = { value: null, confidence: 0 };
  return { llmUsed: false, note, fields };
}

const createTemplateSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  docType: z.string().min(1).optional(),
  body: z.string(),
});

const generateSchema = z
  .object({
    templateKey: z.string().min(1).optional(),
    templateId: z.string().uuid().optional(),
    title: z.string().min(1),
    docType: z.string().min(1).optional(),
    entityType: z.string().min(1).optional(),
    entityId: z.string().uuid().optional(),
    context: z.record(z.unknown()).default({}),
  })
  .refine((b) => b.templateKey || b.templateId, {
    message: 'templateKey or templateId is required',
  });

/**
 * Resolve a dotted path (`a.b.c`) against a nested object, returning the value
 * or undefined. Pure; never throws on missing intermediate keys.
 */
function resolvePath(context: Record<string, unknown>, path: string): unknown {
  let cur: unknown = context;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Pure merge: replace every `{{ dotted.path }}` with its value from `context`.
 * Missing paths render as the empty string. Objects/arrays render as JSON.
 */
export function renderTemplate(body: string, context: Record<string, unknown>): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const value = resolvePath(context, path);
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

interface TemplateRow {
  id: string;
  key: string;
  name: string;
  doc_type: string;
  body: string;
}

export async function documentsModule(app: FastifyInstance): Promise<void> {
  // Create a template (version 1).
  app.post('/api/documents/templates', { preHandler: requirePermission('documents:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid template', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into document_template (tenant_id, key, name, doc_type, body, version, created_by)
         values ($1, $2, $3, $4, $5, 1, $6) returning id`,
        [ctx.tenantId, b.key, b.name, b.docType ?? 'generic', b.body, ctx.userId],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'document_template',
        entityId: id,
        after: { key: b.key, name: b.name },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, key: b.key, version: 1 };
    });
  });

  // List active templates.
  app.get('/api/documents/templates', { preHandler: requirePermission('documents:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, key, name, doc_type as "docType", version, created_at as "createdAt"
           from document_template
          where is_active
          order by created_at desc`,
      );
      return { templates: rows };
    });
  });

  // A single template incl. body.
  app.get<{ Params: { id: string } }>(
    '/api/documents/templates/:id',
    { preHandler: requirePermission('documents:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, key, name, doc_type as "docType", body, version, is_active as "isActive",
                  created_at as "createdAt"
             from document_template where id = $1`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Template not found' };
        }
        return rows[0];
      });
    },
  );

  // Generate a document by rendering a template against a context.
  app.post('/api/documents/generate', { preHandler: requirePermission('documents:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid generation request', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const template = await loadTemplate(db, b.templateId, b.templateKey);
      if (!template) {
        reply.code(404);
        return { error: 'Template not found' };
      }
      const context = b.context as Record<string, unknown>;
      const content = renderTemplate(template.body, context);
      const docType = b.docType ?? template.doc_type ?? 'generic';

      const { rows } = await db.query<{ id: string }>(
        `insert into document
           (tenant_id, template_key, title, doc_type, entity_type, entity_id, content, merge_context, status, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'final', $9) returning id`,
        [
          ctx.tenantId,
          template.key,
          b.title,
          docType,
          b.entityType ?? null,
          b.entityId ?? null,
          content,
          JSON.stringify(context),
          ctx.userId,
        ],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'generate',
        entityType: 'document',
        entityId: id,
        after: { templateKey: template.key, title: b.title, docType },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, content };
    });
  });

  // List generated documents, optionally filtered.
  app.get<{ Querystring: { entityType?: string; entityId?: string; docType?: string } }>(
    '/api/documents',
    { preHandler: requirePermission('documents:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        // Match documents attached to the entity either via the legacy
        // entity_type/entity_id columns (template-generated docs) or via a
        // document_link (uploaded/cross-linked files). No base64 in the list.
        const { rows } = await db.query(
          `select d.id, d.template_key as "templateKey", d.title, d.doc_type as "docType",
                  d.entity_type as "entityType", d.entity_id as "entityId", d.status,
                  d.doc_status as "docStatus", d.category, d.file_name as "fileName",
                  d.mime_type as "mimeType", d.size_bytes as "sizeBytes",
                  d.current_version as "currentVersion", d.tags, d.created_at as "createdAt"
             from document d
            where ($3::text is null or d.doc_type = $3)
              and ($1::text is null
                   or (d.entity_type = $1 and ($2::uuid is null or d.entity_id = $2))
                   or exists (select 1 from document_link dl
                               where dl.document_id = d.id and dl.entity_type = $1
                                 and ($2::uuid is null or dl.entity_id = $2)))
            order by d.created_at desc`,
          [req.query.entityType ?? null, req.query.entityId ?? null, req.query.docType ?? null],
        );
        return { documents: rows };
      });
    },
  );

  // A single document incl. rendered content.
  app.get<{ Params: { id: string } }>(
    '/api/documents/:id',
    { preHandler: requirePermission('documents:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, template_key as "templateKey", title, doc_type as "docType",
                  entity_type as "entityType", entity_id as "entityId", content,
                  merge_context as "mergeContext", status, created_at as "createdAt"
             from document where id = $1`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Document not found' };
        }
        return rows[0];
      });
    },
  );

  // -------------------------------------------------------------------------
  // Document Engine endpoints (real files, versions, links, workflow, search).
  // -------------------------------------------------------------------------

  // Configurable per-record attachment limit.
  app.get('/api/documents/config', { preHandler: requirePermission('documents:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const max = await maxAttachmentsPerRecord(db, ctx.tenantId);
      return { maxAttachmentsPerRecord: max };
    });
  });

  // Full-text-ish search over file_name / ocr_text / category / tags.
  app.get<{ Querystring: { q?: string; entityType?: string; category?: string; tag?: string } }>(
    '/api/documents/search',
    { preHandler: requirePermission('documents:read') },
    async (req) => {
      const ctx = authContext(req);
      const { q, entityType, category, tag } = req.query;
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select distinct d.id, d.title, d.file_name as "fileName", d.mime_type as "mimeType",
                  d.size_bytes as "sizeBytes", d.category, d.doc_status as "docStatus",
                  d.current_version as "currentVersion", d.tags, d.doc_type as "docType",
                  d.created_at as "createdAt"
             from document d
             left join document_link dl on dl.document_id = d.id
            where ($1::text is null
                   or d.file_name ilike '%' || $1 || '%'
                   or d.ocr_text ilike '%' || $1 || '%'
                   or d.category ilike '%' || $1 || '%'
                   or d.title ilike '%' || $1 || '%')
              and ($2::text is null or dl.entity_type = $2)
              and ($3::text is null or d.category = $3)
              and ($4::text is null or d.tags @> array[$4]::text[])
            order by d.created_at desc`,
          [q ?? null, entityType ?? null, category ?? null, tag ?? null],
        );
        return { documents: rows };
      });
    },
  );

  // Upload a real file: enforce the per-record limit, store the head + v1 +
  // a link to the entity, capturing searchable text for text formats.
  app.post('/api/documents/upload', { preHandler: requirePermission('documents:write'), bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid upload', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    const validated = validateFile(b.mimeType, b.contentBase64);
    if ('error' in validated) {
      reply.code(400);
      return { error: validated.error };
    }
    return runAs(ctx, async (db) => {
      const limit = await maxAttachmentsPerRecord(db, ctx.tenantId);
      const { rows: cnt } = await db.query<{ n: number }>(
        `select count(*)::int as n from document_link where entity_type = $1 and entity_id = $2`,
        [b.entityType, b.entityId],
      );
      if ((cnt[0]?.n ?? 0) >= limit) {
        reply.code(409);
        return { error: `Attachment limit reached: ${limit} per record. Remove or archive an existing document first.` };
      }

      const { rows } = await db.query<{ id: string }>(
        `insert into document
           (tenant_id, title, doc_type, entity_type, entity_id, status,
            file_name, mime_type, size_bytes, content_base64, category, ocr_text,
            extraction, doc_status, current_version, checksum, uploaded_by, tags)
         values ($1,$2,'upload',$3,$4,'final',
            $5,$6,$7,$8,$9,$10,
            '{}'::jsonb,'UPLOADED',1,$11,$12,$13)
         returning id`,
        [
          ctx.tenantId,
          b.fileName,
          b.entityType,
          b.entityId,
          b.fileName,
          b.mimeType,
          validated.sizeBytes,
          b.contentBase64,
          b.category ?? null,
          validated.ocrText,
          validated.checksum,
          ctx.userId,
          b.tags ?? null,
        ],
      );
      const id = rows[0]!.id;

      await db.query(
        `insert into document_version
           (tenant_id, document_id, version, file_name, mime_type, size_bytes,
            content_base64, ocr_text, extraction, change_summary, uploaded_by)
         values ($1,$2,1,$3,$4,$5,$6,$7,'{}'::jsonb,$8,$9)`,
        [
          ctx.tenantId,
          id,
          b.fileName,
          b.mimeType,
          validated.sizeBytes,
          b.contentBase64,
          validated.ocrText,
          b.changeSummary ?? 'Initial upload',
          ctx.userId,
        ],
      );

      await db.query(
        `insert into document_link (tenant_id, document_id, entity_type, entity_id, created_by)
         values ($1,$2,$3,$4,$5)
         on conflict (tenant_id, document_id, entity_type, entity_id) do nothing`,
        [ctx.tenantId, id, b.entityType, b.entityId, ctx.userId],
      );

      await writeAudit(db, ctx, {
        action: 'upload',
        entityType: 'document',
        entityId: id,
        after: {
          fileName: b.fileName,
          mimeType: b.mimeType,
          sizeBytes: validated.sizeBytes,
          category: b.category ?? null,
          entityType: b.entityType,
          entityId: b.entityId,
          checksum: validated.checksum,
        },
        actorLabel: req.auth?.displayName,
      });

      reply.code(201);
      return {
        id,
        fileName: b.fileName,
        mimeType: b.mimeType,
        sizeBytes: validated.sizeBytes,
        category: b.category ?? null,
        docStatus: 'UPLOADED',
        currentVersion: 1,
        checksum: validated.checksum,
        ocrText: validated.ocrText,
        tags: b.tags ?? null,
        entityType: b.entityType,
        entityId: b.entityId,
      };
    });
  });

  // Add a new version to an existing document (head advances).
  app.post<{ Params: { id: string } }>(
    '/api/documents/:id/versions',
    { preHandler: requirePermission('documents:write'), bodyLimit: 20 * 1024 * 1024 },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = versionSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid version', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      const validated = validateFile(b.mimeType, b.contentBase64);
      if ('error' in validated) {
        reply.code(400);
        return { error: validated.error };
      }
      return runAs(ctx, async (db) => {
        const head = await db.query<{ current_version: number }>(
          `select current_version from document where id = $1`,
          [req.params.id],
        );
        if (!head.rows[0]) {
          reply.code(404);
          return { error: 'Document not found' };
        }
        const nextVersion = (head.rows[0].current_version ?? 1) + 1;

        await db.query(
          `insert into document_version
             (tenant_id, document_id, version, file_name, mime_type, size_bytes,
              content_base64, ocr_text, extraction, change_summary, uploaded_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb,$9,$10)`,
          [
            ctx.tenantId,
            req.params.id,
            nextVersion,
            b.fileName,
            b.mimeType,
            validated.sizeBytes,
            b.contentBase64,
            validated.ocrText,
            b.changeSummary,
            ctx.userId,
          ],
        );

        await db.query(
          `update document
              set current_version = $2, file_name = $3, mime_type = $4, size_bytes = $5,
                  content_base64 = $6, ocr_text = $7, checksum = $8, uploaded_by = $9
            where id = $1`,
          [
            req.params.id,
            nextVersion,
            b.fileName,
            b.mimeType,
            validated.sizeBytes,
            b.contentBase64,
            validated.ocrText,
            validated.checksum,
            ctx.userId,
          ],
        );

        await writeAudit(db, ctx, {
          action: 'version',
          entityType: 'document',
          entityId: req.params.id,
          after: { version: nextVersion, fileName: b.fileName, changeSummary: b.changeSummary },
          actorLabel: req.auth?.displayName,
        });

        reply.code(201);
        return { id: req.params.id, version: nextVersion };
      });
    },
  );

  // Version history (no base64 blobs).
  app.get<{ Params: { id: string } }>(
    '/api/documents/:id/versions',
    { preHandler: requirePermission('documents:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select version, file_name as "fileName", mime_type as "mimeType",
                  size_bytes as "sizeBytes", change_summary as "changeSummary",
                  uploaded_by as "uploadedBy", to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "createdAt"
             from document_version
            where document_id = $1
            order by version desc`,
          [req.params.id],
        );
        return { versions: rows };
      });
    },
  );

  // Return the binary payload for preview/download (optionally a specific version).
  app.get<{ Params: { id: string }; Querystring: { version?: string } }>(
    '/api/documents/:id/content',
    { preHandler: requirePermission('documents:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        if (req.query.version) {
          const { rows } = await db.query(
            `select file_name as "fileName", mime_type as "mimeType", content_base64 as "contentBase64"
               from document_version where document_id = $1 and version = $2`,
            [req.params.id, Number(req.query.version)],
          );
          if (!rows[0]) {
            reply.code(404);
            return { error: 'Version not found' };
          }
          return rows[0];
        }
        const { rows } = await db.query(
          `select file_name as "fileName", mime_type as "mimeType", content_base64 as "contentBase64"
             from document where id = $1`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Document not found' };
        }
        return rows[0];
      });
    },
  );

  // List cross-entity links for a document.
  app.get<{ Params: { id: string } }>(
    '/api/documents/:id/links',
    { preHandler: requirePermission('documents:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select entity_type as "entityType", entity_id as "entityId",
                  created_by as "createdBy", to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "createdAt"
             from document_link where document_id = $1
            order by created_at`,
          [req.params.id],
        );
        return { links: rows };
      });
    },
  );

  // Cross-link the same file to another record (no duplication).
  app.post<{ Params: { id: string } }>(
    '/api/documents/:id/links',
    { preHandler: requirePermission('documents:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = linkSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid link', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const doc = await db.query(`select id from document where id = $1`, [req.params.id]);
        if (!doc.rows[0]) {
          reply.code(404);
          return { error: 'Document not found' };
        }
        await db.query(
          `insert into document_link (tenant_id, document_id, entity_type, entity_id, created_by)
           values ($1,$2,$3,$4,$5)
           on conflict (tenant_id, document_id, entity_type, entity_id) do nothing`,
          [ctx.tenantId, req.params.id, b.entityType, b.entityId, ctx.userId],
        );
        await writeAudit(db, ctx, {
          action: 'link',
          entityType: 'document',
          entityId: req.params.id,
          after: { entityType: b.entityType, entityId: b.entityId },
          actorLabel: req.auth?.displayName,
        });
        reply.code(201);
        return { ok: true, entityType: b.entityType, entityId: b.entityId };
      });
    },
  );

  // Remove a cross-entity link.
  app.delete<{ Params: { id: string } }>(
    '/api/documents/:id/links',
    { preHandler: requirePermission('documents:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = linkSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid link', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const { rowCount } = await db.query(
          `delete from document_link where document_id = $1 and entity_type = $2 and entity_id = $3`,
          [req.params.id, b.entityType, b.entityId],
        );
        await writeAudit(db, ctx, {
          action: 'unlink',
          entityType: 'document',
          entityId: req.params.id,
          after: { entityType: b.entityType, entityId: b.entityId },
          actorLabel: req.auth?.displayName,
        });
        return { ok: true, removed: rowCount ?? 0 };
      });
    },
  );

  // Approval workflow: advance (or step back) through the legal state ladder.
  app.post<{ Params: { id: string } }>(
    '/api/documents/:id/transition',
    { preHandler: requirePermission('documents:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = transitionSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid transition', details: parsed.error.flatten() };
      }
      const to = parsed.data.to;
      return runAs(ctx, async (db) => {
        const cur = await db.query<{ doc_status: string }>(
          `select doc_status from document where id = $1`,
          [req.params.id],
        );
        if (!cur.rows[0]) {
          reply.code(404);
          return { error: 'Document not found' };
        }
        const from = cur.rows[0].doc_status;
        if (!(TRANSITIONS[from] ?? []).includes(to)) {
          reply.code(409);
          return { error: `Illegal transition ${from} -> ${to}` };
        }
        await db.query(`update document set doc_status = $2 where id = $1`, [req.params.id, to]);
        await writeAudit(db, ctx, {
          action: 'transition',
          entityType: 'document',
          entityId: req.params.id,
          before: { docStatus: from },
          after: { docStatus: to },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, from, to };
      });
    },
  );

  // AI field extraction. With an LLM key + captured text, prompt for reinsurance
  // fields with confidence; otherwise return a clearly-labelled empty result -
  // never fabricated values. Result is persisted to document.extraction.
  app.post<{ Params: { id: string } }>(
    '/api/documents/:id/extract',
    { preHandler: requirePermission('documents:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const doc = await db.query<{ ocr_text: string | null }>(
          `select ocr_text from document where id = $1`,
          [req.params.id],
        );
        if (!doc.rows[0]) {
          reply.code(404);
          return { error: 'Document not found' };
        }
        const ocrText = doc.rows[0].ocr_text;
        const extraction = await extractFields(ocrText);
        await db.query(`update document set extraction = $2 where id = $1`, [
          req.params.id,
          JSON.stringify(extraction),
        ]);
        await writeAudit(db, ctx, {
          action: 'extract',
          entityType: 'document',
          entityId: req.params.id,
          after: { llmUsed: extraction.llmUsed, note: extraction.note },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, extraction };
      });
    },
  );
}

const uploadSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  contentBase64: z.string().min(1),
  category: z.string().min(1).optional(),
  entityType: z.string().min(1),
  entityId: z.string().uuid(),
  tags: z.array(z.string()).optional(),
  changeSummary: z.string().optional(),
});

const versionSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  contentBase64: z.string().min(1),
  changeSummary: z.string().min(1),
});

const linkSchema = z.object({
  entityType: z.string().min(1),
  entityId: z.string().uuid(),
});

const transitionSchema = z.object({
  to: z.enum(['DRAFT', 'UPLOADED', 'REVIEWED', 'APPROVED', 'LOCKED', 'ARCHIVED']),
});

/**
 * Extract reinsurance fields from captured text. Uses the optional LLM only
 * when a key is configured AND text is present; parses a strict-JSON reply and
 * keeps value+confidence per field. Any absence or failure yields a labelled,
 * low-confidence empty result - values are never invented.
 */
async function extractFields(ocrText: string | null): Promise<Record<string, unknown> & { llmUsed: boolean; note: string }> {
  if (!ocrText || !ocrText.trim()) {
    return emptyExtraction('No text content available to extract from.') as never;
  }
  if (!isLlmEnabled()) {
    return emptyExtraction('AI extraction disabled (no model key configured); no values inferred.') as never;
  }
  const question =
    'Extract these reinsurance fields from the document text and reply with ONLY a JSON object ' +
    `whose keys are exactly ${JSON.stringify([...EXTRACTION_FIELDS])} and whose values are objects ` +
    '{"value": <string or null>, "confidence": <number 0..1>}. Use null with confidence 0 when a ' +
    'field is not present. Do not invent values.';
  const answer = await llmAnswer({ question, grounding: { documentText: ocrText.slice(0, 12000) } });
  if (!answer) {
    return emptyExtraction('AI extraction returned no response; falling back to empty result.') as never;
  }
  const fields: Record<string, { value: string | null; confidence: number }> = {};
  try {
    const start = answer.indexOf('{');
    const end = answer.lastIndexOf('}');
    const json = start >= 0 && end > start ? answer.slice(start, end + 1) : answer;
    const parsed = JSON.parse(json) as Record<string, { value?: unknown; confidence?: unknown }>;
    for (const f of EXTRACTION_FIELDS) {
      const raw = parsed[f];
      const value = raw && typeof raw.value === 'string' ? raw.value : null;
      const confidence = raw && typeof raw.confidence === 'number' ? raw.confidence : 0;
      fields[f] = { value, confidence };
    }
    return { llmUsed: true, note: 'Extracted via configured LLM.', fields };
  } catch {
    return emptyExtraction('AI response was not valid JSON; no values inferred.') as never;
  }
}

async function loadTemplate(
  db: Db,
  templateId?: string,
  templateKey?: string,
): Promise<TemplateRow | null> {
  if (templateId) {
    const { rows } = await db.query<TemplateRow>(
      `select id, key, name, doc_type, body from document_template where id = $1`,
      [templateId],
    );
    return rows[0] ?? null;
  }
  if (templateKey) {
    const { rows } = await db.query<TemplateRow>(
      `select id, key, name, doc_type, body
         from document_template
        where key = $1 and is_active
        order by version desc limit 1`,
      [templateKey],
    );
    return rows[0] ?? null;
  }
  return null;
}
