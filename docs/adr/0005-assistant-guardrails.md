# ADR 0005 - Assistant guardrails: deterministic, permission-bound, confirmation-gated

**Status:** Accepted · **Date:** 2026 · **Deciders:** AI Engineer, Security Architect, Reinsurance Domain Expert, CTO
**Brief refs:** §12.4 (hard requirements), §12.6 (graceful degradation), §9.15, §4.3

## Context

The embedded assistant must act across modules in natural language, but the brief sets hard safety
requirements (§12.4): **every destructive or financially material action requires explicit confirmation**;
the assistant operates **strictly within the requesting user's permissions** with **no privileged backdoor**;
it **grounds answers in tenant data and does not fabricate figures**; it performs **no silent financial
mutation**; and the platform must remain **fully usable with AI disabled** (§12.6). A free-form LLM that can
directly mutate state would violate all of these.

## Decision

Implement the assistant as a **deterministic intent engine** that prepares actions but never commits them
itself:

- **Intent recognition is deterministic** (rule/intent matching over the message), so behaviour is
  predictable and testable - not dependent on a model's mood. An LLM may *assist* phrasing/summaries, but
  the action contract is deterministic.
- **Two-phase, confirmation-gated mutation.** `POST /api/assistant` *prepares* an `AssistantAction`
  (`requiresConfirmation: true`, a human-readable `preview` of exactly what will change) but does **not**
  execute it. A separate `POST /api/assistant/confirm` executes - and only after re-checking permissions.
- **Permission-bound, same path as a human.** Confirmation runs through the same RBAC checks as the
  equivalent direct API; an under-permissioned user is refused **403** (proven by integration test:
  `acct@demo.rios` cannot confirm `create_treaty`).
- **Grounded.** Answers cite the tenant records consulted (`grounding`); figures come from data, never
  invented.
- **Degrades gracefully.** Because the engine is deterministic and the AI model is optional
  (`ANTHROPIC_API_KEY` unset is fine), the assistant and the whole platform work with AI disabled (§12.6).

## Consequences

**Positive:** the §12.4 hard requirements are met by construction and covered by tests; no backdoor; no
silent mutation; safe-by-default.

**Negative / accepted:** the deterministic engine understands a bounded intent set, narrower than an
open-ended LLM agent; broadening it is incremental work. Voice, generation of reports/dashboards/documents,
and the Automation Studio (§12.3, §12.5) are designed-for. An assistant evaluation/golden-task suite
(§12.4) is a named gap.
