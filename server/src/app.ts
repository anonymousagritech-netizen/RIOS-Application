/**
 * Fastify application assembly. Registers cross-cutting concerns (CORS, error
 * shaping), the auth routes, a dashboard summary, and every domain module.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { login, completeMfaLogin, AuthError, requirePermission, authContext, authenticate } from './auth.js';
import { runAs } from './db.js';
import { observabilityPlugin } from './observability.js';
import { referenceModule } from './modules/reference.js';
import { partiesModule } from './modules/parties.js';
import { treatiesModule } from './modules/treaties.js';
import { accountingModule } from './modules/accounting.js';
import { claimsModule } from './modules/claims.js';
import { assistantModule } from './modules/assistant.js';
import { facultativeModule } from './modules/facultative.js';
import { retrocessionModule } from './modules/retrocession.js';
import { placementModule } from './modules/placement.js';
import { pricingModule } from './modules/pricing.js';
import { bordereauxModule } from './modules/bordereaux.js';
import { exposureModule } from './modules/exposure.js';
import { statementsModule } from './modules/statements.js';
import { financeModule } from './modules/finance.js';
import { regulatoryModule } from './modules/regulatory.js';
import { automationModule } from './modules/automation.js';
import { documentsModule } from './modules/documents.js';
import { reportingModule } from './modules/reporting.js';
import { crmModule } from './modules/crm.js';
import { integrationModule } from './modules/integration.js';
import { hrmsModule } from './modules/hrms.js';
import { procurementModule } from './modules/procurement.js';
import { assetsModule } from './modules/assets.js';
import { operationsModule } from './modules/operations.js';
import { treatyAdjustmentsModule } from './modules/treatyAdjustments.js';
import { claimsAdvancedModule } from './modules/claimsAdvanced.js';
import { payrollModule } from './modules/payroll.js';
import { periodCloseModule } from './modules/periodClose.js';
import { regulatoryAdvancedModule } from './modules/regulatoryAdvanced.js';
import { securityModule } from './modules/security.js';
import { portalsModule } from './modules/portals.js';
import { designerModule } from './modules/designer.js';
import { analyticsModule } from './modules/analytics.js';
import { treasuryModule } from './modules/treasury.js';
import { riskCapitalModule } from './modules/riskCapital.js';
import { searchModule } from './modules/search.js';
import { retentionModule } from './modules/retention.js';
import { fieldSecurityModule } from './modules/fieldSecurity.js';
import { schedulerModule } from './modules/scheduler.js';
import { delegationModule } from './modules/delegation.js';
import { performanceModule } from './modules/performance.js';
import { productsModule } from './modules/products.js';

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
  // Called directly (not via register) so its metrics hooks are NOT encapsulated
  // and apply to every route registered afterwards.
  await observabilityPlugin(app);

  app.get('/health', async () => ({ status: 'ok', service: 'rios-server', time: new Date().toISOString() }));

  // --- Auth ---
  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid login', details: parsed.error.flatten() };
    }
    try {
      // Returns either { token, user } or, when MFA is enabled, { mfaRequired, mfaToken }.
      return await login(parsed.data.email, parsed.data.password, parsed.data.tenantCode);
    } catch (err) {
      const e = err as AuthError;
      reply.code(e.status ?? 401);
      return { error: e.message };
    }
  });

  // Second factor: exchange an MFA challenge token + TOTP code for an access token.
  app.post<{ Body: { mfaToken: string; code: string } }>('/api/auth/mfa/login', async (req, reply) => {
    const { mfaToken, code } = req.body ?? {};
    if (!mfaToken || !code) {
      reply.code(400);
      return { error: 'mfaToken and code are required' };
    }
    try {
      return await completeMfaLogin(mfaToken, String(code));
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
  // Reinsurance-core & operations modules
  await app.register(facultativeModule);
  await app.register(retrocessionModule);
  await app.register(placementModule);
  await app.register(pricingModule);
  await app.register(bordereauxModule);
  await app.register(exposureModule);
  // Accounting, regulatory & automation modules
  await app.register(statementsModule);
  await app.register(financeModule);
  await app.register(regulatoryModule);
  await app.register(automationModule);
  // Content, reporting, relationship & integration modules
  await app.register(documentsModule);
  await app.register(reportingModule);
  await app.register(crmModule);
  await app.register(integrationModule);
  // Corporate back-office & operations modules
  await app.register(hrmsModule);
  await app.register(procurementModule);
  await app.register(assetsModule);
  await app.register(operationsModule);
  // Depth modules (treaty adjustments, claims, payroll, period-close, regulatory)
  await app.register(treatyAdjustmentsModule);
  await app.register(claimsAdvancedModule);
  await app.register(payrollModule);
  await app.register(periodCloseModule);
  await app.register(regulatoryAdvancedModule);
  await app.register(securityModule);
  await app.register(portalsModule);
  await app.register(designerModule);
  await app.register(analyticsModule);
  await app.register(treasuryModule);
  await app.register(riskCapitalModule);
  await app.register(searchModule);
  await app.register(retentionModule);
  await app.register(fieldSecurityModule);
  await app.register(schedulerModule);
  await app.register(delegationModule);
  await app.register(performanceModule);
  await app.register(productsModule);

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
