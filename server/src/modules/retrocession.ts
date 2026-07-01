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
// Loss-type financial events count toward incurred-paid losses (gross inwards vs ceded outwards).
const LOSS_EVENT_TYPES = ['PAID_LOSS', 'CASH_LOSS'];

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

  // Portfolio-level gross/ceded/net rollup across inwards + outwards contracts,
  // per currency and per line of business, from the SAME financial_event source
  // the accounting chain reconciles (no parallel money path). Gross = events on
  // INWARDS contracts, ceded = events on OUTWARDS (retro) contracts, net = gross
  // − ceded; premiums and paid losses are rolled up separately. Currencies never
  // mix: `totals` is the whole-book position keyed by currency.
  app.get(
    '/api/portfolio/net-position',
    { preHandler: requirePermission('treaty:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{
          direction: string;
          line_of_business: string | null;
          currency: string;
          premium_minor: string;
          loss_minor: string;
        }>(
          `select c.direction, c.line_of_business, fe.currency,
                  coalesce(sum(fe.amount_minor) filter (where fe.event_type = any($1::citext[])), 0)::bigint as premium_minor,
                  coalesce(sum(fe.amount_minor) filter (where fe.event_type = any($2::citext[])), 0)::bigint as loss_minor
             from financial_event fe
             join contract c on c.id = fe.contract_id
            where not c.is_deleted
              and fe.event_type = any($3::citext[])
            group by c.direction, c.line_of_business, fe.currency`,
          [PREMIUM_EVENT_TYPES, LOSS_EVENT_TYPES, [...PREMIUM_EVENT_TYPES, ...LOSS_EVENT_TYPES]],
        );

        interface Bucket { grossPremium: Money; cededPremium: Money; grossLoss: Money; cededLoss: Money }
        const emptyBucket = (ccy: string): Bucket => ({
          grossPremium: zero(ccy),
          cededPremium: zero(ccy),
          grossLoss: zero(ccy),
          cededLoss: zero(ccy),
        });
        const accumulate = (bucket: Bucket, r: (typeof rows)[number]): void => {
          const premium = money(Number(r.premium_minor), r.currency);
          const loss = money(Number(r.loss_minor), r.currency);
          if (r.direction === 'OUTWARDS') {
            bucket.cededPremium = add(bucket.cededPremium, premium);
            bucket.cededLoss = add(bucket.cededLoss, loss);
          } else {
            bucket.grossPremium = add(bucket.grossPremium, premium);
            bucket.grossLoss = add(bucket.grossLoss, loss);
          }
        };
        const project = (b: Bucket) => ({
          grossPremiumMinor: b.grossPremium.amount,
          cededPremiumMinor: b.cededPremium.amount,
          netPremiumMinor: subtract(b.grossPremium, b.cededPremium).amount,
          grossLossMinor: b.grossLoss.amount,
          cededLossMinor: b.cededLoss.amount,
          netLossMinor: subtract(b.grossLoss, b.cededLoss).amount,
        });

        const byCcy = new Map<string, Bucket>();
        const byLobKey = new Map<string, { lineOfBusiness: string | null; currency: string; bucket: Bucket }>();
        for (const r of rows) {
          const ccyBucket = byCcy.get(r.currency) ?? emptyBucket(r.currency);
          accumulate(ccyBucket, r);
          byCcy.set(r.currency, ccyBucket);

          const lobKey = `${r.line_of_business ?? '\u0000'}|${r.currency}`;
          const lobEntry =
            byLobKey.get(lobKey) ?? { lineOfBusiness: r.line_of_business, currency: r.currency, bucket: emptyBucket(r.currency) };
          accumulate(lobEntry.bucket, r);
          byLobKey.set(lobKey, lobEntry);
        }

        const currencies = [...byCcy.keys()].sort();
        const byCurrency = currencies.map((ccy) => ({ currency: ccy, ...project(byCcy.get(ccy)!) }));
        const byLob = [...byLobKey.values()]
          .sort((a, b) => {
            if (a.lineOfBusiness !== b.lineOfBusiness) {
              if (a.lineOfBusiness === null) return 1; // unclassified last
              if (b.lineOfBusiness === null) return -1;
              return a.lineOfBusiness < b.lineOfBusiness ? -1 : 1;
            }
            return a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0;
          })
          .map((e) => ({ lineOfBusiness: e.lineOfBusiness, currency: e.currency, ...project(e.bucket) }));
        const totals = Object.fromEntries(currencies.map((ccy) => [ccy, project(byCcy.get(ccy)!)]));
        return { byCurrency, byLob, totals };
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
