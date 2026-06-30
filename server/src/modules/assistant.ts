/**
 * Embedded assistant (brief §12).
 *
 * Design commitments encoded here:
 *  - Operates strictly within the requesting user's permissions (§12.4): every
 *    data access goes through the same RLS-scoped queries and permission checks
 *    a human would; there is no privileged backdoor (§9.15).
 *  - Grounds answers in tenant data; it never fabricates figures (§12.4).
 *  - Every destructive / financially material action is *prepared*, not executed,
 *    and returns requiresConfirmation=true with a preview of exactly what will
 *    change. A separate /confirm call commits it through the normal path (§12.4).
 *  - Degrades gracefully: the intent engine is deterministic and needs no LLM, so
 *    the platform is fully usable with AI disabled (§12.6). An LLM can enrich
 *    phrasing when configured, but is never required for correctness.
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AssistantResponse, AssistantAction } from '@rios/shared';
import { runAs, type Db } from '../db.js';
import { authContext, authenticate, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

interface Intent {
  test: RegExp;
  handler: (db: Db, ctx: { tenantId: string; userId: string }, message: string, perms: string[]) => Promise<AssistantResponse>;
}

const INTENTS: Intent[] = [
  {
    test: /how many|count|number of/i,
    handler: async (db, _ctx, message) => {
      if (/claim/i.test(message)) {
        const r = await db.query<{ n: number }>(`select count(*)::int as n from claim where not is_deleted`);
        return answer(`You have ${r.rows[0]!.n} claim(s) on record.`, [{ entity: 'claim', id: 'count', label: String(r.rows[0]!.n) }]);
      }
      const r = await db.query<{ n: number }>(`select count(*)::int as n from contract where not is_deleted`);
      return answer(`You have ${r.rows[0]!.n} treaty/contract(s) on record.`, [{ entity: 'contract', id: 'count', label: String(r.rows[0]!.n) }]);
    },
  },
  {
    test: /overdue|open claim|outstanding claim/i,
    handler: async (db) => {
      const r = await db.query<{ reference: string; status: string; outstanding_minor: number; currency: string }>(
        `select reference, status, outstanding_minor, currency from claim
          where not is_deleted and status not in ('CLOSED','SETTLED') order by notified_date desc limit 10`,
      );
      if (r.rows.length === 0) return answer('No open claims right now.');
      const lines = r.rows.map((c) => `• ${c.reference} — ${c.status}, outstanding ${(c.outstanding_minor / 100).toLocaleString()} ${c.currency}`).join('\n');
      return answer(`Open claims:\n${lines}`, r.rows.map((c) => ({ entity: 'claim', id: c.reference, label: c.reference })));
    },
  },
  {
    test: /cat exposure|aggregate|exposure for|zone/i,
    handler: async (db, _ctx, message) => {
      const zone = (message.match(/zone\s+([a-z ]+)/i)?.[1] ?? message.match(/for (?:the )?([a-z ]+?)(?: zone)?$/i)?.[1] ?? '').trim();
      const r = await db.query<{ peril_zone: string; n: number; si: number }>(
        `select coalesce(peril_zone,'(unzoned)') as peril_zone, count(*)::int as n, coalesce(sum(sum_insured_minor),0)::bigint as si
           from risk where ($1 = '' or peril_zone ilike '%'||$1||'%') group by peril_zone order by si desc`,
        [zone],
      );
      if (r.rows.length === 0) return answer(`No exposure records found${zone ? ` for "${zone}"` : ''}. (Exposure aggregation populates as risks are bordereaux-loaded — §9.9.)`);
      const lines = r.rows.map((x) => `• ${x.peril_zone}: ${x.n} risk(s), TSI ${(Number(x.si) / 100).toLocaleString()}`).join('\n');
      return answer(`Exposure summary:\n${lines}`);
    },
  },
  {
    test: /statement (of account)?|generate.*statement/i,
    handler: async (db, _ctx, message) => {
      const ref = message.match(/TRTY[-\w]+/i)?.[0];
      const r = await db.query<{ id: string; name: string; reference: string }>(
        ref
          ? `select id, name, reference from contract where reference ilike $1 and not is_deleted limit 1`
          : `select id, name, reference from contract where not is_deleted order by created_at desc limit 1`,
        ref ? [ref] : [],
      );
      const c = r.rows[0];
      if (!c) return answer('I could not find a matching treaty to build a statement for.');
      return {
        reply: `I can build the statement of account for ${c.reference} (${c.name}). This reads its financial events and nets the balance — review before issuing.`,
        actions: [
          prepared({
            kind: 'open_statement',
            description: `Open the statement of account for ${c.reference}`,
            requiresConfirmation: false,
            destructive: false,
            preview: { contractId: c.id, reference: c.reference, route: `/treaties/${c.id}/statement` },
          }),
        ],
        grounding: [{ entity: 'contract', id: c.id, label: c.reference }],
      };
    },
  },
  {
    test: /create|add|new/i,
    handler: async (db, _ctx, message, perms) => {
      // MUTATING — prepare an action requiring explicit confirmation (§12.4).
      if (/treaty|contract/i.test(message)) {
        if (!perms.includes('treaty:write') && !perms.includes('admin:manage')) {
          return answer('You do not have permission to create treaties (treaty:write).');
        }
        const name = message.match(/(?:named|called|name)\s+["']?([^"']+)["']?/i)?.[1]?.trim() ?? 'New Treaty';
        return {
          reply: `I have prepared a draft treaty "${name}". Nothing is saved yet — confirm to create it.`,
          actions: [
            prepared({
              kind: 'create_treaty',
              description: `Create a DRAFT treaty named "${name}"`,
              requiresConfirmation: true,
              destructive: false,
              preview: { name, basis: 'NON_PROPORTIONAL', npType: 'CAT_XL', currency: 'USD', status: 'DRAFT' },
            }),
          ],
        };
      }
      if (/party|broker|cedent|reinsurer/i.test(message)) {
        if (!perms.includes('party:write') && !perms.includes('admin:manage')) {
          return answer('You do not have permission to create parties (party:write).');
        }
        const name = message.match(/(?:named|called|name)\s+["']?([^"']+)["']?/i)?.[1]?.trim() ?? 'New Party';
        const role = /broker/i.test(message) ? 'broker' : /cedent/i.test(message) ? 'cedent' : /reinsurer/i.test(message) ? 'reinsurer' : 'cedent';
        return {
          reply: `I have prepared a new ${role} "${name}". Confirm to create it.`,
          actions: [
            prepared({
              kind: 'create_party',
              description: `Create party "${name}" with role ${role}`,
              requiresConfirmation: true,
              destructive: false,
              preview: { legalName: name, roles: [role] },
            }),
          ],
        };
      }
      return answer('I can create treaties and parties. Try: "create a treaty named Atlantic Cat 2026".');
    },
  },
];

export async function assistantModule(app: FastifyInstance): Promise<void> {
  // Interpret a message. Read intents answer inline; mutating intents return a
  // prepared, unconfirmed action.
  app.post<{ Body: { message: string } }>(
    '/api/assistant',
    { preHandler: requirePermission() },
    async (req, reply) => {
      const ctx = authContext(req);
      const message = (req.body?.message ?? '').trim();
      if (!message) {
        reply.code(400);
        return { error: 'message is required' };
      }
      const perms = req.auth?.permissions ?? [];
      return runAs(ctx, async (db) => {
        const intent = INTENTS.find((i) => i.test.test(message));
        if (!intent) {
          return answer(
            "I can help you navigate, count records, list open claims, summarise exposure, build statements, and prepare new treaties or parties. What would you like?",
          );
        }
        return intent.handler(db, ctx, message, perms);
      });
    },
  );

  // Execute a previously prepared action — the confirmation gate (§12.4).
  app.post<{ Body: { kind: string; preview: Record<string, unknown> } }>(
    '/api/assistant/confirm',
    { preHandler: requirePermission() },
    async (req, reply) => {
      const user = await authenticate(req);
      const ctx = authContext(req);
      const { kind, preview } = req.body ?? {};
      const perms = user.permissions;

      return runAs(ctx, async (db) => {
        switch (kind) {
          case 'create_treaty': {
            if (!perms.includes('treaty:write') && !perms.includes('admin:manage')) {
              reply.code(403);
              return { error: 'Missing permission treaty:write' };
            }
            const { rows } = await db.query<{ id: string }>(
              `insert into contract (tenant_id, name, contract_kind, basis, np_type, currency, status, created_by)
               values ($1,$2,'TREATY','NON_PROPORTIONAL',$3,$4,'DRAFT',$5) returning id`,
              [ctx.tenantId, String(preview.name ?? 'New Treaty'), String(preview.npType ?? 'CAT_XL'), String(preview.currency ?? 'USD'), ctx.userId],
            );
            await writeAudit(db, ctx, { action: 'create', entityType: 'contract', entityId: rows[0]!.id, after: { ...preview, via: 'assistant' }, actorLabel: user.displayName, context: { assistant: true } });
            return { ok: true, kind, id: rows[0]!.id };
          }
          case 'create_party': {
            if (!perms.includes('party:write') && !perms.includes('admin:manage')) {
              reply.code(403);
              return { error: 'Missing permission party:write' };
            }
            const { rows } = await db.query<{ id: string }>(
              `insert into party (tenant_id, legal_name) values ($1,$2) returning id`,
              [ctx.tenantId, String(preview.legalName ?? 'New Party')],
            );
            for (const role of (preview.roles as string[] | undefined) ?? []) {
              await db.query(`insert into party_role (tenant_id, party_id, role_code) values ($1,$2,$3) on conflict do nothing`, [ctx.tenantId, rows[0]!.id, role]);
            }
            await writeAudit(db, ctx, { action: 'create', entityType: 'party', entityId: rows[0]!.id, after: { ...preview, via: 'assistant' }, actorLabel: user.displayName, context: { assistant: true } });
            return { ok: true, kind, id: rows[0]!.id };
          }
          default:
            reply.code(400);
            return { error: `Unknown or non-confirmable action: ${kind}` };
        }
      });
    },
  );
}

function answer(reply: string, grounding: AssistantResponse['grounding'] = []): AssistantResponse {
  return { reply, actions: [], grounding };
}

function prepared(a: Omit<AssistantAction, 'id'>): AssistantAction {
  return { id: randomUUID(), ...a };
}
