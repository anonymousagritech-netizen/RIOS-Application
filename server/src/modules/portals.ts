/**
 * External portals (brief §9.15).
 *
 * A portal is a thin, permission-scoped *projection* of the core APIs for one
 * external counterparty — it never reads a parallel data store. Each request is
 * resolved to a single `portal_grant` (user → party + portal type); every query
 * is then filtered to the contracts that party can legitimately see:
 *
 *   broker / coverholder  → contracts they broke (broker_party_id)
 *   cedent / client       → contracts they ceded (cedent_party_id)
 *   retrocessionaire      → contracts they take a line on (participation)
 *
 * An ADMIN (admin:manage) may impersonate any grant via ?partyId=&portalType=
 * for support and verification, without holding a grant of their own.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { runAs } from '../db.js';
import type { Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

type PortalType = 'broker' | 'cedent' | 'retrocessionaire' | 'coverholder' | 'client';

interface ResolvedPortal {
  partyId: string;
  partyName: string;
  portalType: PortalType;
}

/** SQL predicate (against alias `c` = contract) selecting the party's contracts. */
function contractPredicate(portalType: PortalType): string {
  switch (portalType) {
    case 'broker':
    case 'coverholder':
      return 'c.broker_party_id = $1';
    case 'cedent':
    case 'client':
      return 'c.cedent_party_id = $1';
    case 'retrocessionaire':
      return 'exists (select 1 from participation pp where pp.contract_id = c.id and pp.party_id = $1)';
  }
}

/**
 * Resolve which party/portal this request is acting as. A holder of admin:manage
 * may pass ?partyId & ?portalType to view any portal; everyone else is bound to
 * their own enabled grant (optionally selected by ?portalType when they hold
 * more than one).
 */
async function resolvePortal(
  db: Db,
  req: FastifyRequest,
  isAdmin: boolean,
): Promise<ResolvedPortal | { error: string; status: number }> {
  const q = req.query as { partyId?: string; portalType?: string };

  if (isAdmin && q.partyId && q.portalType) {
    const { rows } = await db.query(
      `select id, coalesce(short_name, legal_name) as name from party where id = $1 and not is_deleted`,
      [q.partyId],
    );
    if (!rows[0]) return { error: 'Party not found', status: 404 };
    return { partyId: q.partyId, partyName: rows[0].name, portalType: q.portalType as PortalType };
  }

  const { rows } = await db.query(
    `select g.party_id as "partyId", g.portal_type as "portalType",
            coalesce(p.short_name, p.legal_name) as "partyName"
       from portal_grant g
       join party p on p.id = g.party_id
      where g.user_id = $1 and g.enabled
        and ($2::text is null or g.portal_type = $2)
      order by g.created_at limit 1`,
    [req.auth!.id, q.portalType ?? null],
  );
  if (!rows[0]) return { error: 'No portal access has been granted to this account', status: 403 };
  return rows[0] as ResolvedPortal;
}

