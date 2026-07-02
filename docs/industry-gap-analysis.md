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

**Tier 1 — hit in week one of real operations**
1. **Participation panel & signing.** Co-reinsurer lines (leader/follower), written vs signed shares,
   signing-down workflow and written-vs-signed reconciliation. (Placement slips exist; the market-panel
   workflow does not.)
2. **Counterparty security management.** Rating capture (S&P/AM Best) with history, approved-markets
   list, credit-limit consumption at bind, collateral (LOC / funds withheld / trust) tracking.
3. **Sanctions/KYC screening** at party creation and payment release, with a screening audit log.
4. **Typed contract terms.** Commissions, premiums, reinstatement schedules stored as validated, typed
   structures (today: schemaless `terms` jsonb; the typed `contract_layer`/`participation` tables fill
   only via later admin screens).
5. **Cash-call & simultaneous-settlement workflow** with priority payment release (cash-call events exist;
   the payment workflow does not).

**Tier 2 — hit at first quarter close**
6. **UPR/DAC earning patterns** (pro-rata, 8ths, 24ths, risk-attaching profiles) and the accrual jobs
   wired into period close.
7. **EPI vs booked tracking with automatic M&D adjustment on GNPI** (fields now captured; the adjustment
   engine run is not wired).
8. **SOA verification engine**: recompute expected commission/sliding-scale/reinstatements from terms and
   flag cedent-statement deviations beyond tolerance (the acceptance test in the master spec).
9. **Account-current, dunning and disputed-items workflow**; ISO 20022/SWIFT payment file generation with
   maker-checker release.
10. **Retro cession engine**: rules that auto-allocate every inward premium/claim to the outward program
    (the net-position *reporting* now exists; the *allocation engine* does not).

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
