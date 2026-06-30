/**
 * Fastify application assembly. Registers cross-cutting concerns (CORS, error
 * shaping), the auth routes, a dashboard summary, and every domain module.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { login, AuthError, requirePermission, authContext, authenticate } from './auth.js';
import { runAs } from './db.js';
import { referenceModule } from './modules/reference.js';
import { partiesModule } from './modules/parties.js';
import { treatiesModule } from './modules/treaties.js';
import { accountingModule } from './modules/accounting.js';
import { claimsModule } from './modules/claims.js';
import { assistantModule } from './modules/assistant.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantCode: z.string().optional(),
});

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info') },
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(cors, { origin: true, credentials: true });

  app.get('/health', async () => ({ status: 'ok', service: 'rios-server', time: new Date().toISOString() }));

  // --- Auth ---
  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid login', details: parsed.error.flatten() };
    }
    try {
      const { token, user } = await login(parsed.data.email, parsed.data.password, parsed.data.tenantCode);
      return { token, user };
    } catch (err) {
      const e = err as AuthError;
      reply.code(e.status ?? 401);
      return { error: e.message };
    }
  });

  app.get('/api/auth/me', { preHandler: requirePermission() }, async (req) => {
    const user = await authenticate(req);
    return { user };
  });

  // --- Dashboard summary (executive KPIs, §13.5 / §30) ---
  app.get('/api/dashboard/summary', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{
        treaties: number;
        active_treaties: number;
        parties: number;
        open_claims: number;
        gwp_minor: number;
        outstanding_minor: number;
      }>(
        `select
           (select count(*)::int from contract where not is_deleted) as treaties,
           (select count(*)::int from contract where not is_deleted and status in ('BOUND','ACTIVE')) as active_treaties,
           (select count(*)::int from party where not is_deleted) as parties,
           (select count(*)::int from claim where not is_deleted and status not in ('CLOSED','SETTLED')) as open_claims,
           (select coalesce(sum(amount_minor),0)::bigint from financial_event
             where event_type in ('DEPOSIT_PREMIUM','INSTALMENT_PREMIUM','ADJUSTMENT_PREMIUM','MINIMUM_PREMIUM')) as gwp_minor,
           (select coalesce(sum(outstanding_minor),0)::bigint from claim where not is_deleted) as outstanding_minor`,
      );
      const recent = await db.query(
        `select reference, name, status, currency from contract where not is_deleted order by created_at desc limit 5`,
      );
      const byStatus = await db.query(
        `select status, count(*)::int as n from contract where not is_deleted group by status order by n desc`,
      );
      return {
        kpis: {
          treaties: rows[0]!.treaties,
          activeTreaties: rows[0]!.active_treaties,
          parties: rows[0]!.parties,
          openClaims: rows[0]!.open_claims,
          gwpMinor: Number(rows[0]!.gwp_minor),
          outstandingMinor: Number(rows[0]!.outstanding_minor),
          currency: 'USD',
        },
        recentTreaties: recent.rows,
        treatiesByStatus: byStatus.rows,
      };
    });
  });

  // --- Domain modules ---
  await app.register(referenceModule);
  await app.register(partiesModule);
  await app.register(treatiesModule);
  await app.register(accountingModule);
  await app.register(claimsModule);
  await app.register(assistantModule);

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    app.log.error(err);
    if (err instanceof AuthError) {
      reply.code(err.status).send({ error: err.message });
      return;
    }
    reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'Internal error' });
  });

  return app;
}
