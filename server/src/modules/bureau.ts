/**
 * Bureau / ACORD connector module (brief §7, §28 - market connectivity).
 *
 * Builds ACORD EBOT (technical accounting) messages from statements of account
 * and ECOT (claim movement) messages from claims, using the pure @rios/domain
 * `acord` engine to construct, validate and canonically serialize each message.
 * Messages are persisted in bureau_message and driven through a small lifecycle
 * (BUILT -> SENT -> ACKNOWLEDGED, with an INBOUND echo RECEIVED).
 *
 * Transport is abstracted behind the `BureauConnector` interface. The default
 * in-repo `LoopbackConnector` acknowledges outbound messages and echoes them
 * back inbound so the full round trip is demonstrable without a live DXC / bureau
 * credential - a real adapter (DXC Assure, Lloyd's/Velonetic gateway) implements
 * the same interface and is the labelled integration seam. Reads need
 * accounting:read; mutations need accounting:post and are audited.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  buildEbot, buildEcot, validateAcordMessage, serializeAcord,
  type AcordMessage, type AcordParty,
} from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

// -----------------------------------------------------------------------------
// Connector seam: transport an ACORD message to the market and poll for inbound.
// -----------------------------------------------------------------------------

export interface BureauAck {
  externalRef: string;
  status: 'ACKNOWLEDGED' | 'REJECTED';
}

export interface BureauConnector {
  readonly name: string;
  /** Transmit an outbound, canonically-serialized message; return the bureau ack. */
  send(serialized: string, uti: string): Promise<BureauAck>;
}

/**
 * Default in-repo transport. Deterministic, no network: it "accepts" every
 * well-formed message and returns a synthetic bureau reference derived from the
 * UTI so acks are stable/idempotent. The poll route synthesizes the matching
 * inbound echo. A real DXC/bureau adapter replaces this class only.
 */
export class LoopbackConnector implements BureauConnector {
  readonly name = 'LOOPBACK';
  async send(_serialized: string, uti: string): Promise<BureauAck> {
    return { externalRef: `BUR-${uti}`, status: 'ACKNOWLEDGED' };
  }
}

const defaultConnector: BureauConnector = new LoopbackConnector();

// -----------------------------------------------------------------------------

const ebotSchema = z.object({ statementId: z.string().uuid() });
const ecotSchema = z.object({ claimId: z.string().uuid() });

/** Categorise a financial_event_type into the EBOT accounting buckets. */
function bucketFor(eventType: string): 'premium' | 'brokerage' | 'taxes' | null {
  const t = eventType.toUpperCase();
  if (t.includes('PREMIUM')) return 'premium';
  if (t.includes('COMMISSION') || t.includes('BROKERAGE')) return 'brokerage';
  if (t.includes('TAX') || t.includes('LEVY')) return 'taxes';
  return null;
}

/** Resolve the market parties for a contract (reinsurer = this tenant). */
async function contractParties(db: Db, contractId: string): Promise<{ parties: AcordParty[]; umr?: string }> {
  const { rows } = await db.query(
    `select c.reference as umr,
            t.name as reinsurer,
            cd.legal_name as cedent, cd.reference as cedent_ref,
            br.legal_name as broker,  br.reference as broker_ref
       from contract c
       join tenant t on t.id = c.tenant_id
       left join party cd on cd.id = c.cedent_party_id
       left join party br on br.id = c.broker_party_id
      where c.id = $1`,
    [contractId],
  );
  const r = rows[0] ?? {};
  const parties: AcordParty[] = [{ role: 'REINSURER', name: r.reinsurer ?? 'RIOS Re' }];
  if (r.cedent) parties.push({ role: 'CEDENT', name: r.cedent, reference: r.cedent_ref ?? undefined });
  if (r.broker) parties.push({ role: 'BROKER', name: r.broker, reference: r.broker_ref ?? undefined });
  return { parties, umr: r.umr ?? undefined };
}

async function persistMessage(
  db: Db, ctx: { userId: string }, msg: AcordMessage,
  opts: { direction: 'OUTBOUND' | 'INBOUND'; statementId?: string; claimId?: string; status: string; errors?: string },
): Promise<Record<string, unknown>> {
  const { rows } = await db.query(
    `insert into bureau_message
       (tenant_id, direction, message_type, uti, umr, payload, status, errors,
        statement_id, claim_id, connector, created_by)
     values (app_current_tenant(), $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
     returning id, direction, message_type as "messageType", uti, umr, status,
               external_ref as "externalRef", connector, created_at as "createdAt"`,
    [
      opts.direction, msg.header.messageType, msg.header.uti, msg.header.umr ?? null,
      serializeAcord(msg), opts.status, opts.errors ?? null,
      opts.statementId ?? null, opts.claimId ?? null, defaultConnector.name, ctx.userId,
    ],
  );
  return rows[0]!;
}

