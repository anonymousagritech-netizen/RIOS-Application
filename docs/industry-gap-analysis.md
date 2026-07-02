# RIOS — Data-Capture Audit & Industry Gap Analysis

**Status:** Living document · **Method:** hands-on review of every "add / create" flow in this repository
(form fields ↔ API schemas ↔ DB columns), benchmarked against the shared operating footprint of the major
reinsurance carriers and the platforms that serve them.

> **Honesty note on the benchmark.** Swiss Re, Munich Re, SCOR, Hannover Re, Lloyd's syndicates, PartnerRe,
> Everest Re, RenaissanceRe, Axis Re, Arch Re, Mapfre Re, Gen Re, RGA, TransRe, CCR, Korean Re, China Re,
> Peak Re, Sava Re, SiriusPoint, Catalina, Conduit Re, AIG Re, Liberty Mutual Re, Berkshire Hathaway Re,
> Tokio Marine, Odyssey Re, Aspen Re and Convex do not publish their internal system field lists. What *is*
> well documented — and what they all share — is the market's standard operating footprint: **Lloyd's/LMA
> MRC slip standards, ACORD messaging (EBOT/ECOT/placing), rating-agency and regulator demands
> (security ratings, NAIC Schedule F, Solvency II QRTs), and the module maps of the platforms built for
> this market** (SAP FS-RI, Sapiens ReinsuranceMaster, Eurobase Synergy2; plus the primary-carrier suites
> Guidewire, Duck Creek, Fadata, Oracle Insurance, FIS, Majesco). This audit benchmarks RIOS against that
> footprint. It does not invent specifics about any single firm.

---

## Part 1 — Executive-panel review of the "add" flows

Each creation flow was reviewed as the responsible executive would: *can my team capture what the business
actually needs at this moment, or will they be back filling spreadsheets?*

### 1.1 New Treaty (the slip) — Chief Underwriting Officer
**Captured (good):** identification (name, kind, direction, LOB, currency, UW year), cedent & broker,
period + territory, structure (QS/surplus cession, retention lines; XL attachment/limit/layers/AAD,
reinstatements, rate on line), commission (ceding/profit/overrider/brokerage), premium (EPI, MDP, deposit).

**Was missing — now fixed in this audit wave:**
- Slip/market reference (**UMR**) and **renewal linkage** (expiring contract ref)
- **Period basis** election — losses occurring vs risks attaching vs claims made (drives claims allocation!)
- **Participation**: our written share % and order % (the form previously assumed 100% of the order)
- Cat **event definition**: hours-clause window and per-event limit on XL
- **Sliding-scale band** (min/max commission collaring the provisional rate)
- **Accounting elections**: statement frequency, UY vs AY vs clean-cut, settlement currency,
  cash-call threshold

**Still open (see Part 2):** multi-section treaties; co-reinsurer panel with leader/follower terms and
written-vs-signed reconciliation at slip level; typed persistence of commercial terms (today the `terms`
bag is schemaless jsonb — the server never validates commissions/premiums at capture); subjectivities
with due dates; wording/clause selection at capture (exists post-creation in the Treaty Workspace).

### 1.2 New Party — Chief Risk / Compliance Officer
**Captured:** legal/short name, kind, country, roles; **now also LEI, tax ID and market ID (NAIC/Lloyd's
syndicate)** into the `identifiers` store (fixed in this wave).

**Still open:** contacts and addresses at creation (`party_contact` exists but is post-creation);
settlement/bank details (`party_financial` — bank changes need maker-checker); **security ratings**
(S&P/AM Best) with history and credit limits; **sanctions/KYC screening** at creation and at payment;
group → legal entity → branch hierarchies.

### 1.3 Claim FNOL — Claims Director
**Captured:** treaty, description, loss date, currency, initial reserve; **now also catastrophe/occurrence
coding** (`catEventId` + new cat-event endpoints, fixed in this wave) so claims aggregate per market event.

**Still open:** structured peril/cause codes (free text today); layer/risk linkage on FNOL (`layer_id`,
`risk_id` columns exist); litigation/subrogation flags at intake; claims-made reporting date distinct
from loss date.

