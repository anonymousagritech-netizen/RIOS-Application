/**
 * HRMS module (brief §9.14 - HR: employees, departments, leave).
 * Departments hold employees; employees file leave requests that managers
 * decide. Approving a leave request flips the employee to 'on_leave'.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { fromMajor } from '@rios/domain';
import { nextReference } from './parties.js';

const createDepartmentSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  parentId: z.string().uuid().optional(),
  costCentre: z.string().optional(),
});

const createEmployeeSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().optional(),
  departmentId: z.string().uuid().optional(),
  position: z.string().optional(),
  managerId: z.string().uuid().optional(),
  employmentType: z.enum(['full_time', 'contract', 'intern']).optional(),
  hireDate: z.string().optional(),
  baseSalary: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
});

const createLeaveSchema = z.object({
  employeeId: z.string().uuid(),
  kind: z.enum(['annual', 'sick', 'unpaid', 'parental', 'other']),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  days: z.number().nonnegative(),
  reason: z.string().optional(),
});

const decideLeaveSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
});

export async function hrmsModule(app: FastifyInstance): Promise<void> {
  // --- Departments -----------------------------------------------------------
  app.get('/api/hr/departments', { preHandler: requirePermission('hr:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select d.id, d.code, d.name, d.parent_id as "parentId", d.cost_centre as "costCentre",
                (select count(*) from employee e where e.department_id = d.id and not e.is_deleted) as "employeeCount"
           from department d
          order by d.name`,
      );
      return { departments: rows };
    });
  });

  app.post('/api/hr/departments', { preHandler: requirePermission('hr:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createDepartmentSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid department', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into department (tenant_id, code, name, parent_id, cost_centre)
         values ($1,$2,$3,$4,$5) returning id`,
        [ctx.tenantId, b.code, b.name, b.parentId ?? null, b.costCentre ?? null],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'department',
        entityId: id,
        after: { code: b.code, name: b.name },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, code: b.code };
    });
  });

  // --- Employees -------------------------------------------------------------
  app.get<{ Querystring: { departmentId?: string; status?: string } }>(
    '/api/hr/employees',
    { preHandler: requirePermission('hr:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select e.id, e.employee_no as "employeeNo", e.first_name as "firstName", e.last_name as "lastName",
                  e.email, e.department_id as "departmentId", e.position, e.manager_id as "managerId",
                  e.hire_date as "hireDate", e.base_salary_minor as "baseSalaryMinor", e.currency, e.status,
                  e.employment_type as "employmentType",
                  d.name as "departmentName"
             from employee e
             left join department d on d.id = e.department_id
            where not e.is_deleted
              and ($1::uuid is null or e.department_id = $1)
              and ($2::text is null or e.status = $2)
            order by e.created_at desc`,
          [req.query.departmentId ?? null, req.query.status ?? null],
        );
        return { employees: rows };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/hr/employees/:id',
    { preHandler: requirePermission('hr:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select e.id, e.employee_no as "employeeNo", e.first_name as "firstName", e.last_name as "lastName",
                  e.email, e.department_id as "departmentId", e.position, e.manager_id as "managerId",
                  e.hire_date as "hireDate", e.base_salary_minor as "baseSalaryMinor", e.currency, e.status,
                  e.employment_type as "employmentType",
                  d.name as "departmentName"
             from employee e
             left join department d on d.id = e.department_id
            where e.id = $1 and not e.is_deleted`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Employee not found' };
        }
        const leave = await db.query(
          `select id, kind, start_date as "startDate", end_date as "endDate", days, reason, status,
                  decided_by as "decidedBy", decided_at as "decidedAt"
             from leave_request where employee_id = $1 order by created_at desc`,
          [req.params.id],
        );
        // System role(s) from the Permission Engine, surfaced alongside the HR
        // designation/title so an employee's access is visible in HR context.
        const roles = await db.query(
          `select r.code, r.name from user_role ur join role r on r.id = ur.role_id
            where ur.user_id = (select user_id from employee where id = $1) order by r.name`,
          [req.params.id],
        );
        // Audited status-change history (active/on-leave/suspended/exited).
        const history = await db.query(
          `select from_status as "fromStatus", to_status as "toStatus", reason, changed_at as "changedAt"
             from employee_status_history where employee_id = $1 order by changed_at desc limit 20`,
          [req.params.id],
        );
        return {
          ...rows[0],
          leaveRequests: leave.rows,
          systemRoles: roles.rows,
          statusHistory: history.rows,
        };
      });
    },
  );

  app.post('/api/hr/employees', { preHandler: requirePermission('hr:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createEmployeeSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid employee', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    const salaryMinor =
      b.baseSalary !== undefined ? fromMajor(b.baseSalary, b.currency ?? 'USD').amount : null;
    return runAs(ctx, async (db) => {
      const employeeNo = await nextReference(db, ctx.tenantId, 'employee_reference', 'EMP');
      const { rows } = await db.query<{ id: string }>(
        `insert into employee
           (tenant_id, employee_no, first_name, last_name, email, department_id, position, manager_id,
            hire_date, base_salary_minor, currency, employment_type)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [
          ctx.tenantId, employeeNo, b.firstName, b.lastName, b.email ?? null, b.departmentId ?? null,
          b.position ?? null, b.managerId ?? null, b.hireDate ?? null, salaryMinor, b.currency ?? null,
          b.employmentType ?? 'full_time',
        ],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'employee',
        entityId: id,
        after: { employeeNo, firstName: b.firstName, lastName: b.lastName },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, employeeNo };
    });
  });

  // --- Leave -----------------------------------------------------------------
  app.post('/api/hr/leave', { preHandler: requirePermission('hr:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createLeaveSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid leave request', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into leave_request
           (tenant_id, employee_id, kind, start_date, end_date, days, reason, status)
         values ($1,$2,$3,$4,$5,$6,$7,'pending') returning id`,
        [ctx.tenantId, b.employeeId, b.kind, b.startDate, b.endDate, b.days, b.reason ?? null],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'leave_request',
        entityId: id,
        after: { employeeId: b.employeeId, kind: b.kind, days: b.days, status: 'pending' },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, status: 'pending' };
    });
  });

  app.get<{ Querystring: { status?: string; employeeId?: string } }>(
    '/api/hr/leave',
    { preHandler: requirePermission('hr:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select l.id, l.employee_id as "employeeId", l.kind, l.start_date as "startDate",
                  l.end_date as "endDate", l.days, l.reason, l.status,
                  l.decided_by as "decidedBy", l.decided_at as "decidedAt",
                  (e.first_name || ' ' || e.last_name) as "employeeName"
             from leave_request l
             join employee e on e.id = l.employee_id
            where ($1::text is null or l.status = $1)
              and ($2::uuid is null or l.employee_id = $2)
            order by l.created_at desc`,
          [req.query.status ?? null, req.query.employeeId ?? null],
        );
        return { leaveRequests: rows };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/hr/leave/:id/decide',
    { preHandler: requirePermission('hr:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = decideLeaveSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid decision', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const cur = await db.query<{ status: string; employee_id: string }>(
          `select status, employee_id from leave_request where id = $1`,
          [req.params.id],
        );
        if (!cur.rows[0]) {
          reply.code(404);
          return { error: 'Leave request not found' };
        }
        if (cur.rows[0].status !== 'pending') {
          reply.code(409);
          return { error: `Leave request is ${cur.rows[0].status}, not pending` };
        }
        await db.query(
          `update leave_request set status = $2, decided_by = $3, decided_at = now() where id = $1`,
          [req.params.id, b.decision, ctx.userId],
        );
        if (b.decision === 'approved') {
          await db.query(`update employee set status = 'on_leave' where id = $1`, [cur.rows[0].employee_id]);
        }
        await writeAudit(db, ctx, {
          action: 'decide',
          entityType: 'leave_request',
          entityId: req.params.id,
          before: { status: 'pending' },
          after: { status: b.decision },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, status: b.decision };
      });
    },
  );
}
