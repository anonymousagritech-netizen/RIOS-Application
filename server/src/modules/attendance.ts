/**
 * Attendance module (HRMS). One row per signed-in user per working day with
 * punch in/out and accumulated break minutes, so the client can show live
 * working hours, today's status, and weekly/monthly history.
 *
 * Punches are geofenced: if the tenant has office locations configured, the
 * device coordinates must fall within an office radius plus a tolerance buffer
 * (great-circle distance). Personal actions only require a valid session; the
 * team view, CSV export and office management require hr:read / hr:write.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkGeofence, type OfficeGeofence } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

interface AttendanceRow {
  id: string;
  workDate: string;
  punchInAt: string | null;
  punchOutAt: string | null;
  breakOpenAt: string | null;
  breakMinutes: number;
  status: string;
  geofenceOk?: boolean | null;
}

const SELECT = `select id, work_date as "workDate",
       punch_in_at as "punchInAt", punch_out_at as "punchOutAt",
       break_open_at as "breakOpenAt", break_minutes as "breakMinutes", status,
       geofence_ok as "geofenceOk"
  from attendance_record`;

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

const coordsSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});
const officeSchema = z.object({
  name: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMeters: z.number().int().positive().max(100_000).default(150),
  bufferMeters: z.number().int().min(0).max(100_000).default(50),
  address: z.string().optional(),
});

export async function attendanceModule(app: FastifyInstance): Promise<void> {
  async function activeOffices(db: Db): Promise<OfficeGeofence[]> {
    const { rows } = await db.query<{ lat: number; lng: number; radiusMeters: number; bufferMeters: number }>(
      `select latitude as lat, longitude as lng, radius_meters as "radiusMeters", buffer_meters as "bufferMeters"
         from office_location where is_active`,
    );
    return rows;
  }

  app.get('/api/attendance/me', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const today = await db.query<AttendanceRow>(`${SELECT} where user_id = $1 and work_date = current_date`, [ctx.userId]);
      const history = await db.query<AttendanceRow>(
        `${SELECT} where user_id = $1 and work_date >= current_date - interval '30 days' order by work_date desc`,
        [ctx.userId],
      );
      const offices = await db.query<{ name: string }>(`select name from office_location where is_active`);
      return {
        today: today.rows[0] ? decorate(today.rows[0]) : null,
        history: history.rows.map(decorate),
        geofenced: offices.rows.length > 0,
      };
    });
  });

  // Geofence gate shared by punch in/out.
  async function geoGate(
    db: Db,
    body: unknown,
  ): Promise<{ ok: true; lat: number | null; lng: number | null; distance: number | null; geofenceOk: boolean | null }
            | { ok: false; distance: number; allowed: number }> {
    const parsed = coordsSchema.safeParse(body ?? {});
    const lat = parsed.success ? parsed.data.lat ?? null : null;
    const lng = parsed.success ? parsed.data.lng ?? null : null;
    const offices = await activeOffices(db);
    if (!offices.length) return { ok: true, lat, lng, distance: null, geofenceOk: null };
    if (lat == null || lng == null) {
      // Geofencing on but no coordinates supplied -> reject.
      return { ok: false, distance: -1, allowed: offices[0]!.radiusMeters + (offices[0]!.bufferMeters ?? 0) };
    }
    const check = checkGeofence({ lat, lng }, offices);
    if (!check.ok) return { ok: false, distance: check.distanceMeters, allowed: check.allowedMeters };
    return { ok: true, lat, lng, distance: check.distanceMeters, geofenceOk: true };
  }

  app.post('/api/attendance/punch-in', { preHandler: requirePermission() }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const gate = await geoGate(db, req.body);
      if (!gate.ok) {
        reply.code(403);
        return { error: 'Outside the allowed work area', distanceMeters: gate.distance, allowedMeters: gate.allowed };
      }
      await db.query(
        `insert into attendance_record (tenant_id, user_id, work_date, punch_in_at, status, punch_in_lat, punch_in_lng, geofence_ok, punch_in_distance_m)
           values ($1, $2, current_date, now(), 'present', $3, $4, $5, $6)
         on conflict (tenant_id, user_id, work_date)
         do update set punch_in_at = coalesce(attendance_record.punch_in_at, now()),
                       punch_out_at = null, status = 'present',
                       punch_in_lat = coalesce(attendance_record.punch_in_lat, excluded.punch_in_lat),
                       punch_in_lng = coalesce(attendance_record.punch_in_lng, excluded.punch_in_lng),
                       geofence_ok = excluded.geofence_ok,
                       punch_in_distance_m = excluded.punch_in_distance_m,
                       updated_at = now()`,
        [ctx.tenantId, ctx.userId, gate.lat, gate.lng, gate.geofenceOk, gate.distance],
      );
      const { rows } = await db.query<AttendanceRow>(`${SELECT} where user_id = $1 and work_date = current_date`, [ctx.userId]);
      return { record: rows[0] ? decorate(rows[0]) : null };
    });
  });

  async function mutateToday(ctx: { tenantId: string; userId: string }, mutate: string, params: unknown[] = []) {
    return runAs(ctx, async (db) => {
      await db.query(
        `insert into attendance_record (tenant_id, user_id, work_date, punch_in_at, status)
           values ($1, $2, current_date, now(), 'present')
         on conflict (tenant_id, user_id, work_date) do nothing`,
        [ctx.tenantId, ctx.userId],
      );
      await db.query(`update attendance_record set ${mutate}, updated_at = now() where user_id = $1 and work_date = current_date`, [ctx.userId, ...params]);
      const { rows } = await db.query<AttendanceRow>(`${SELECT} where user_id = $1 and work_date = current_date`, [ctx.userId]);
      return { record: rows[0] ? decorate(rows[0]) : null };
    });
  }

  app.post('/api/attendance/punch-out', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    const parsed = coordsSchema.safeParse(req.body ?? {});
    const lat = parsed.success ? parsed.data.lat ?? null : null;
    const lng = parsed.success ? parsed.data.lng ?? null : null;
    return mutateToday(
      ctx,
      `break_minutes = break_minutes + case when break_open_at is not null
          then greatest(0, round(extract(epoch from (now() - break_open_at)) / 60)) else 0 end,
        break_open_at = null, punch_out_at = now(), status = 'checked_out',
        punch_out_lat = $2, punch_out_lng = $3`,
      [lat, lng],
    );
  });

  app.post('/api/attendance/break/start', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return mutateToday(ctx, `break_open_at = case when break_open_at is null and punch_out_at is null then now() else break_open_at end,
        status = case when punch_out_at is null then 'on_break' else status end`);
  });

  app.post('/api/attendance/break/end', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return mutateToday(ctx, `break_minutes = break_minutes + case when break_open_at is not null
          then greatest(0, round(extract(epoch from (now() - break_open_at)) / 60)) else 0 end,
        break_open_at = null, status = case when punch_out_at is null then 'present' else status end`);
  });

  // Team view for a given day (HR/admin): who is present, when, plus a summary.
  app.get('/api/attendance/team', { preHandler: requirePermission('hr:read') }, async (req) => {
    const ctx = authContext(req);
    const date = typeof (req.query as { date?: string })?.date === 'string' ? (req.query as { date: string }).date : null;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<AttendanceRow & { name: string; email: string }>(
        `select a.id, a.work_date as "workDate", a.punch_in_at as "punchInAt", a.punch_out_at as "punchOutAt",
                a.break_open_at as "breakOpenAt", a.break_minutes as "breakMinutes", a.status, a.geofence_ok as "geofenceOk",
                u.display_name as name, u.email as email
           from attendance_record a join app_user u on u.id = a.user_id
          where a.work_date = coalesce($1::date, current_date)
          order by u.display_name`,
        [date],
      );
      const records = rows.map((r) => ({ ...decorate(r), name: r.name, email: r.email }));
      const present = records.filter((r) => r.status !== 'checked_out' && r.punchInAt).length;
      const checkedOut = records.filter((r) => r.status === 'checked_out').length;
      const onBreak = records.filter((r) => r.onBreak).length;
      return { date: date ?? 'today', summary: { total: records.length, present, checkedOut, onBreak }, records };
    });
  });

  // CSV export of attendance over a date range (HR/admin).
  app.get('/api/attendance/export', { preHandler: requirePermission('hr:read') }, async (req, reply) => {
    const ctx = authContext(req);
    const q = req.query as { from?: string; to?: string };
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<AttendanceRow & { name: string; email: string }>(
        `select a.work_date as "workDate", a.punch_in_at as "punchInAt", a.punch_out_at as "punchOutAt",
                a.break_minutes as "breakMinutes", a.status, a.geofence_ok as "geofenceOk",
                u.display_name as name, u.email as email
           from attendance_record a join app_user u on u.id = a.user_id
          where a.work_date between coalesce($1::date, current_date - interval '30 days') and coalesce($2::date, current_date)
          order by a.work_date desc, u.display_name`,
        [q.from ?? null, q.to ?? null],
      );
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = ['Employee', 'Email', 'Date', 'Punch In', 'Punch Out', 'Worked (min)', 'Break (min)', 'Status', 'Geofence'];
      const lines = rows.map((r) => [
        r.name, r.email, r.workDate,
        r.punchInAt ?? '', r.punchOutAt ?? '',
        workedMinutes(r), r.breakMinutes, r.status,
        r.geofenceOk == null ? '' : r.geofenceOk ? 'ok' : 'outside',
      ].map(esc).join(','));
      const csv = [header.map(esc).join(','), ...lines].join('\r\n');
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="attendance-${q.from ?? 'last30'}-${q.to ?? 'today'}.csv"`);
      return csv;
    });
  });

  // Office locations (geofences) - list for everyone, manage with hr:write.
  app.get('/api/attendance/offices', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, name, latitude, longitude, radius_meters as "radiusMeters", buffer_meters as "bufferMeters",
                address, is_active as "isActive" from office_location order by name`,
      );
      return { offices: rows };
    });
  });

  app.post('/api/attendance/offices', { preHandler: requirePermission('hr:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = officeSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid office', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into office_location (tenant_id, name, latitude, longitude, radius_meters, buffer_meters, address)
           values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [ctx.tenantId, b.name, b.latitude, b.longitude, b.radiusMeters, b.bufferMeters, b.address ?? null],
      );
      await writeAudit(db, ctx, { action: 'create', entityType: 'office_location', entityId: rows[0]!.id, after: b });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });
}