### 1.4 Other flows (from the full inventory)
- **Retrocession create is the thinnest contract flow** — no period, attachment/limit, or premium at
  capture. Should mirror the treaty slip.
- **Products have an API but no authoring UI** (`POST /api/products` is unreachable from the screen).
- **No manual AR/AP invoice or GL journal entry form** — acceptable by design (invoices arise from
  statements/bordereaux) but a controlled manual-journal screen with approval is standard in FS-RI-class GLs.
- **Employee create** captures the org essentials; the personal/statutory profile block (DOB, national IDs,
  bank/insurance) is edit-only — fine, but onboarding usually captures it once.
- Facultative admin sub-forms omit a few schema fields the API accepts (`reinsurerPartyId`, `validUntil`,
  `inspectedOn`) — low-effort wins.
- Bordereau rows validate `amount` only; per-column schemas per cedent template are the FS-RI norm
  (the mapping/validation engine exists — the per-cedent column schema library is the gap).

---

## Part 2 — Industry gap list (RIOS vs the FS-RI-class footprint)

### 2.1 Where RIOS already matches the class (verified in this repo, tested)
Multi-tenant with DB-enforced RLS · metadata-driven code lists · lifecycle state machines with illegal-
transition rejection · integer-money, double-entry GL with a reconciling technical→financial chain ·
bordereaux mapping/validation/control totals + CSV parsing · proportional & non-proportional math incl.
sliding scale (stepped + interpolated), profit commission, reinstatements, swing rating · IFRS 17
(PAA/GMM/VFA/CSM + disclosure roll-forward), Solvency II Pillar 1 + ORSA · FX revaluation ·
AR/AP aging + cash application · bank reconciliation · fixed assets · investment amortised cost (EIR) ·
commutation/LPT valuation · indexation & hours clauses · claims recoveries/inuring/event aggregation ·
P&L + balance sheet · gross/ceded/net portfolio rollup · Formula Engine (versioned formulas, breakdowns,
audited overrides) · hash-chained audit · RBAC/MFA/OIDC · workflow engine · document store · portals
(thin) · guardrailed AI assistant.

### 2.2 Missing vs the footprint — ranked by how fast a major reinsurer would hit the wall

**Tier 1 — hit in week one of real operations — ✅ CLOSED in this audit wave**
1. ~~Participation panel & signing~~ **Delivered**: `POST /api/placement/slips/:id/sign` (explicit
   sign-down with `signed <= written` and `Σ signed <= order` guards, or PRO_RATA auto sign-down when
   oversubscribed) + `GET .../signing` written-vs-signed reconciliation. Leader/follower terms on the
   panel remain a follow-on.
