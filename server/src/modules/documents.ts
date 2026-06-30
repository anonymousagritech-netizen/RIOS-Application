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
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

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
        const { rows } = await db.query(
          `select id, template_key as "templateKey", title, doc_type as "docType",
                  entity_type as "entityType", entity_id as "entityId", status,
                  created_at as "createdAt"
             from document
            where ($1::text is null or entity_type = $1)
              and ($2::uuid is null or entity_id = $2)
              and ($3::text is null or doc_type = $3)
            order by created_at desc`,
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
