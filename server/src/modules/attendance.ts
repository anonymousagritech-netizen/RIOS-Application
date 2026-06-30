/**
 * Attendance module (HRMS). One row per signed-in user per working day with
 * punch in/out and accumulated break minutes, so the client can show live
 * working hours, today's status, and weekly/monthly history.
 *
 * Personal actions (punch in/out, break start/end, my history) only require a
 * valid session; the team view requires hr:read.
 */

import type { FastifyInstance } from 'fastify';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

interface AttendanceRow {
  id: string;
  workDate: string;
  punchInAt: string | null;
  punchOutAt: string | null;
  breakOpenAt: string | null;
  breakMinutes: number;
  status: string;
}

const SELECT = `select id, work_date as "workDate",
       punch_in_at as "punchInAt", punch_out_at as "punchOutAt",
       break_open_at as "breakOpenAt", break_minutes as "breakMinutes", status
  from attendance_record`;

/** Minutes actually worked: elapsed since punch-in, less breaks (open + closed). */
function workedMinutes(r: AttendanceRow, now = Date.now()): number {
  if (!r.punchInAt) return 0;
  const start = new Date(r.punchInAt).getTime();
  const end = r.punchOutAt ? new Date(r.punchOutAt).getTime() : now;
  let breaks = r.breakMinutes;
  if (r.breakOpenAt && !r.punchOutAt) {
    breaks += Math.max(0, Math.round((now - new Date(r.breakOpenAt).getTime()) / 60000));
  }
  return Math.max(0, Math.round((end - start) / 60000) - breaks);
}

function decorate(r: AttendanceRow) {
  return { ...r, workedMinutes: workedMinutes(r), onBreak: !!r.breakOpenAt && !r.punchOutAt };
}

export async function attendanceModule(app: FastifyInstance): Promise<void> {
  // Today's record + recent history for the signed-in user.
  app.get('/api/attendance/me', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const today = await db.query<AttendanceRow>(
        `${SELECT} where user_id = $1 and work_date = current_date`,
        [ctx.userId],
      );
      const history = await db.query<AttendanceRow>(
        `${SELECT} where user_id = $1 and work_date >= current_date - interval '30 days'
          order by work_date desc`,
        [ctx.userId],
      );
      return {
        today: today.rows[0] ? decorate(today.rows[0]) : null,
        history: history.rows.map(decorate),
      };
    });
  });

  async function upsertToday(ctx: { tenantId: string; userId: string }, mutate: string, params: unknown[] = []) {
    return runAs(ctx, async (db) => {
      await db.query(
        `insert into attendance_record (tenant_id, user_id, work_date, punch_in_at, status)
           values ($1, $2, current_date, now(), 'present')
         on conflict (tenant_id, user_id, work_date) do nothing`,
        [ctx.tenantId, ctx.userId],
      );
      if (mutate) {
        await db.query(
          `update attendance_record set ${mutate}, updated_at = now()
            where user_id = $1 and work_date = current_date`,
          [ctx.userId, ...params],
        );
      }
      const { rows } = await db.query<AttendanceRow>(
        `${SELECT} where user_id = $1 and work_date = current_date`,
        [ctx.userId],
      );
      return { record: rows[0] ? decorate(rows[0]) : null };
    });
  }

  app.post('/api/attendance/punch-in', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    // The insert already stamps punch_in_at; re-opening after checkout clears the checkout.
    return upsertToday(ctx, `punch_in_at = coalesce(punch_in_at, now()), punch_out_at = null, status = 'present'`);
  });

  app.post('/api/attendance/punch-out', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    // Close any open break, then stamp checkout.
    return upsertToday(
      ctx,
      `break_minutes = break_minutes + case when break_open_at is not null
          then greatest(0, round(extract(epoch from (now() - break_open_at)) / 60)) else 0 end,
        break_open_at = null,
        punch_out_at = now(),
        status = 'checked_out'`,
    );
  });

  app.post('/api/attendance/break/start', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return upsertToday(
      ctx,
      `break_open_at = case when break_open_at is null and punch_out_at is null then now() else break_open_at end,
        status = case when punch_out_at is null then 'on_break' else status end`,
    );
  });

  app.post('/api/attendance/break/end', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return upsertToday(
      ctx,
      `break_minutes = break_minutes + case when break_open_at is not null
          then greatest(0, round(extract(epoch from (now() - break_open_at)) / 60)) else 0 end,
        break_open_at = null,
        status = case when punch_out_at is null then 'present' else status end`,
    );
  });

  // Team view for a given day (HR).
  app.get('/api/attendance/team', { preHandler: requirePermission('hr:read') }, async (req) => {
    const ctx = authContext(req);
    const date = typeof (req.query as { date?: string })?.date === 'string'
      ? (req.query as { date: string }).date : null;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<AttendanceRow & { name: string; email: string }>(
        `select a.id, a.work_date as "workDate", a.punch_in_at as "punchInAt",
                a.punch_out_at as "punchOutAt", a.break_open_at as "breakOpenAt",
                a.break_minutes as "breakMinutes", a.status,
                u.display_name as name, u.email as email
           from attendance_record a
           join app_user u on u.id = a.user_id
          where a.work_date = coalesce($1::date, current_date)
          order by u.display_name`,
        [date],
      );
      return {
        date: date ?? 'today',
        records: rows.map((r) => ({ ...decorate(r), name: r.name, email: r.email })),
      };
    });
  });
}