2. ~~Counterparty security management~~ **Delivered**: rating history (S&P/AM Best/Moody's/Fitch/internal),
   per-currency credit limits with integer-exact headroom, collateral register (LOC/funds withheld/trust/
   cash) and the `GET /api/parties/:id/security` committee view (migration 0052). Automatic limit
   *consumption at bind* remains a follow-on.
3. ~~Sanctions screening~~ **Delivered**: tenant-loaded denylist, deterministic normalised matcher
   (BLOCKED/POTENTIAL_MATCH/CLEAR), screening log, `POST /api/parties/screen`, and automatic screening on
   party creation. Live OFAC/UN/EU provider feeds populate the list per deployment.
4. ~~Typed contract terms~~ **Delivered**: the treaty `terms` payload is now a typed, validated schema
   (30+ commercial keys, cross-field refinements, passthrough for tenant extensions).
5. ~~Cash-call workflow~~ **Delivered**: requested → approved → paid with **maker/checker** (requester
   cannot approve own call), priority levels (NORMAL/URGENT/SIMULTANEOUS_SETTLEMENT) and the
   `GET /api/claims/cash-calls/queue` priority payment queue (migration 0053).

**Tier 2 — hit at first quarter close — ✅ CLOSED in this audit wave**
6. ~~UPR/DAC earning patterns~~ **Delivered**: pure earning math for pro-rata, 8ths, 24ths and
   risk-attaching (quadratic S-curve) with integer-exact `earned + UPR = written`, plus the persisted
   valuation run `POST /api/accounting/upr/run` over every non-draft contract (migration 0054).
   Follow-on: invoke the run automatically from period close.
7. ~~EPI vs booked with M&D adjustment~~ **Delivered**: `GET /api/treaties/:id/premium-tracking`
   (EPI/minimum/deposit/booked per currency + projection) and `POST /api/treaties/:id/premium-adjustment`
   booking `max(minimum, rate × GNPI) − booked` as an audited ADJUSTMENT_PREMIUM event; idempotent on
   re-run, return-premium aware.
8. ~~SOA verification engine~~ **Delivered**: `POST /api/statements/:id/verify` recomputes ceding
   commission (flat/sliding-scale collared), overrider, brokerage and reinstatement premium from the
   typed terms and flags deviations beyond tolerance (migration 0055); unverifiable items fail loudly.
9. ~~Account-current, dunning, disputes, ISO 20022~~ **Delivered**: `GET /api/finance/account-current/:partyId`
   (open AR/AP, net per currency, aging, dunning levels), disputed items that pause dunning, an idempotent
   dunning run, and payment runs with maker-checker release generating ISO 20022 pain.001 files with an
   exact-decimal control sum (migration 0056). Release produces the bank file; cash booking stays on the
   financial-event path.
10. ~~Retro cession engine~~ **Delivered**: quota-share allocation rules (LOB/currency/period filters,
    priorities) and `POST /api/retrocession/allocation/run` — largest-remainder integer allocation capped
    at the source amount, idempotent via a DB unique constraint, booking ceded events on the outward
    contract with a full source→rule→ceded trace (migration 0057). Non-QS methods are a follow-on.

**Tier 3 — hit at year-end / regulator visit**
11. **Multi-GAAP parallel ledgers** and intercompany/consolidation.
12. **Jurisdiction report packs as content** (Schedule F factors, QRT templates, IRDAI/Ind AS 117 for an
    Indian client) — the assembler exists; certified content does not.
13. **Reserving workflow**: triangles→IBNR booking with actuarial recommendation → management approval →
    GL posting, and AvE monitoring (engines exist; the governed booking workflow does not).
14. **Accumulation control at bind time**: "if we bind this, zone aggregate becomes X vs limit Y" hard/soft
    blocks; RDS scenarios; clash analysis (capacity checks exist per line, not event-scenario blocking).

**Tier 4 — platform/ecosystem maturity**
15. ACORD EBOT/ECOT + placing messages; bureau connectivity.
16. Live cat-model vendor adapters (RMS/Verisk); event-loss-table import (mock adapter exists).
17. Investment dealing/settlement sub-ledger, market data, ALM (valuation/EIR engines exist).
18. Renewal cloning with YoY terms comparison; hit-ratio analytics (renewal linkage now captured).
19. Report/dashboard designer UIs, Excel/PDF packs, semantic layer (definitions-as-data exist).
20. ILS/alternative capital (cat bonds, ILWs — parametric evaluators exist; collateral/trust tracking
    does not).

### 2.3 What the vendor suites emphasize that RIOS's architecture already anticipates
Guidewire/Duck Creek-class suites center on **product-definition-driven processing** (RIOS: metadata code
lists + product lifecycle + Formula Engine are the same idea; the product *studio* UI is the gap), and
FS-RI/Sapiens-class reinsurance systems center on **technical-account verification against contract terms**
(RIOS: the reconciling event→statement→GL chain is the foundation; the terms-recomputation verifier is the
gap). Neither gap requires re-architecture — both are workflow + content layers over engines that exist
and are tested.

---

## Traceability
Companion to [open-questions.md](./open-questions.md) (the honesty register) and the phase map in
[phases.md](./phases.md). Creation-flow field inventory verified against code on the date of the last
commit touching this file; the "fixed in this wave" items reference the same commit series.
