/**
 * Assistant evaluation harness (brief §12.7 — assistant guardrails & evaluation).
 * Runs a curated suite of prompts through the live assistant and checks each
 * response contains the expected signal (a route or keyword), returning a pass
 * rate. This is a real, reproducible regression check on the deterministic intent
 * engine — it catches a broken or drifted assistant before release.
 */

import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../auth.js';

interface EvalCase { prompt: string; expect: string; note?: string }

// Curated cases: each `expect` must appear (case-insensitive) in the assistant's
// JSON response (a nav route, action label, or grounded figure).
const EVAL_SUITE: EvalCase[] = [
  { prompt: 'take me to claims', expect: '/claims', note: 'navigation' },
  { prompt: 'show treaties', expect: '/treaties', note: 'navigation' },
  { prompt: 'go to accounting', expect: '/accounting', note: 'navigation' },
  { prompt: 'how many open claims are there', expect: 'claim', note: 'grounded count' },
  { prompt: 'prepare a new treaty', expect: 'confirm', note: 'confirmation gate' },
];

export async function assistantEvalModule(app: FastifyInstance): Promise<void> {
  app.get('/api/assistant/eval/suite', { preHandler: requirePermission() }, async () => {
    return { cases: EVAL_SUITE.map((c) => ({ prompt: c.prompt, expect: c.expect, note: c.note })) };
  });

  app.post('/api/assistant/eval/run', { preHandler: requirePermission() }, async (req) => {
    const auth = req.headers.authorization ?? '';
    const results = [];
    for (const c of EVAL_SUITE) {
      const res = await app.inject({ method: 'POST', url: '/api/assistant', headers: { authorization: auth }, payload: { message: c.prompt } });
      const body = JSON.stringify(res.json() ?? {}).toLowerCase();
      const pass = body.includes(c.expect.toLowerCase());
      results.push({ prompt: c.prompt, expect: c.expect, note: c.note, pass });
    }
    const passed = results.filter((r) => r.pass).length;
    return { results, passed, total: results.length, score: Math.round((passed / results.length) * 100) / 100 };
  });
}
