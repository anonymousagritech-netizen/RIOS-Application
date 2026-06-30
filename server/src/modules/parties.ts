/**
 * Party module (brief §7 / §16.1 - party/role-centric).
 * A party can hold many roles; the list and detail views surface them together.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const createPartySchema = z.object({
  legalName: z.string().min(1),
  shortName: z.string().optional(),
  kind: z.enum(['organisation', 'individual', 'syndicate', 'pool', 'captive']).default('organisation'),
  country: z.string().length(2).optional(),
  roles: z.array(z.string()).default([]),
});

export async function partiesModule(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string; role?: string } }>(
    '/api/parties',
    { preHandler: requirePermission('party:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select p.id, p.reference, p.legal_name as "legalName", p.short_name as "shortName",
                  p.kind, p.country, p.status,
                  coalesce(array_agg(pr.role_code) filter (where pr.role_code is not null), '{}') as roles
             from party p
             left join party_role pr on pr.party_id = p.id and pr.is_active
            where not p.is_deleted
              and ($1::text is null or p.legal_name ilike '%'||$1||'%' or p.short_name ilike '%'||$1||'%')
              and ($2::citext is null or exists (
                    select 1 from party_role x where x.party_id = p.id and x.role_code = $2 and x.is_active))
            group by p.id
            order by p.legal_name`,
          [req.query.q ?? null, req.query.role ?? null],
        );
        return { parties: rows };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/parties/:id',
    { preHandler: requirePermission('party:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select p.id, p.reference, p.legal_name as "legalName", p.short_name as "shortName",
                  p.kind, p.country, p.status, p.identifiers,
                  coalesce(array_agg(pr.role_code) filter (where pr.role_code is not null), '{}') as roles
             from party p left join party_role pr on pr.party_id = p.id and pr.is_active
            where p.id = $1 and not p.is_deleted group by p.id`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Party not found' };
        }
        return rows[0];
      });
    },
  );

  app.post('/api/parties', { preHandler: requirePermission('party:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createPartySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid party', details: parsed.error.flatten() };
    }
    const body = parsed.data;
    return runAs(ctx, async (db) => {
      const ref = await nextReference(db, ctx.tenantId, 'party_reference', 'PTY');
      const { rows } = await db.query<{ id: string }>(
        `insert into party (tenant_id, reference, legal_name, short_name, kind, country)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [ctx.tenantId, ref, body.legalName, body.shortName ?? null, body.kind, body.country ?? null],
      );
      const id = rows[0]!.id;
      for (const role of body.roles) {
        await db.query(
          `insert into party_role (tenant_id, party_id, role_code) values ($1,$2,$3)
           on conflict do nothing`,
          [ctx.tenantId, id, role],
        );
      }
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'party',
        entityId: id,
        after: { legalName: body.legalName, roles: body.roles },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, reference: ref };
    });
  });
}

/** Generate the next reference from a numbering scheme, atomically. */
export async function nextReference(
  db: { query: (t: string, p?: unknown[]) => Promise<{ rows: { next_seq: number }[] }> },
  tenantId: string,
  key: string,
  fallbackPrefix: string,
): Promise<string> {
  const res = await db.query(
    `update numbering_scheme set next_seq = next_seq + 1
      where tenant_id = $1 and key = $2
      returning next_seq - 1 as next_seq, pattern, prefix`,
    [tenantId, key],
  );
  const row = res.rows[0] as { next_seq: number; pattern?: string; prefix?: string } | undefined;
  const seq = row?.next_seq ?? Date.now() % 100000;
  const year = new Date().getUTCFullYear();
  const pattern = (row as { pattern?: string } | undefined)?.pattern ?? `${fallbackPrefix}-{YYYY}-{SEQ:5}`;
  return pattern
    .replace('{YYYY}', String(year))
    .replace(/\{SEQ:(\d+)\}/, (_m, width: string) => String(seq).padStart(Number(width), '0'));
}
