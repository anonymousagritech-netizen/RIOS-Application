/**
 * Employee self-service workspace: the data behind the personal dashboard
 * widgets (leave balance, upcoming holidays, team birthdays, announcements,
 * latest performance). Resolves the signed-in user's employee record by the
 * employee.user_id link (falling back to a matching email). Read-only; any
 * valid session may call it.
 */

import type { FastifyInstance } from 'fastify';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

const ANNUAL_ENTITLEMENT_DAYS = 20;

interface BirthdayRow { name: string; date_of_birth: string }

/** Days until the next anniversary of a month/day, ignoring the year. */
function daysUntilBirthday(dob: string, now = new Date()): number {
  const d = new Date(dob + 'T00:00:00');
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(today.getFullYear(), d.getMonth(), d.getDate());
  if (next < today) next = new Date(today.getFullYear() + 1, d.getMonth(), d.getDate());
  return Math.round((next.getTime() - today.getTime()) / 86400000);
}

export async function employeeWorkspaceModule(app: FastifyInstance): Promise<void> {
  app.get('/api/me/workspace', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const emp = await db.query<{ id: string; firstName: string }>(
        `select e.id, e.first_name as "firstName"
           from employee e
          where not e.is_deleted
            and (e.user_id = $1 or e.email = (select email from app_user where id = $1))
          limit 1`,
        [ctx.userId],
      );
      const employeeId = emp.rows[0]?.id ?? null;

      // Leave balance (annual, current year).
      let usedDays = 0;
      if (employeeId) {
        const lv = await db.query<{ used: string }>(
          `select coalesce(sum(days), 0) as used
             from leave_request
            where employee_id = $1 and kind = 'annual' and status = 'approved'
              and extract(year from start_date) = extract(year from current_date)`,
          [employeeId],
        );
        usedDays = Number(lv.rows[0]?.used ?? 0);
      }
      const leaveBalance = {
        entitlement: ANNUAL_ENTITLEMENT_DAYS,
        used: usedDays,
        remaining: Math.max(0, ANNUAL_ENTITLEMENT_DAYS - usedDays),
      };

      const holidays = await db.query<{ date: string; name: string }>(
        `select holiday_date as date, name from company_holiday
          where holiday_date >= current_date order by holiday_date limit 5`,
      );

      const bdayRows = await db.query<BirthdayRow>(
        `select (first_name || ' ' || last_name) as name, date_of_birth
           from employee
          where date_of_birth is not null and not is_deleted`,
      );
      const birthdays = bdayRows.rows
        .map((r) => ({ name: r.name, date: r.date_of_birth, inDays: daysUntilBirthday(r.date_of_birth) }))
        .filter((b) => b.inDays <= 45)
        .sort((a, b) => a.inDays - b.inDays)
        .slice(0, 5);

      const announcements = await db.query<{ title: string; body: string; category: string; postedAt: string }>(
        `select title, body, category, posted_at as "postedAt"
           from announcement order by posted_at desc limit 5`,
      );

      let performance: { period: string; band: string | null; overallScore: number } | null = null;
      if (employeeId) {
        const pr = await db.query<{ period: string; band: string | null; overallScore: string }>(
          `select period, band, overall_score as "overallScore"
             from performance_review where employee_id = $1
            order by created_at desc limit 1`,
          [employeeId],
        );
        if (pr.rows[0]) performance = { period: pr.rows[0].period, band: pr.rows[0].band, overallScore: Number(pr.rows[0].overallScore) };
      }

      return {
        hasEmployee: !!employeeId,
        leaveBalance,
        upcomingHolidays: holidays.rows,
        birthdays,
        announcements: announcements.rows,
        performance,
      };
    });
  });
}
