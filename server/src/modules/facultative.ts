/**
 * Facultative module (brief §7.4, §29.2).
 *
 * Facultative business is a single-risk cession captured on one screen: a
 * FACULTATIVE contract, its underlying risk, and the commercial terms are
 * created in a single transaction, and - when a premium is supplied - the ceded
 * deposit premium is booked straight away as a Financial Event (§7.6), starting
 * the reconcilable accounting chain. Money is computed by @rios/domain so the
 * numbers match the ones the unit tests prove correct.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fromMajor, multiply } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { nextReference } from './parties.js';

const createFacultativeSchema = z.object({
  name: z.string().min(1),
  basis: z.enum(['PROPORTIONAL', 'NON_PROPORTIONAL']),
  lineOfBusiness: z.string().optional(),
  currency: z.string().length(3),
  cedentPartyId: z.string().uuid().optional(),
  insuredName: z.string().optional(),
  sumInsured: z.number().optional(),
  premium: z.number().optional(),
  cededShare: z.number().min(0).max(1).optional(),
  // Metadata-driven adaptive-form data (Dynamic Form Engine) for the single-risk
  // cession; persisted verbatim on the underlying risk row.
  details: z.record(z.unknown()).optional(),
});

export async function facultativeModule(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/facultative',
    { preHandler: requirePermission('facultative:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select c.id, c.reference, c.name, c.contract_kind as "contractKind", c.basis,
                  c.proportional_type as "proportionalType", c.np_type as "npType",
                  c.line_of_business as "lineOfBusiness", c.direction, c.currency,
                  c.period_start as "periodStart", c.period_end as "periodEnd", c.status,
                  ced.short_name as "cedentName"
             from contract c
             left join party ced on ced.id = c.cedent_party_id
            where not c.is_deleted
              and c.contract_kind = 'FACULTATIVE'
            order by c.created_at desc`,
        );
        return { facultative: rows };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/facultative/:id',
    { preHandler: requirePermission('facultative:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select c.id, c.reference, c.name, c.contract_kind as "contractKind", c.basis,
                  c.proportional_type as "proportionalType", c.np_type as "npType",
                  c.line_of_business as "lineOfBusiness", c.direction, c.currency,
                  c.cedent_party_id as "cedentPartyId", c.period_start as "periodStart",
                  c.period_end as "periodEnd", c.status
             from contract c
            where c.id = $1 and not c.is_deleted and c.contract_kind = 'FACULTATIVE'`,
          [req.params.id],
        );
        const contract = rows[0] as (Record<string, unknown> & { id: string }) | undefined;
        if (!contract) {
          reply.code(404);
          return { error: 'Facultative contract not found' };
        }
        const risks = await db.query(
          `select id, reference, description, insured_name as "insuredName",
                  line_of_business as "lineOfBusiness", sum_insured_minor as "sumInsuredMinor",
                  currency, inception, expiry, details as "details"
             from risk where contract_id = $1 order by created_at`,
          [req.params.id],
        );
        const events = await db.query(
          `select id, contract_id as "contractId", event_type as "eventType", direction,
                  amount_minor as "amountMinor", currency, booked_at as "bookedAt", narrative
             from financial_event where contract_id = $1 order by booked_at, created_at`,
          [req.params.id],
        );
        contract.risks = risks.rows;
        contract.financialEvents = events.rows;
        return contract;
      });
    },
  );

  app.post('/api/facultative', { preHandler: requirePermission('facultative:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createFacultativeSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid facultative cession', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const ref = await nextReference(db, ctx.tenantId, 'facultative_reference', 'FAC');

      // 1. The FACULTATIVE contract, bound on creation.
      const contractRes = await db.query<{ id: string }>(
        `insert into contract
           (tenant_id, reference, name, contract_kind, basis, line_of_business,
            direction, cedent_party_id, currency, status, created_by)
         values ($1,$2,$3,'FACULTATIVE',$4,$5,'INWARDS',$6,$7,'BOUND',$8) returning id`,
        [ctx.tenantId, ref, b.name, b.basis, b.lineOfBusiness ?? null, b.cedentPartyId ?? null, b.currency, ctx.userId],
      );
      const id = contractRes.rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'contract',
        entityId: id,
        after: { name: b.name, contractKind: 'FACULTATIVE', status: 'BOUND' },
        actorLabel: req.auth?.displayName,
      });

      // 2. The underlying risk.
      const sumInsuredMinor = b.sumInsured != null ? fromMajor(b.sumInsured, b.currency).amount : null;
      const riskRes = await db.query<{ id: string }>(
        `insert into risk
           (tenant_id, contract_id, insured_name, line_of_business, sum_insured_minor, currency, details)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [ctx.tenantId, id, b.insuredName ?? null, b.lineOfBusiness ?? null, sumInsuredMinor, b.currency, JSON.stringify(b.details ?? {})],
      );
      const riskId = riskRes.rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'risk',
        entityId: riskId,
        after: { insuredName: b.insuredName ?? null, sumInsuredMinor, currency: b.currency },
        actorLabel: req.auth?.displayName,
      });

      // 3. The commercial term set for the cession.
      const terms = {
        basis: b.basis,
        cededShare: b.cededShare ?? null,
        premium: b.premium ?? null,
        sumInsured: b.sumInsured ?? null,
        currency: b.currency,
      };
      const termRes = await db.query<{ id: string }>(
        `insert into term_set (tenant_id, contract_id, terms, created_by) values ($1,$2,$3,$4) returning id`,
        [ctx.tenantId, id, JSON.stringify(terms), ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'term_set',
        entityId: termRes.rows[0]!.id,
        after: terms,
        actorLabel: req.auth?.displayName,
      });

      // 4. Auto-book the ceded deposit premium if a premium is supplied.
      const financialEvents: unknown[] = [];
      if (b.premium != null && b.premium > 0) {
        const fullPremium = fromMajor(b.premium, b.currency);
        const ceded =
          b.basis === 'PROPORTIONAL' && b.cededShare != null
            ? multiply(fullPremium, b.cededShare)
            : fullPremium;
        if (ceded.amount > 0) {
          const evtRes = await db.query<{ id: string }>(
            `insert into financial_event
               (tenant_id, contract_id, event_type, direction, amount_minor, currency, booked_at, narrative, created_by)
             values ($1,$2,'DEPOSIT_PREMIUM','DR',$3,$4,current_date,$5,$6) returning id`,
            [ctx.tenantId, id, ceded.amount, b.currency, 'Ceded facultative deposit premium', ctx.userId],
          );
          const evtId = evtRes.rows[0]!.id;
          await writeAudit(db, ctx, {
            action: 'create',
            entityType: 'financial_event',
            entityId: evtId,
            after: { type: 'DEPOSIT_PREMIUM', amountMinor: ceded.amount, currency: b.currency },
            actorLabel: req.auth?.displayName,
          });
          financialEvents.push({ id: evtId, eventType: 'DEPOSIT_PREMIUM', amountMinor: ceded.amount, currency: b.currency });
        }
      }

      reply.code(201);
      return { id, reference: ref, riskId, financialEvents };
    });
  });
}
