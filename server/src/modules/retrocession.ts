/**
 * Retrocession module (brief §7.5, §29.3).
 *
 * Retrocession is outwards protection: the tenant (as retrocedent) cedes part of
 * its assumed book to a retrocessionaire. Contracts are direction='OUTWARDS'
 * (kind 'RETROCESSION'). The net-position view sums premium Financial Events on
 * inwards vs outwards contracts to show gross / ceded / net per currency - the
 * same party can appear as reinsurer on the way in and cedent on the way out
 * (§29.3). Money is summed with @rios/domain so currencies never mix.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { add, subtract, zero, money, type Money } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { nextReference } from './parties.js';

// Premium-type financial events count toward written/ceded premium (§7.6).
const PREMIUM_EVENT_TYPES = ['DEPOSIT_PREMIUM', 'INSTALMENT_PREMIUM', 'ADJUSTMENT_PREMIUM', 'MINIMUM_PREMIUM'];

const createRetrocessionSchema = z.object({
  name: z.string().min(1),
  basis: z.enum(['PROPORTIONAL', 'NON_PROPORTIONAL']),
  npType: z.enum(['PER_RISK_XL', 'CAT_XL', 'AGG_XL', 'STOP_LOSS']).optional(),
  currency: z.string().length(3),
  cedentPartyId: z.string().uuid().optional(),
  retrocessionairePartyId: z.string().uuid().optional(),
});

export async function retrocessionModule(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/retrocession',
    { preHandler: requirePermission('retro:read') },
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
              and (c.direction = 'OUTWARDS' or c.contract_kind = 'RETROCESSION')
            order by c.created_at desc`,
        );
        return { retrocession: rows };
      });
    },
  );

  // Net position across the book: gross (inwards) − ceded (outwards) per currency (§29.3).
  app.get(
    '/api/retrocession/net-position',
    { preHandler: requirePermission('retro:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{
          direction: string;
          currency: string;
          amount_minor: number;
        }>(
          `select c.direction, fe.currency, sum(fe.amount_minor)::bigint as amount_minor
             from financial_event fe
             join contract c on c.id = fe.contract_id
            where not c.is_deleted
              and fe.event_type = any($1::citext[])
            group by c.direction, fe.currency`,
          [PREMIUM_EVENT_TYPES],
        );

        const gross = new Map<string, Money>();
        const ceded = new Map<string, Money>();
        for (const r of rows) {
          const m = money(Number(r.amount_minor), r.currency);
          const bucket = r.direction === 'OUTWARDS' ? ceded : gross;
          const prev = bucket.get(r.currency) ?? zero(r.currency);
          bucket.set(r.currency, add(prev, m));
        }

        const currencies = new Set<string>([...gross.keys(), ...ceded.keys()]);
        const positions = [...currencies].sort().map((ccy) => {
          const g = gross.get(ccy) ?? zero(ccy);
          const c = ceded.get(ccy) ?? zero(ccy);
          const net = subtract(g, c);
          return { currency: ccy, grossMinor: g.amount, cededMinor: c.amount, netMinor: net.amount };
        });
        return { positions };
      });
    },
  );

  app.post('/api/retrocession', { preHandler: requirePermission('retro:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createRetrocessionSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid retrocession', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const ref = await nextReference(db, ctx.tenantId, 'retrocession_reference', 'RETRO');
      const { rows } = await db.query<{ id: string }>(
        `insert into contract
           (tenant_id, reference, name, contract_kind, basis, np_type,
            direction, cedent_party_id, currency, status, created_by)
         values ($1,$2,$3,'RETROCESSION',$4,$5,'OUTWARDS',$6,$7,'DRAFT',$8) returning id`,
        [ctx.tenantId, ref, b.name, b.basis, b.npType ?? null, b.cedentPartyId ?? null, b.currency, ctx.userId],
      );
      const id = rows[0]!.id;

      // The retrocessionaire takes the outwards line (recorded as a participation).
      if (b.retrocessionairePartyId) {
        await db.query(
          `insert into participation (tenant_id, contract_id, party_id, role_code)
           values ($1,$2,$3,'retrocessionaire')`,
          [ctx.tenantId, id, b.retrocessionairePartyId],
        );
      }

      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'contract',
        entityId: id,
        after: { name: b.name, contractKind: 'RETROCESSION', direction: 'OUTWARDS', status: 'DRAFT' },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, reference: ref, status: 'DRAFT' };
    });
  });
}