export async function bureauModule(app: FastifyInstance): Promise<void> {
  // Build an EBOT technical-accounting message from a statement of account.
  app.post('/api/bureau/ebot', { preHandler: requirePermission('accounting:post') }, async (req, reply) => {
    const ctx = authContext(req);
    const { statementId } = ebotSchema.parse(req.body);
    return runAs(ctx, async (db) => {
      const { rows: sRows } = await db.query(
        `select id, reference, contract_id as "contractId", currency,
                period_start as "periodStart", period_end as "periodEnd"
           from statement_of_account where id = $1`,
        [statementId],
      );
      const stmt = sRows[0];
      if (!stmt) return reply.code(404).send({ error: 'statement not found' });

      // Net the statement's financial events into premium / brokerage / taxes.
      const { rows: evs } = await db.query(
        `select event_type as "eventType", amount_minor as "amountMinor"
           from financial_event where statement_id = $1`,
        [statementId],
      );
      let premium = 0, brokerage = 0, taxes = 0;
      for (const e of evs) {
        const bucket = bucketFor(e.eventType);
        const v = Number(e.amountMinor);
        if (bucket === 'premium') premium += v;
        else if (bucket === 'brokerage') brokerage += v;
        else if (bucket === 'taxes') taxes += v;
      }

      const { parties, umr } = await contractParties(db, stmt.contractId);
      const today = new Date().toISOString().slice(0, 10);
      const msg = buildEbot({
        uti: `EBOT-${stmt.reference ?? stmt.id}`,
        umr,
        senderReference: stmt.reference ?? String(stmt.id),
        currency: stmt.currency,
        parties,
        accountingDate: (stmt.periodEnd ?? today) as string,
        settlementDueDate: today,
        premiumMinor: premium,
        brokerageMinor: brokerage,
        taxesMinor: taxes,
      });
      const validation = validateAcordMessage(msg);
      const saved = await persistMessage(db, ctx, msg, {
        direction: 'OUTBOUND', statementId,
        status: validation.valid ? 'BUILT' : 'REJECTED',
        errors: validation.valid ? undefined : validation.errors.join('; '),
      });
      await writeAudit(db, ctx, {
        action: 'bureau.ebot.build', entityType: 'bureau_message', entityId: String(saved.id),
        after: { note: `Built EBOT for statement ${stmt.reference ?? stmt.id}` },
      });
      return { message: saved, envelope: msg, validation };
    });
  });

  // Build an ECOT claim-movement message from a claim.
  app.post('/api/bureau/ecot', { preHandler: requirePermission('accounting:post') }, async (req, reply) => {
    const ctx = authContext(req);
    const { claimId } = ecotSchema.parse(req.body);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select cl.id, cl.reference, cl.contract_id as "contractId", cl.currency,
                cl.paid_minor as "paidMinor", cl.outstanding_minor as "outstandingMinor",
                cl.loss_date as "lossDate", ev.event_code as "catCode"
           from claim cl
           left join cat_event ev on ev.id = cl.cat_event_id
          where cl.id = $1 and cl.is_deleted = false`,
        [claimId],
      );
      const claim = rows[0];
      if (!claim) return reply.code(404).send({ error: 'claim not found' });

      const { parties, umr } = await contractParties(db, claim.contractId);
      const msg = buildEcot({
        uti: `ECOT-${claim.reference ?? claim.id}`,
        umr,
        senderReference: claim.reference ?? String(claim.id),
        currency: claim.currency,
        parties,
        lossReference: claim.reference ?? String(claim.id),
        catCode: claim.catCode ?? undefined,
        lossDate: claim.lossDate ? new Date(claim.lossDate).toISOString().slice(0, 10) : undefined,
        paidMinor: Number(claim.paidMinor),
        outstandingMinor: Number(claim.outstandingMinor),
      });
      const validation = validateAcordMessage(msg);
      const saved = await persistMessage(db, ctx, msg, {
        direction: 'OUTBOUND', claimId,
        status: validation.valid ? 'BUILT' : 'REJECTED',
        errors: validation.valid ? undefined : validation.errors.join('; '),
      });
      await writeAudit(db, ctx, {
        action: 'bureau.ecot.build', entityType: 'bureau_message', entityId: String(saved.id),
        after: { note: `Built ECOT for claim ${claim.reference ?? claim.id}` },
      });
      return { message: saved, envelope: msg, validation };
    });
  });

  // Transmit a BUILT message through the connector; records the bureau ack.
  app.post('/api/bureau/:id/send', { preHandler: requirePermission('accounting:post') }, async (req, reply) => {
    const ctx = authContext(req);
    const { id } = req.params as { id: string };
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, uti, payload, status from bureau_message where id = $1 and direction = 'OUTBOUND'`,
        [id],
      );
      const m = rows[0];
      if (!m) return reply.code(404).send({ error: 'message not found' });
      if (m.status !== 'BUILT') return reply.code(409).send({ error: `cannot send from status ${m.status}` });
      const ack = await defaultConnector.send(JSON.stringify(m.payload), m.uti);
      const { rows: upd } = await db.query(
        `update bureau_message set status = $2, external_ref = $3, updated_at = now()
           where id = $1
         returning id, status, external_ref as "externalRef", uti`,
        [id, ack.status === 'REJECTED' ? 'REJECTED' : 'SENT', ack.externalRef],
      );
      await writeAudit(db, ctx, {
        action: 'bureau.send', entityType: 'bureau_message', entityId: id,
        after: { note: `Sent ${m.uti} via ${defaultConnector.name} (${ack.externalRef})` },
      });
      return upd[0];
    });
  });

  // Poll the connector: for each SENT outbound, record the inbound acknowledgement
  // echo and mark the outbound ACKNOWLEDGED. Demonstrates the round trip.
  app.post('/api/bureau/poll', { preHandler: requirePermission('accounting:post') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows: sent } = await db.query(
        `select id, message_type as "messageType", uti, umr, payload, external_ref as "externalRef"
           from bureau_message where direction = 'OUTBOUND' and status = 'SENT'`,
      );
      let received = 0;
      for (const m of sent) {
        await db.query(
          `insert into bureau_message
             (tenant_id, direction, message_type, uti, umr, payload, status, external_ref, connector, created_by)
           values (app_current_tenant(), 'INBOUND', $1, $2, $3, $4::jsonb, 'RECEIVED', $5, $6, $7)`,
          [m.messageType, `ACK-${m.uti}`, m.umr ?? null, JSON.stringify(m.payload), m.externalRef, defaultConnector.name, ctx.userId],
        );
        await db.query(`update bureau_message set status = 'ACKNOWLEDGED', updated_at = now() where id = $1`, [m.id]);
        received++;
      }
      if (received > 0) {
        await writeAudit(db, ctx, {
          action: 'bureau.poll', entityType: 'bureau_message',
          after: { note: `Received ${received} bureau acknowledgement(s) via ${defaultConnector.name}`, received },
        });
      }
      return { received, connector: defaultConnector.name };
    });
  });

  // Recent statements and claims that an EBOT / ECOT can be built from.
  app.get('/api/bureau/sources', { preHandler: requirePermission('accounting:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows: statements } = await db.query(
        `select id, reference, currency, balance_minor as "balanceMinor", status,
                period_end as "periodEnd"
           from statement_of_account order by created_at desc limit 50`,
      );
      const { rows: claims } = await db.query(
        `select id, reference, currency, paid_minor as "paidMinor",
                outstanding_minor as "outstandingMinor", status
           from claim where is_deleted = false order by created_at desc limit 50`,
      );
      return { statements, claims };
    });
  });

  // List messages (most recent first).
  app.get('/api/bureau/messages', { preHandler: requirePermission('accounting:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, direction, message_type as "messageType", uti, umr, status,
                external_ref as "externalRef", connector, statement_id as "statementId",
                claim_id as "claimId", errors, created_at as "createdAt"
           from bureau_message order by created_at desc limit 500`,
      );
      return { messages: rows, connector: defaultConnector.name };
    });
  });

  // View one message including its canonical envelope.
  app.get('/api/bureau/messages/:id', { preHandler: requirePermission('accounting:read') }, async (req, reply) => {
    const ctx = authContext(req);
    const { id } = req.params as { id: string };
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, direction, message_type as "messageType", uti, umr, status,
                external_ref as "externalRef", connector, payload, errors,
                statement_id as "statementId", claim_id as "claimId", created_at as "createdAt"
           from bureau_message where id = $1`,
        [id],
      );
      if (!rows[0]) return reply.code(404).send({ error: 'message not found' });
      return rows[0];
    });
  });
}
