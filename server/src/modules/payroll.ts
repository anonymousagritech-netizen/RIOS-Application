/**
 * Payroll module (brief §9.14 — HR payroll runs).
 *
 * A payroll run sweeps every active employee with a base salary and computes a
 * gross-to-net payslip via @rios/domain `runPayslip` (progressive income tax,
 * employee/employer social contributions). The run is recorded in draft with
 * workforce totals from `payrollRunTotals`, one `payslip` per employee, and may
 * later be approved. Money on the wire is MAJOR units (tax-band thresholds),
 * converted to minor via `fromMajor`; salaries are already stored in minor units.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  runPayslip,
  payrollRunTotals,
  fromMajor,
  money,
  type PayrollInput,
  type PayslipResult,
} from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const createRunSchema = z.object({
  period: z.string().min(1),
  payDate: z.string().optional(),
  currency: z.string().length(3),
  taxBands: z
    .array(z.object({ from: z.number().nonnegative(), rate: z.number() }))
    .default([]),
  employeeSocialRate: z.number().nonnegative(),
  employerSocialRate: z.number().nonnegative(),
});

export async function payrollModule(app: FastifyInstance): Promise<void> {
  // Run payroll for the period: a payslip per active, salaried employee.
  app.post('/api/hr/payroll/runs', { preHandler: requirePermission('hr:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createRunSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payroll run', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    // Tax-band thresholds arrive in MAJOR units; convert to minor for the domain core.
    const taxBands = b.taxBands.map((band) => ({
      from: fromMajor(band.from, b.currency).amount,
      rate: band.rate,
    }));

    return runAs(ctx, async (db) => {
      const emps = await db.query<{ id: string; base_salary_minor: number | null }>(
        `select id, base_salary_minor from employee
          where not is_deleted and status = 'active' and base_salary_minor is not null`,
      );

      const slips: { employeeId: string; result: PayslipResult }[] = [];
      for (const e of emps.rows) {
        const input: PayrollInput = {
          baseSalary: money(Number(e.base_salary_minor ?? 0), b.currency),
          taxBands,
          employeeSocialRate: b.employeeSocialRate,
          employerSocialRate: b.employerSocialRate,
        };
        slips.push({ employeeId: e.id, result: runPayslip(input) });
      }

      const totals = payrollRunTotals(
        slips.map((s) => s.result),
        b.currency,
      );

      const run = await db.query<{ id: string }>(
        `insert into payroll_run
           (tenant_id, period, pay_date, currency, status,
            total_gross_minor, total_net_minor, total_tax_minor, total_employer_cost_minor,
            headcount, created_by)
         values ($1,$2,coalesce($3, current_date),$4,'draft',$5,$6,$7,$8,$9,$10) returning id`,
        [
          ctx.tenantId, b.period, b.payDate ?? null, b.currency,
          totals.totalGross.amount, totals.totalNet.amount, totals.totalTax.amount,
          totals.totalEmployerCost.amount, totals.headcount, ctx.userId,
        ],
      );
      const id = run.rows[0]!.id;

      for (const s of slips) {
        const r = s.result;
        await db.query(
          `insert into payslip
             (tenant_id, payroll_run_id, employee_id, gross_minor, taxable_minor, income_tax_minor,
              employee_social_minor, net_minor, employer_cost_minor, currency, detail)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            ctx.tenantId, id, s.employeeId, r.gross.amount, r.taxablePay.amount, r.incomeTax.amount,
            r.employeeSocial.amount, r.net.amount, r.employerCost.amount, b.currency,
            JSON.stringify({
              grossMinor: r.gross.amount,
              taxableMinor: r.taxablePay.amount,
              incomeTaxMinor: r.incomeTax.amount,
              employeeSocialMinor: r.employeeSocial.amount,
              netMinor: r.net.amount,
              employerSocialMinor: r.employerSocial.amount,
              employerCostMinor: r.employerCost.amount,
            }),
          ],
        );
      }

      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'payroll_run',
        entityId: id,
        after: {
          period: b.period,
          headcount: totals.headcount,
          totalGrossMinor: totals.totalGross.amount,
          totalNetMinor: totals.totalNet.amount,
        },
        actorLabel: req.auth?.displayName,
      });

      reply.code(201);
      return {
        id,
        period: b.period,
        headcount: totals.headcount,
        totalGrossMinor: totals.totalGross.amount,
        totalNetMinor: totals.totalNet.amount,
      };
    });
  });

  // List runs, newest first.
  app.get('/api/hr/payroll/runs', { preHandler: requirePermission('hr:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, period, pay_date as "payDate", currency, status,
                total_gross_minor as "totalGrossMinor", total_net_minor as "totalNetMinor",
                total_tax_minor as "totalTaxMinor", total_employer_cost_minor as "totalEmployerCostMinor",
                headcount, created_at as "createdAt"
           from payroll_run order by created_at desc`,
      );
      return { runs: rows };
    });
  });

  // A run plus its payslips, joined to employee name.
  app.get<{ Params: { id: string } }>(
    '/api/hr/payroll/runs/:id',
    { preHandler: requirePermission('hr:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const run = await db.query(
          `select id, period, pay_date as "payDate", currency, status,
                  total_gross_minor as "totalGrossMinor", total_net_minor as "totalNetMinor",
                  total_tax_minor as "totalTaxMinor", total_employer_cost_minor as "totalEmployerCostMinor",
                  headcount, created_at as "createdAt"
             from payroll_run where id = $1`,
          [req.params.id],
        );
        if (!run.rows[0]) {
          reply.code(404);
          return { error: 'Payroll run not found' };
        }
        const slips = await db.query(
          `select p.id, p.employee_id as "employeeId", p.gross_minor as "grossMinor",
                  p.taxable_minor as "taxableMinor", p.income_tax_minor as "incomeTaxMinor",
                  p.employee_social_minor as "employeeSocialMinor", p.net_minor as "netMinor",
                  p.employer_cost_minor as "employerCostMinor", p.currency, p.detail,
                  (e.first_name || ' ' || e.last_name) as "employeeName"
             from payslip p
             join employee e on e.id = p.employee_id
            where p.payroll_run_id = $1
            order by e.last_name, e.first_name`,
          [req.params.id],
        );
        return { ...run.rows[0], payslips: slips.rows };
      });
    },
  );

  // Approve a draft run (locks it for payment).
  app.post<{ Params: { id: string } }>(
    '/api/hr/payroll/runs/:id/approve',
    { preHandler: requirePermission('hr:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const cur = await db.query<{ status: string }>(
          `select status from payroll_run where id = $1`,
          [req.params.id],
        );
        if (!cur.rows[0]) {
          reply.code(404);
          return { error: 'Payroll run not found' };
        }
        if (cur.rows[0].status !== 'draft') {
          reply.code(409);
          return { error: `Payroll run is ${cur.rows[0].status}, not draft` };
        }
        await db.query(`update payroll_run set status = 'approved' where id = $1`, [req.params.id]);
        await writeAudit(db, ctx, {
          action: 'approve',
          entityType: 'payroll_run',
          entityId: req.params.id,
          before: { status: 'draft' },
          after: { status: 'approved' },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, status: 'approved' };
      });
    },
  );
}
