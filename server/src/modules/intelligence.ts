/**
 * Intelligence surfaces (brief §5, §9.4, §13):
 *  - OCR / document intelligence: extract structured fields from document text,
 *  - Voice assistant: route a spoken transcript through the existing assistant,
 *  - AI prediction & insights: transparent renewal-likelihood scoring,
 *  - AI generation: a narrative executive summary from live KPIs.
 * The extraction, routing, scoring and templating are real and tested. The
 * external boundaries (image→text OCR, speech I/O, optional LLM narration) are
 * documented in docs/open-questions.md.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  extractFields, extractionConfidence, BORDEREAUX_FIELDS,
  lossRatio, renewalLikelihood, insightBand, interpolate,
} from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

const SPECS: Record<string, typeof BORDEREAUX_FIELDS> = {
  bordereaux: BORDEREAUX_FIELDS,
  cover_note: BORDEREAUX_FIELDS,
};

export async function intelligenceModule(app: FastifyInstance): Promise<void> {
  // --- OCR / document intelligence: text → structured fields ---
  app.post('/api/ocr/extract', { preHandler: requirePermission('documents:read') }, async (req, reply) => {
    const parsed = z.object({ documentType: z.string().default('bordereaux'), text: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'text is required', details: parsed.error.flatten() }; }
    const specs = SPECS[parsed.data.documentType] ?? BORDEREAUX_FIELDS;
    const fields = extractFields(parsed.data.text, specs);
    return { documentType: parsed.data.documentType, fields, confidence: extractionConfidence(fields) };
  });

  // --- Voice assistant: transcript → normalised → existing assistant ---
  app.post('/api/voice/interpret', { preHandler: requirePermission() }, async (req, reply) => {
    const parsed = z.object({ transcript: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'transcript is required' }; }
    // Normalise spoken filler and punctuation before handing to the intent engine.
    const normalized = parsed.data.transcript
      .toLowerCase()
      .replace(/\b(um+|uh+|please|hey rios|ok rios)\b/g, '')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const res = await app.inject({
      method: 'POST', url: '/api/assistant',
      headers: { authorization: req.headers.authorization ?? '' },
      payload: { message: normalized },
    });
    return { transcript: parsed.data.transcript, normalized, response: res.json() };
  });

  // --- AI prediction: per-contract renewal likelihood ---
  app.get('/api/insights/renewals', { preHandler: requirePermission('reporting:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{
        id: string; reference: string; name: string; premium: number; incurred: number; open_claims: number; period_start: string | null;
      }>(
        `select c.id, c.reference, c.name,
                coalesce((select sum(amount_minor) from financial_event fe where fe.contract_id=c.id
                          and fe.event_type in ('DEPOSIT_PREMIUM','INSTALMENT_PREMIUM','ADJUSTMENT_PREMIUM','MINIMUM_PREMIUM')),0)::bigint as premium,
                coalesce((select sum(gross_loss_minor) from claim cl where cl.contract_id=c.id and not cl.is_deleted),0)::bigint as incurred,
                (select count(*) from claim cl where cl.contract_id=c.id and not cl.is_deleted and cl.status not in ('CLOSED','SETTLED'))::int as open_claims,
                c.period_start
           from contract c where not c.is_deleted
          order by c.created_at desc`,
      );
      const nowYear = new Date().getUTCFullYear();
      const insights = rows.map((r) => {
        const lr = lossRatio(Number(r.incurred), Number(r.premium));
        const yearsOnBook = r.period_start ? Math.max(0, nowYear - new Date(r.period_start).getUTCFullYear()) : 0;
        const score = renewalLikelihood({ lossRatio: lr, yearsOnBook, openClaims: r.open_claims });
        return {
          id: r.id, reference: r.reference, name: r.name,
          premiumMinor: Number(r.premium), incurredMinor: Number(r.incurred),
          lossRatio: lr, openClaims: r.open_claims, renewalLikelihood: score, band: insightBand(score),
        };
      });
      return { insights };
    });
  });

  // --- AI generation: a narrative executive summary from live KPIs ---
  app.post('/api/generate/summary', { preHandler: requirePermission('reporting:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ treaties: number; active: number; parties: number; open_claims: number; outstanding: number }>(
        `select
           (select count(*)::int from contract where not is_deleted) as treaties,
           (select count(*)::int from contract where not is_deleted and status in ('BOUND','ACTIVE')) as active,
           (select count(*)::int from party where not is_deleted) as parties,
           (select count(*)::int from claim where not is_deleted and status not in ('CLOSED','SETTLED')) as open_claims,
           (select coalesce(sum(outstanding_minor),0)::bigint from claim where not is_deleted) as outstanding`,
      );
      const k = rows[0]!;
      const template =
        'The portfolio holds {treaties} contracts, of which {active} are active, placed across {parties} counterparties. ' +
        'There are {openClaims} open claims with {outstanding} of outstanding reserves. ' +
        '{health}';
      const health = k.open_claims === 0
        ? 'No claims are currently open - the book is running clean.'
        : Number(k.outstanding) > 0
          ? 'Outstanding reserves should be monitored against the latest capital position.'
          : 'Open claims carry no outstanding reserve.';
      const narrative = interpolate(template, {
        treaties: k.treaties, active: k.active, parties: k.parties,
        openClaims: k.open_claims,
        outstanding: `$${(Number(k.outstanding) / 100).toLocaleString('en-US')}`,
        health,
      });
      return { narrative, kpis: k };
    });
  });
}