export async function portalsModule(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: requirePermission('portal:read') };

  // The grants this user holds — drives the portal picker in the UI. Admins see
  // an empty list here (they impersonate explicitly), which the UI handles.
  app.get('/api/portal/grants', guard, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select g.id, g.portal_type as "portalType", g.party_id as "partyId",
                coalesce(p.short_name, p.legal_name) as "partyName", g.scopes
           from portal_grant g
           join party p on p.id = g.party_id
          where g.user_id = $1 and g.enabled
          order by g.portal_type`,
        [ctx.userId],
      );
      return { grants: rows };
    });
  });

  // Headline figures for the resolved portal.
  app.get('/api/portal/overview', guard, async (req, reply) => {
    const ctx = authContext(req);
    const isAdmin = !!req.auth?.permissions.includes('admin:manage');
    return runAs(ctx, async (db) => {
      const r = await resolvePortal(db, req, isAdmin);
      if ('error' in r) {
        reply.code(r.status);
        return { error: r.error };
      }
      const pred = contractPredicate(r.portalType);
      const { rows } = await db.query(
        `with vc as (select c.id, c.currency from contract c where not c.is_deleted and ${pred})
         select
           (select count(*)::int from vc) as "contracts",
           (select count(*)::int from contract c where not c.is_deleted and ${pred}
              and c.status in ('BOUND','ACTIVE')) as "activeContracts",
           (select count(*)::int from claim cl where not cl.is_deleted
              and cl.contract_id in (select id from vc)) as "claims",
           (select coalesce(sum(cl.outstanding_minor),0)::bigint from claim cl
              where not cl.is_deleted and cl.contract_id in (select id from vc)) as "outstandingMinor",
           (select coalesce(sum(s.balance_minor),0)::bigint from statement_of_account s
              where s.contract_id in (select id from vc) or s.counterparty_id = $1) as "statementBalanceMinor",
           (select count(*)::int from statement_of_account s
              where (s.contract_id in (select id from vc) or s.counterparty_id = $1)
                and s.status not in ('SETTLED','CLOSED')) as "openStatements"`,
        [r.partyId],
      );
      return { portal: { partyId: r.partyId, partyName: r.partyName, portalType: r.portalType }, summary: rows[0] };
    });
  });

  // Contracts visible to this counterparty.
  app.get('/api/portal/contracts', guard, async (req, reply) => {
    const ctx = authContext(req);
    const isAdmin = !!req.auth?.permissions.includes('admin:manage');
    return runAs(ctx, async (db) => {
      const r = await resolvePortal(db, req, isAdmin);
      if ('error' in r) {
        reply.code(r.status);
        return { error: r.error };
      }
      const pred = contractPredicate(r.portalType);
      const { rows } = await db.query(
        `select c.id, c.reference, c.name, c.contract_kind as "contractKind", c.basis,
                c.line_of_business as "lineOfBusiness", c.currency, c.status,
                c.period_start as "periodStart", c.period_end as "periodEnd",
                coalesce(ced.short_name, ced.legal_name) as "cedentName",
                coalesce(brk.short_name, brk.legal_name) as "brokerName"
           from contract c
           left join party ced on ced.id = c.cedent_party_id
           left join party brk on brk.id = c.broker_party_id
          where not c.is_deleted and ${pred}
          order by c.period_start desc nulls last, c.reference`,
        [r.partyId],
      );
      return { contracts: rows };
    });
  });

  // Statements of account where this party is the counterparty or owns the contract.
  app.get('/api/portal/statements', guard, async (req, reply) => {
    const ctx = authContext(req);
    const isAdmin = !!req.auth?.permissions.includes('admin:manage');
    return runAs(ctx, async (db) => {
      const r = await resolvePortal(db, req, isAdmin);
      if ('error' in r) {
        reply.code(r.status);
        return { error: r.error };
      }
      const pred = contractPredicate(r.portalType);
      const { rows } = await db.query(
        `with vc as (select c.id from contract c where not c.is_deleted and ${pred})
         select s.id, s.reference, s.currency, s.balance_minor as "balanceMinor",
                s.status, s.period_start as "periodStart", s.period_end as "periodEnd",
                s.issued_at as "issuedAt", s.settled_at as "settledAt",
                c.reference as "contractReference", c.name as "contractName"
           from statement_of_account s
           left join contract c on c.id = s.contract_id
          where s.contract_id in (select id from vc) or s.counterparty_id = $1
          order by s.period_end desc nulls last, s.created_at desc`,
        [r.partyId],
      );
      return { statements: rows };
    });
  });

  // Claims on the party's contracts.
  app.get('/api/portal/claims', guard, async (req, reply) => {
    const ctx = authContext(req);
    const isAdmin = !!req.auth?.permissions.includes('admin:manage');
    return runAs(ctx, async (db) => {
      const r = await resolvePortal(db, req, isAdmin);
      if ('error' in r) {
        reply.code(r.status);
        return { error: r.error };
      }
      const pred = contractPredicate(r.portalType);
      const { rows } = await db.query(
        `with vc as (select c.id from contract c where not c.is_deleted and ${pred})
         select cl.id, cl.reference, cl.description, cl.currency, cl.status,
                cl.loss_date as "lossDate", cl.notified_date as "notifiedDate",
                cl.gross_loss_minor as "grossLossMinor", cl.outstanding_minor as "outstandingMinor",
                cl.paid_minor as "paidMinor", cl.recovered_minor as "recoveredMinor",
                c.reference as "contractReference", c.name as "contractName"
           from claim cl
           join contract c on c.id = cl.contract_id
          where not cl.is_deleted and cl.contract_id in (select id from vc)
          order by cl.notified_date desc`,
        [r.partyId],
      );
      return { claims: rows };
    });
  });
}
