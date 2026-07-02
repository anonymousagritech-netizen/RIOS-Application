/**
 * Fastify application assembly. Registers cross-cutting concerns (CORS, error
 * shaping), the auth routes, a dashboard summary, and every domain module.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { z } from 'zod';
import { login, completeMfaLogin, AuthError, requirePermission, authContext, authenticate } from './auth.js';
import { runAs, appPool } from './db.js';
import { config } from './config.js';
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
import { soaVerificationModule } from './modules/soaVerification.js';
import { accountCurrentModule } from './modules/accountCurrent.js';
import { multiGaapModule } from './modules/multiGaap.js';
import { reservingWorkflowModule } from './modules/reservingWorkflow.js';
import { accumulationModule } from './modules/accumulation.js';
import { jurisdictionPacksModule } from './modules/jurisdictionPacks.js';
import { financeModule } from './modules/finance.js';
import { financialStatementsModule } from './modules/financialStatements.js';
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
import { earningsModule } from './modules/earnings.js';
import { payrollModule } from './modules/payroll.js';
import { periodCloseModule } from './modules/periodClose.js';
import { regulatoryAdvancedModule } from './modules/regulatoryAdvanced.js';
import { securityModule } from './modules/security.js';
import { portalsModule } from './modules/portals.js';
import { designerModule } from './modules/designer.js';
import { analyticsModule } from './modules/analytics.js';
import { treasuryModule } from './modules/treasury.js';
import { bureauModule } from './modules/bureau.js';
import { catModelModule } from './modules/catmodel.js';
import { sanctionsFeedModule } from './modules/sanctionsFeed.js';
import { riskCapitalModule } from './modules/riskCapital.js';
import { searchModule } from './modules/search.js';
import { retentionModule } from './modules/retention.js';
import { fieldSecurityModule } from './modules/fieldSecurity.js';
import { schedulerModule } from './modules/scheduler.js';
import { delegationModule } from './modules/delegation.js';
import { performanceModule } from './modules/performance.js';
import { attendanceModule } from './modules/attendance.js';
import { employeeWorkspaceModule } from './modules/employeeWorkspace.js';
import { hrAttendanceModule } from './modules/hrAttendance.js';
import { underwritingModule } from './modules/underwriting.js';
import { underwritingAnalyticsModule } from './modules/underwritingAnalytics.js';
import { brokersModule } from './modules/brokers.js';
import { cedentsModule } from './modules/cedents.js';
import { capacityMgmtModule } from './modules/capacityMgmt.js';
import { exposureMgmtModule } from './modules/exposureMgmt.js';
import { territoriesModule } from './modules/territories.js';
import { territoryMgmtModule } from './modules/territoryMgmt.js';
import { tasksModule } from './modules/tasks.js';
import { auditLogModule } from './modules/auditLog.js';
import { notificationsModule } from './modules/notifications.js';
import { clientsModule } from './modules/clients.js';
import { treatyAdminModule } from './modules/treatyAdmin.js';
import { organizationModule } from './modules/organization.js';
import { scheduledReportsModule } from './modules/scheduledReports.js';
import { executiveModule } from './modules/executive.js';
import { complianceModule } from './modules/compliance.js';
import { facultativeAdminModule } from './modules/facultativeAdmin.js';
import { workflowEngineModule } from './modules/workflowEngine.js';
import { searchEnhancedModule } from './modules/searchEnhanced.js';
import { aiInsightsModule } from './modules/aiInsights.js';
import { productsModule } from './modules/products.js';
import { formulasModule } from './modules/formulas.js';
import { platformModule } from './modules/platform.js';
import { costModule } from './modules/cost.js';
import { messagingModule } from './modules/messaging.js';
import { eventBusModule } from './modules/eventbus.js';
import { connectorsModule } from './modules/connectors.js';
import { devPortalModule } from './modules/devportal.js';
import { kmsModule } from './modules/kms.js';
import { securityOpsModule } from './modules/securityOps.js';
import { samlModule } from './modules/saml.js';
import { intelligenceModule } from './modules/intelligence.js';
import { mobileModule } from './modules/mobile.js';
import { webauthnModule } from './modules/webauthn.js';
import { marketplaceModule } from './modules/marketplace.js';
import { automationStudioModule } from './modules/automationStudio.js';
import { assistantEvalModule } from './modules/assistantEval.js';

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
  // Cookie plugin: parses Cookie header into req.cookies and provides reply.setCookie/clearCookie.
  await app.register(cookie, { secret: config.jwtSecret });
  // Called directly (not via register) so its metrics hooks are NOT encapsulated
  // and apply to every route registered afterwards.
  await observabilityPlugin(app);

  app.get('/health', async () => ({ status: 'ok', service: 'rios-server', time: new Date().toISOString() }));

  // --- Auth ---
  // Login rate limiting (defect D-4): a fixed 15-minute window per IP+email.
  // After 10 failed attempts the account/IP pair is locked out for the rest of
  // the window; a successful login clears the counter. In-memory by design:
  // multi-instance deployments should back this with Redis.
  const LOGIN_WINDOW_MS = 15 * 60 * 1000;
  const LOGIN_MAX_FAILURES = 10;
  const loginFailures = new Map<string, { count: number; windowStart: number }>();
  const loginKey = (req: { ip: string }, email: string) => `${req.ip}|${email.toLowerCase()}`;

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid login', details: parsed.error.flatten() };
    }
    const key = loginKey(req, parsed.data.email);
    const now = Date.now();
    const entry = loginFailures.get(key);
    if (entry && now - entry.windowStart < LOGIN_WINDOW_MS && entry.count >= LOGIN_MAX_FAILURES) {
      reply.code(429);
      return { error: 'Too many failed login attempts. Try again later.' };
    }
    try {
      // Returns either { token, jti, user } or, when MFA is enabled, { mfaRequired, mfaToken }.
      const result = await login(parsed.data.email, parsed.data.password, parsed.data.tenantCode);
      loginFailures.delete(key);
      if ('token' in result) {
        // Set the token as an httpOnly SameSite=Strict cookie so the browser
        // sends it automatically without JS being able to read it (XSS defence).
        reply.setCookie('rios_token', result.token, {
          httpOnly: true,
          sameSite: 'strict',
          secure: config.env === 'production',
          path: '/',
          maxAge: 60 * 60, // 1 hour
        });
        // Also return the token in the body for API clients / backwards compat.
        return { token: result.token, user: result.user, expiresIn: 3600 };
      }
      return result;
    } catch (err) {
      const fresh = !entry || now - entry.windowStart >= LOGIN_WINDOW_MS;
      loginFailures.set(key, fresh ? { count: 1, windowStart: now } : { count: entry.count + 1, windowStart: entry.windowStart });
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
      const result = await completeMfaLogin(mfaToken, String(code));
      // Set the httpOnly cookie for the completed MFA session.
      reply.setCookie('rios_token', result.token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.env === 'production',
        path: '/',
        maxAge: 60 * 60, // 1 hour
      });
      return { token: result.token, user: result.user, expiresIn: 3600 };
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

  // Logout: record the token's jti in the revocation list and clear the cookie.
  app.post('/api/auth/logout', { preHandler: requirePermission() }, async (req, reply) => {
    const ctx = authContext(req);
    if (ctx.jti) {
      await appPool.query(
        'INSERT INTO token_revocation (jti, user_id, tenant_id, reason) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [ctx.jti, ctx.userId, ctx.tenantId, 'logout'],
      );
    }
    reply.clearCookie('rios_token', { path: '/' });
    return { success: true };
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
  await app.register(accumulationModule);
  // Accounting, regulatory & automation modules
  await app.register(statementsModule);
  await app.register(soaVerificationModule);
  await app.register(accountCurrentModule);
  await app.register(multiGaapModule);
  await app.register(reservingWorkflowModule);
  await app.register(financeModule);
  await app.register(financialStatementsModule);
  await app.register(regulatoryModule);
  await app.register(jurisdictionPacksModule);
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
  await app.register(earningsModule);
  await app.register(payrollModule);
  await app.register(periodCloseModule);
  await app.register(regulatoryAdvancedModule);
  await app.register(securityModule);
  await app.register(portalsModule);
  await app.register(designerModule);
  await app.register(analyticsModule);
  await app.register(treasuryModule);
  await app.register(bureauModule);
  await app.register(catModelModule);
  await app.register(sanctionsFeedModule);
  await app.register(riskCapitalModule);
  await app.register(searchModule);
  await app.register(retentionModule);
  await app.register(fieldSecurityModule);
  await app.register(schedulerModule);
  await app.register(delegationModule);
  await app.register(performanceModule);
  await app.register(attendanceModule);
  await app.register(employeeWorkspaceModule);
  await app.register(hrAttendanceModule);
  await app.register(underwritingModule);
  await app.register(underwritingAnalyticsModule);
  await app.register(brokersModule);
  await app.register(cedentsModule);
  await app.register(capacityMgmtModule);
  await app.register(exposureMgmtModule);
  await app.register(territoriesModule);
  await app.register(territoryMgmtModule);
  await app.register(tasksModule);
  await app.register(auditLogModule);
  await app.register(notificationsModule);
  await app.register(clientsModule);
  await app.register(treatyAdminModule);
  await app.register(organizationModule);
  await app.register(scheduledReportsModule);
  await app.register(executiveModule);
  await app.register(complianceModule);
  await app.register(facultativeAdminModule);
  await app.register(workflowEngineModule);
  await app.register(searchEnhancedModule);
  await app.register(aiInsightsModule);
  await app.register(productsModule);
  await app.register(formulasModule);
  await app.register(platformModule);
  await app.register(costModule);
  await app.register(messagingModule);
  await app.register(eventBusModule);
  await app.register(connectorsModule);
  await app.register(devPortalModule);
  await app.register(kmsModule);
  await app.register(securityOpsModule);
  await app.register(samlModule);
  await app.register(intelligenceModule);
  await app.register(mobileModule);
  await app.register(webauthnModule);
  await app.register(marketplaceModule);
  await app.register(automationStudioModule);
  await app.register(assistantEvalModule);

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    app.log.error(err);
    if (err instanceof AuthError) {
      reply.code(err.status).send({ error: err.message });
      return;
    }
    // Database / driver errors carry a SQLSTATE `code` (e.g. 22P02, 23505).
    // Never leak raw driver messages or SQLSTATE to clients (defect D-4):
    // map common constraint/input classes to clean 400s, everything else to a
    // generic 500. Full detail stays in the server log above.
    const sqlState = typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) ? err.code : null;
    if (sqlState) {
      const badInput = sqlState.startsWith('22'); // data exception (bad uuid, bad date, ...)
      const constraint = sqlState.startsWith('23'); // integrity violation (fk, unique, not null)
      if (badInput || constraint) {
        reply.code(400).send({ error: badInput ? 'Invalid input for one or more fields' : 'Request violates a data constraint' });
        return;
      }
      reply.code(500).send({ error: 'Internal error' });
      return;
    }
    const status = err.statusCode ?? 500;
    // 4xx messages are intentional (validation, not-found); 5xx are sanitised.
    reply.code(status).send({ error: status < 500 ? (err.message ?? 'Request failed') : 'Internal error' });
  });

  return app;
}
