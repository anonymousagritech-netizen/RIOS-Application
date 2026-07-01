/**
 * Organization Management (brief §16 / Business Management). The corporate
 * structure: the org_unit hierarchy (group → company → branch → department) plus
 * the HR departments and their headcount, giving a single directory + reporting
 * structure. Reads gate on platform:read, writes on platform:write.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

export async function organizationModule(app: FastifyInstance): Promise<void> {
  // ---- Directory + reporting structure -------------------------------------
  app.get('/api/organization', { preHandler: requirePermission('platform:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const units = await db.query(
        `select u.id, u.code, u.name, u.kind, u.parent_id as "parentId",
                (select count(*) from org_unit c where c.parent_id = u.id)::int as "childCount",
                p.name as "parentName"
           from org_unit u left join org_unit p on p.id = u.parent_id
          order by u.kind, u.name`,
      );
      const byKind = await db.query<{ key: string; n: number }>(
        `select kind key, count(*)::int n from org_unit group by kind order by n desc`,
      );
      const departments = await db.query(
        `select d.id, d.name, coalesce(pd.name,'—') as "parentName",
                (select count(*) from employee e where e.department_id = d.id and not e.is_deleted)::int as headcount
           from department d left join department pd on pd.id = d.parent_id order by d.name`,
      );
      const emp = await db.query<{ n: string }>(`select count(*)::int n from employee where not is_deleted`);
      return {
        units: units.rows, byKind: byKind.rows, departments: departments.rows,
        totals: { units: units.rows.length, departments: departments.rows.length, employees: Number(emp.rows[0]!.n) },
      };
    });
  });

  // ---- Unit detail (children + members) ------------------------------------
  app.get<{ Params: { id: string } }>('/api/organization/:id', { preHandler: requirePermission('platform:read') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const u = await db.query(
        `select u.id, u.code, u.name, u.kind, u.parent_id as "parentId", p.name as "parentName"
           from org_unit u left join org_unit p on p.id = u.parent_id where u.id = $1`, [req.params.id]);
      if (!u.rows[0]) { reply.code(404); return { error: 'Org unit not found' }; }
      const children = await db.query(`select id, code, name, kind from org_unit where parent_id = $1 order by name`, [req.params.id]);
      return { ...u.rows[0], children: children.rows };
    });
  });

  // ---- Create a unit -------------------------------------------------------
  const unitSchema = z.object({
    code: z.string().min(1), name: z.string().min(1),
    kind: z.enum(['group', 'company', 'branch', 'department']).default('company'),
    parentId: z.string().uuid().nullable().optional(),
  });
  app.post('/api/organization', { preHandler: requirePermission('platform:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = unitSchema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid unit', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      try {
        const { rows } = await db.query<{ id: string }>(
          `insert into org_unit (tenant_id, code, name, kind, parent_id) values ($1,$2,$3,$4,$5) returning id`,
          [ctx.tenantId, b.code, b.name, b.kind, b.parentId ?? null]);
        await writeAudit(db, ctx, { action: 'org_unit_create', entityType: 'org_unit', entityId: rows[0]!.id, after: { code: b.code, kind: b.kind } });
        reply.code(201);
        return { id: rows[0]!.id };
      } catch (e) {
        reply.code(409); return { error: 'A unit with that code already exists' };
      }
    });
  });
}
