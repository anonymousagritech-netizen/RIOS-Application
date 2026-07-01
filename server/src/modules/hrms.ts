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
                  e.gender, e.date_of_birth as "dateOfBirth", e.blood_group as "bloodGroup",
                  e.marital_status as "maritalStatus", e.nationality,
                  e.personal_email as "personalEmail", e.phone, e.alt_phone as "altPhone", e.address,
                  e.pan, e.aadhaar, e.national_id as "nationalId", e.passport_no as "passportNo",
                  e.insurance_provider as "insuranceProvider", e.insurance_number as "insuranceNumber",
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
        const dependents = await db.query(
          `select id, name, relationship, to_char(date_of_birth,'YYYY-MM-DD') as "dateOfBirth",
                  phone, is_emergency as "isEmergency"
             from employee_dependent where employee_id = $1 order by is_emergency desc, created_at`,
          [req.params.id],
        );
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
          dependents: dependents.rows,
        };
      });
    },
  );

  // --- HR-managed personal / statutory profile ------------------------------
  const profileSchema = z.object({
    gender: z.string().optional(),
    dateOfBirth: z.string().optional(),
    bloodGroup: z.string().optional(),
    maritalStatus: z.string().optional(),
    nationality: z.string().optional(),
    personalEmail: z.string().optional(),
    phone: z.string().optional(),
    altPhone: z.string().optional(),
    address: z.string().optional(),
    pan: z.string().optional(),
    aadhaar: z.string().optional(),
    nationalId: z.string().optional(),
    passportNo: z.string().optional(),
    insuranceProvider: z.string().optional(),
    insuranceNumber: z.string().optional(),
  });

  app.put<{ Params: { id: string } }>(
    '/api/hr/employees/:id/profile',
    { preHandler: requirePermission('hr:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = profileSchema.safeParse(req.body);
      if (!parsed.success) { reply.code(400); return { error: 'Invalid profile', details: parsed.error.flatten() }; }
      const b = parsed.data;
      const empty = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `update employee set
             gender=$2, date_of_birth=$3, blood_group=$4, marital_status=$5, nationality=$6,
             personal_email=$7, phone=$8, alt_phone=$9, address=$10,
             pan=$11, aadhaar=$12, national_id=$13, passport_no=$14,
             insurance_provider=$15, insurance_number=$16
           where id=$1 and not is_deleted returning id`,
          [
            req.params.id, empty(b.gender), empty(b.dateOfBirth), empty(b.bloodGroup),
            empty(b.maritalStatus), empty(b.nationality), empty(b.personalEmail), empty(b.phone),
            empty(b.altPhone), empty(b.address), empty(b.pan), empty(b.aadhaar), empty(b.nationalId),
            empty(b.passportNo), empty(b.insuranceProvider), empty(b.insuranceNumber),
          ],
        );
        if (!rows[0]) { reply.code(404); return { error: 'Employee not found' }; }
        // Audit without echoing raw PII values - record which fields were set.
        const changed = Object.entries(b).filter(([, v]) => v && String(v).trim()).map(([k]) => k);
        await writeAudit(db, ctx, { action: 'update', entityType: 'employee_profile', entityId: req.params.id, after: { fields: changed } });
        return { id: req.params.id, updated: true };
      });
    },
  );

  const dependentSchema = z.object({
    name: z.string().min(1),
    relationship: z.string().min(1),
    dateOfBirth: z.string().optional(),
    phone: z.string().optional(),
    isEmergency: z.boolean().optional(),
  });

  app.post<{ Params: { id: string } }>(
    '/api/hr/employees/:id/dependents',
    { preHandler: requirePermission('hr:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = dependentSchema.safeParse(req.body);
      if (!parsed.success) { reply.code(400); return { error: 'Invalid dependent', details: parsed.error.flatten() }; }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `insert into employee_dependent (tenant_id, employee_id, name, relationship, date_of_birth, phone, is_emergency)
           values ($1,$2,$3,$4,$5,$6,$7) returning id`,
          [ctx.tenantId, req.params.id, b.name, b.relationship, b.dateOfBirth ?? null, b.phone ?? null, b.isEmergency ?? false],
        );
        await writeAudit(db, ctx, { action: 'create', entityType: 'employee_dependent', entityId: rows[0]!.id, after: { name: b.name, relationship: b.relationship } });
        reply.code(201);
        return { id: rows[0]!.id };
      });
    },
  );

  app.delete<{ Params: { id: string; depId: string } }>(
    '/api/hr/employees/:id/dependents/:depId',
    { preHandler: requirePermission('hr:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `delete from employee_dependent where id=$1 and employee_id=$2 returning id`,
          [req.params.depId, req.params.id],
        );
        if (!rows[0]) { reply.code(404); return { error: 'Dependent not found' }; }
        await writeAudit(db, ctx, { action: 'delete', entityType: 'employee_dependent', entityId: req.params.depId });
        return { ok: true };
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
