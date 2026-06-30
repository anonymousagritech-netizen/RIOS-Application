/**
 * Optional LLM enrichment for the assistant (brief §12).
 *
 * Calls the Anthropic Messages API to answer free-form questions that the
 * deterministic intent engine doesn't recognise - but only when an API key is
 * configured. It is grounded with a compact, RLS-scoped data snapshot supplied
 * by the caller and is instructed never to invent figures. Every failure path
 * returns null so the assistant falls back to the deterministic engine and the
 * platform stays fully usable with AI disabled (§12.6).
 *
 * The LLM is used for *explanation/answering only*. It can never mutate data:
 * mutations always go through the prepared-action + confirmation gate (§12.4),
 * which lives in the assistant module, not here.
 */

import { config } from '../config.js';

export function isLlmEnabled(): boolean {
  return Boolean(config.ai.apiKey);
}

const SYSTEM_PROMPT = [
  'You are the embedded assistant inside RIOS, a reinsurance ERP.',
  'Answer the user concisely and professionally using ONLY the grounding data provided.',
  'Never invent figures, references, or records. If the grounding data does not contain',
  'the answer, say so plainly and suggest where in the app to look.',
  'You cannot change any data; if the user asks to create or modify something, tell them',
  'to use the explicit action which will require their confirmation.',
].join(' ');

export interface LlmGroundedRequest {
  question: string;
  /** A small, already-permission-filtered snapshot of relevant tenant data. */
  grounding: unknown;
}

export async function llmAnswer(req: LlmGroundedRequest): Promise<string | null> {
  if (!isLlmEnabled()) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.ai.apiKey as string,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.ai.model,
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content:
              `Question: ${req.question}\n\n` +
              `Grounding data (JSON, authoritative - do not contradict it):\n` +
              JSON.stringify(req.grounding).slice(0, 12000),
          },
        ],
      }),
      // Don't let a slow LLM hang the request; the deterministic path is the SLA.
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.find((c) => c.type === 'text')?.text;
    return text?.trim() || null;
  } catch {
    return null;
  }
}
