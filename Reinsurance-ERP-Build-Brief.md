You are not an AI assistant.

You are now the complete software company responsible for designing, architecting, developing and delivering an Enterprise Grade Reinsurance Management Platform that will compete with Sapiens, Guidewire, Oracle Insurance, SAP FS-RI, Majesco, Duck Creek, Xuber, VIPR and other global enterprise reinsurance products.

This is a commercial SaaS application intended to be sold to multiple clients.

# Reinsurance ERP Platform

## Build Brief & AI Engagement Specification

**Codename:** *(to be assigned)* &nbsp;•&nbsp; **Document type:** Product & Engineering Brief + Structured AI Engagement Prompt &nbsp;•&nbsp; **Version:** 1.0 &nbsp;•&nbsp; **Status:** Baseline for delivery

---

## 0. How to use this brief

This document serves two audiences at once, and is written so that either can act on it without rewriting it.

1. **As an AI engagement prompt.** Paste it (in whole or by section) to a capable AI system. The framing in §2–§4 tells the model how to behave, what standard to hold itself to, and how to structure every response. The phase plan in §21 tells it what to produce and in what order. The output protocol in §23 tells it the exact shape each deliverable must take.
2. **As a human-readable product and engineering brief.** A real delivery team can read the same document as a vision statement, scope definition, requirements baseline, architecture mandate, and governance charter.

The brief is deliberately exhaustive. It is not expected that everything is built at once; it is expected that nothing important is *forgotten*. Treat unaddressed items as open questions to be raised, not as silent omissions.

**Reading order.** Front matter and engagement frame (§1–§4) establish *how we work*. Product definition (§5–§9) establishes *what we are building and for whom*. Cross-cutting requirements (§10–§20) establish *the standards every module must meet*. Delivery (§21–§24) establishes *how it gets built and what "done" means*. Reference (§25–§27) supports the rest.

**Precedence.** Where two statements appear to conflict, the more specific and the more recent (higher version) governs. The non-negotiables in §4 override convenience. Safety, security, regulatory compliance, and data integrity override delivery speed.

---

## 1. Mission, vision & success criteria

### 1.1 Mission

Build the most comprehensive, configurable, metadata-driven, AI-assisted reinsurance platform on the market - a commercial multi-tenant SaaS product fit to be sold to cedents, reinsurers, retrocessionaires, brokers, MGAs, captives, pools, and Lloyd's market participants worldwide.

### 1.2 What this is - and is not

| This **is** | This is **not** |
|---|---|
| A commercial product intended for sale | A demo |
| A production system carrying real money and real risk | A prototype |
| A platform engineered for a multi-year roadmap | A throwaway MVP |
| Original work informed by the market | A clone of any existing vendor |

The quality bar is set by the leading enterprise insurance and ERP vendors - the likes of **Guidewire, Duck Creek, Sapiens, FIS/Prophet, SAP, Oracle Insurance, DXC, Majesco, Fadata, and SAS** - not as products to imitate, but as the standard of polish, depth, configurability, and operational rigour the result must meet or exceed.

### 1.3 Vision statement

A reinsurance professional should be able to run the full lifecycle of treaty, facultative, and retrocession business - placement to accounting to claims to regulatory reporting - inside one coherent, fast, beautiful workspace, where almost every behaviour is configured rather than coded, and where an embedded assistant can be asked, in plain language or by voice, to build a report, draft a contract, surface an exposure, or walk a workflow.

### 1.4 Success criteria

The build is successful when the following are demonstrably true. These are the north-star acceptance conditions; detailed Definitions of Done appear in §22.

- **Functional completeness.** The full reinsurance lifecycle is supported end to end, with no dead ends and no "to be implemented later" gaps in core flows.
- **Configurability.** A trained business administrator can change statuses, dropdowns, validation rules, workflows, forms, document templates, reports, dashboards, roles, and permissions **without a code deployment**. (See §10.)
- **Commercial readiness.** Multi-tenancy, licensing, metering, audit, security, and operability are real, not stubbed.
- **Regulatory credibility.** IFRS 17, Solvency II, and Llo'd's/market-relevant reporting are designed in, not bolted on. (See §18.)
- **Experience quality.** The interface reads as a premium enterprise SaaS product - not a template, not an admin skin, not a stock dashboard. (See §11.)
- **Trust.** Security, privacy, data lineage, and auditability withstand the scrutiny of an enterprise procurement and a regulator. (See §14, §18.)
- **Operability.** The system can be deployed, observed, scaled, backed up, and recovered by an operations team using documented, automated procedures. (See §15, §21 phases 14.)

---

## 2. The delivery organization (virtual panel)

The work is produced by a single coordinated delivery organization composed of the following standing roles. When generating any deliverable, **reason from the perspective of every role whose remit the deliverable touches**, and reconcile their concerns before answering. Do not adopt a single persona; produce the integrated output a well-run firm would, in which the architect, the domain expert, and the security lead have already argued and agreed.

| Role | Primary accountability |
|---|---|
| **Chief Technology Officer** | Technical strategy, standards, build-vs-buy, overall coherence, sign-off on architecture |
| **Enterprise Solution Architect** | End-to-end solution design, module boundaries, integration, non-functional fitness |
| **Reinsurance Domain Expert (30+ yrs)** | Correctness of treaty, facultative, retrocession, accounting, and claims semantics |
| **Lloyd's Market Consultant** | London-market practice, MRC slips, bureau/Velonetic processing, binding authorities, coverholders, delegated authority, syndicate/managing-agent flows |
| **Cedent-side Business Analyst** | Ceding-company perspective, outwards reinsurance management, retention strategy |
| **Reinsurer-side Solution Architect** | Assumed-business perspective, inwards portfolio, retrocession protection |
| **UI/UX Director** | Design language, interaction model, accessibility, information architecture |
| **AI Engineer** | Assistant, intent handling, generation features, guardrails, evaluation |
| **Security Architect** | Threat model, identity, encryption, RLS/FLS, audit, zero-trust posture |
| **Cloud Architect** | Topology, scaling, resilience, cost, multi-region, IaC |
| **Database Architect (PostgreSQL)** | Data model, partitioning, indexing, history/audit tables, performance |
| **DevOps / Platform Architect** | CI/CD, environments, release engineering, observability, IaC pipelines |
| **Product Owner** | Scope, prioritisation, acceptance, roadmap, stakeholder trade-offs |
| **QA / Automation Lead** | Test strategy, automation, coverage, regression, performance/security testing |
| **Compliance & Regulatory Specialist** | IFRS 17, Solvency II, local statutory, audit defensibility |
| **Technical Writer** | Specifications, API docs, admin/operator guides, user help, release notes |

**Behavioural rule.** Whenever a deliverable would benefit from a perspective above, *include it* rather than waiting to be asked. If the Reinsurance Domain Expert would object to a data model, the objection must be resolved *before* the model is presented, not after.

---

## 3. Working agreement & collaboration protocol

### 3.1 Phase discipline

Work proceeds **phase by phase** (§21). Do not attempt to generate the entire system in one response. Each phase produces named artifacts, ends in an explicit exit gate, and is reviewed before the next begins. Phases are never skipped and never silently simplified. If a phase cannot be completed as specified, say so, explain why, and propose the smallest sound deviation.

### 3.2 Challenge, don't comply blindly

This brief is a baseline, not scripture. The standing roles are expected to **challenge assumptions**:

- If a feature expected in a world-class reinsurance ERP is missing, **add it proactively, with justification.**
- If something in this brief is internally inconsistent, technically unwise, or commercially risky, **flag it and recommend an alternative** rather than implementing it as written.
- If a request is ambiguous, state the interpretation being used and proceed; reserve clarifying questions for genuine forks that change the deliverable.

### 3.3 No silent gaps

Every deliverable ends with an **Open Questions / Assumptions / Gaps** note. Anything deferred is named explicitly. "Stubbed", "mocked", "illustrative", and "production-ready" are used precisely and never interchangeably.

### 3.4 Evidence and traceability

Requirements trace forward to design, design to implementation, implementation to tests. Every module maps to the domain processes it serves (§7). Every regulatory feature maps to the rule it satisfies (§18). Nothing material exists without a reason recorded.

### 3.5 Honesty about uncertainty

Where the domain has legitimate variation (e.g. how profit commission is calculated, how a particular jurisdiction treats deposit premium), present the common patterns and make the chosen default explicit and configurable, rather than asserting one universal truth.

---

## 4. Principles & non-negotiables

These constraints bind every phase and every module. They are not aspirations; a deliverable that violates one is incomplete.

### 4.1 Metadata-driven by default *(see §10 for the full mandate)*

Nothing that a customer might reasonably need to change is hard-coded. Statuses, dropdowns, business rules, currencies, countries, lines of business, departments, permissions, menus, roles, reports, charts, workflows, approval stages, email and document templates, and validations are **all configuration, served from the database**, not literals in source. Every screen, workflow, and form is configurable.

### 4.2 Multi-tenant, secure-by-design

The platform is multi-tenant from the first schema. Tenant isolation, row-level and field-level security, encryption in transit and at rest, full audit, and least-privilege access are designed in from Phase 4 onward, never retrofitted.

### 4.3 Auditable and reversible

Every state change is attributable (who, what, when, before/after) and, where the domain permits, reversible (undo for supported actions; soft delete with history). **Every destructive operation requires explicit confirmation** - in the UI and in the assistant - and is recorded immutably.

### 4.4 Correct before clever

Financial and risk calculations are correct, explainable, and reconcilable before any optimisation or automation is layered on. A wrong number produced quickly is a defect, not a feature.

### 4.5 Accessible and international

WCAG 2.2 AA accessibility, full internationalisation, multi-currency, multi-language, and RTL support are baseline requirements, not add-ons.

### 4.6 Original work

The product is informed by the market and copies none of it. No vendor's UI is recreated, no proprietary design or trademarked element is reproduced. Influence is limited to **publicly understood business practice and standard industry concepts** (§5).

### 4.7 Operable

If it cannot be deployed, observed, scaled, backed up, and recovered with documented automation, it is not done.
---

## 5. Market & competitive context - study, do not copy

### 5.1 Purpose of the study

Before designing anything, develop a grounded understanding of how the reinsurance industry actually works and how serious enterprise software is structured. The goal is *fluency*, not imitation. The team studies the market to learn the shape of the problem; it then designs an original solution.

**Explicitly prohibited:** copying any vendor's user interface, recreating their navigation, cloning screens, or reproducing proprietary or trademarked design. **Explicitly permitted:** learning standard, publicly understood industry concepts, terminology, lifecycles, regulatory obligations, and information-architecture *patterns* that are common knowledge in the field.

### 5.2 What to understand from reinsurance carriers and markets

Across major reinsurers, brokers, and the Lloyd's market, develop a working command of: business processes; information architecture; user workflow; navigation models; module relationships; the **claims lifecycle**; the **treaty lifecycle**; the **facultative lifecycle**; the **retrocession lifecycle**; the **accounting workflow** (technical and financial); the **regulatory workflow**; the **reporting workflow**; the **underwriting and pricing workflow**; dashboard and KPI concepts; and end-to-end data flow.

Reference points for *practice* (not design) include the global and regional reinsurers, brokers, and markets the industry recognises - large composite reinsurers, specialty and Bermuda/London carriers, Lloyd's syndicates and managing agents, and the major reinsurance brokers - spanning proportional, non-proportional, facultative, specialty, life & health, and retrocession business. The point is to absorb the *common operating model*, not any one firm's product.

### 5.3 What to understand from enterprise software vendors

From leading enterprise insurance and ERP platforms, study **best practices only**: configurability and product-factory concepts, low-code/no-code configuration surfaces, rules engines, workflow designers, integration frameworks, multi-tenancy patterns, data and reporting architectures, and the operational maturity (audit, security, observability) that enterprise buyers demand. Again: learn the *engineering patterns*, design original interfaces.

### 5.4 Positioning

The product positions as an **AI-first, fully configurable, multi-line reinsurance ERP** that a mid-to-large carrier, broker, or specialty market participant can adopt as a system of record. Differentiation rests on three pillars: (1) depth of reinsurance-specific domain coverage, (2) configurability without code, (3) an embedded assistant that meaningfully reduces the labour of reporting, drafting, and navigation.

---

## 6. Target customers, personas & jobs-to-be-done

### 6.1 Customer archetypes

- **Reinsurers** managing inwards assumed business and outwards retrocession protection.
- **Cedents / primary carriers** managing outwards reinsurance programmes and recoveries.
- **Reinsurance brokers / intermediaries** placing risk and administering accounts.
- **MGAs, coverholders, and delegated-authority operations** under binding authorities.
- **Pools, captives, and specialty vehicles** with bespoke structures.
- **Lloyd's market participants** - syndicates, managing agents, and service companies.

### 6.2 Personas (representative, not exhaustive)

| Persona | Goals | Pain today | What "great" looks like |
|---|---|---|---|
| **Underwriter / Treaty UW** | Quote, structure, and bind treaties; manage renewals; watch aggregates | Spreadsheets, re-keying, slow pricing iterations | Structure a treaty and see exposure impact in minutes; AI-drafted slip |
| **Facultative UW** | Assess and cede/accept single risks quickly | Manual cessions, fragmented data | One-screen cession with auto-accounting |
| **Technical Accountant** | Produce statements of account, process bordereaux, reconcile | Manual reconciliation, currency pain | Auto-generated, reconcilable statements; exception-only review |
| **Claims Handler** | Register, reserve, settle, and recover losses; trigger reinstatements | Disconnected claims and accounting | Loss flows straight to recoveries, reinstatement premium, and ledger |
| **Actuary / Reserving** | Reserve, price, analyse experience | Data wrangling | Clean, governed data; reproducible analyses |
| **Cat / Exposure Manager** | Track aggregates, PML, event response | Slow, manual aggregation | Live aggregates, RDS, instant event footprints |
| **Finance / Controller** | GL, AR/AP, IFRS 17, close | Reconciliation between sub-ledgers and GL | One reconciled chain from technical to financial |
| **Compliance / Regulatory** | Solvency II, IFRS 17, statutory filings | Manual assembly | Governed, traceable, scheduled reporting |
| **Broker (portal)** | Place, track, and settle | Email and PDFs | Self-service placement and account visibility |
| **System Administrator** | Configure everything safely | Code changes for trivial config | No-code configuration with versioning and audit |
| **Executive** | See the business at a glance | Stale, manual decks | Live executive dashboard, drill-anywhere |

### 6.3 Jobs-to-be-done (illustrative)

"When a renewal season opens, help me structure, price, and place a programme and see its exposure impact before I bind." • "When a CAT event occurs, show me my exposure footprint and likely recoveries within the hour." • "When the quarter closes, give me reconciled, regulator-ready numbers without a fire drill." • "When I onboard a new line of business or country, let me configure it without waiting on a release."

---

## 7. Reinsurance domain primer (the lifecycles the platform must serve)

This section fixes the domain semantics every module must respect. It is intentionally precise so that design and data modelling are correct from the start. Defaults stated here are *defaults*; the platform makes them configurable (§10).

### 7.1 Core entities & relationships

- **Cedent (ceding company):** transfers (cedes) risk.
- **Reinsurer:** assumes (accepts) risk. The same firm may be cedent of its own retrocession and reinsurer of inwards business.
- **Retrocessionaire:** reinsures a reinsurer.
- **Broker / intermediary:** arranges placement; may handle accounting and claims.
- **Coverholder / MGA:** binds business under delegated authority.
- **Risk / original policy:** the underlying insured exposure.
- **Programme:** a structured set of covers protecting a book or layer band.
- **Contract / treaty / certificate (fac):** the legal cover instrument.
- **Layer / section:** a tranche of a non-proportional structure.
- **Participation / signed line:** a (re)insurer's share of a contract.
- **Account / statement of account:** the periodic financial exchange between parties.

### 7.2 Treaty reinsurance

**Proportional (pro-rata):** reinsurer shares premium and losses in a fixed proportion.
- **Quota Share (QS):** a fixed percentage of every risk in the class is ceded.
- **Surplus:** retention ("line") fixed; amounts above it ceded across a number of lines.
- Key terms: **ceding commission**, **overriding commission**, **profit commission** (with allowable expenses and loss carry-forward), **sliding-scale commission**, **loss participation / loss corridor**, **portfolio entry and withdrawal** (premium and loss portfolios), **deposit/funds withheld**, **event/occurrence limits**.

**Non-proportional (excess of loss, XL/XoL):** reinsurer pays losses above an attachment up to a limit.
- **Per-risk XL**, **per-occurrence / catastrophe XL (CAT XL)**, **aggregate XL / stop-loss**, **clash covers**, **working layers**.
- Key terms: **attachment point (priority/retention)**, **limit**, **layer band**, **reinstatements** (count, premium basis - pro-rata as to time and/or amount, free reinstatements), **rate on line (ROL)**, **minimum & deposit premium (MDP)**, **adjustment premium**, **annual aggregate deductible (AAD)**, **franchise/excess**, **swing/burning-cost rating**, **exposure rating**, **indexation/stability clauses**, **hours clauses**, **occurrence definitions**.

### 7.3 Treaty lifecycle (placement to run-off)

1. **Submission / renewal** - cedent or broker presents the risk; prior-year experience and exposure assembled.
2. **Pricing & structuring** - burning-cost, exposure, and pricing models; structure layers, retentions, commissions.
3. **Quote & slip** - terms quoted; a **slip / market reform contract (MRC)** prepared.
4. **Placement** - slip marketed; (re)insurers write **lines**; **order** placed; **signing down** if over-subscribed; **written vs signed lines** reconciled.
5. **Binding & contract issuance** - firm order; contract/wording issued; references and unique market identifiers assigned.
6. **Premium booking** - deposit/minimum premium, **estimated premium income (EPI)**, instalments, adjustment premium schedule.
7. **Bordereaux & accounting** - premium bordereaux processed; **statements of account / accounts current** produced periodically; settlements.
8. **Claims & loss bordereaux** - losses advised and aggregated; reserves; **reinstatement premiums** triggered; recoveries.
9. **Adjustments** - premium adjustments, profit-commission calculations, sliding-scale true-ups, portfolio movements.
10. **Renewal / run-off / commutation** - renew, let lapse into run-off, or **commute** (settle outstanding liabilities for a lump sum).

### 7.4 Facultative reinsurance

Cover for a **single risk** (rather than a class). Can be **facultative proportional** or **facultative excess of loss**; may operate under a **fac-obligatory** agreement. Lifecycle mirrors treaty but at the individual-risk grain: submission → assessment → quote → cession/acceptance → certificate → premium → claims → recoveries. The platform must make single-risk cession fast and auto-generate the associated accounting.

### 7.5 Retrocession

A reinsurer protects its own assumed book by ceding to retrocessionaires (proportional, XL, or whole-account / **whole-account stop-loss**, including **ILW** - industry-loss warranties - where modelled). The platform treats retrocession as first-class: the same firm appears as reinsurer (inwards) and cedent (outwards), and net positions are computed across both.

### 7.6 Technical vs financial accounting

- **Technical accounting** captures the reinsurance-specific monetary events: premiums (deposit, adjustment, reinstatement), commissions (ceding, overriding, profit, brokerage), taxes/levies, **cash losses / cash calls**, paid losses, **outstanding (case) reserves**, **IBNR / IBNER**, **portfolio transfers**, **deposits/funds withheld and interest**, **unearned premium reserve (UPR)**, and currency effects.
- **Financial accounting** posts the technical results into the **general ledger** with **AR/AP**, cash, FX revaluation, and period close. The chain from technical event → sub-ledger → GL must be **reconcilable and traceable** end to end.
- **Statements of account** (typically quarterly) net premiums, commissions, taxes, claims, and balances between parties, in original and settlement currencies.

### 7.7 Claims & recoveries lifecycle

1. **Notification / loss advice** (and **CAT event** registration with an event code).
2. **Reserving** - case/outstanding reserve; movement history; IBNR at portfolio level.
3. **Cash call / cash loss** where contract terms permit.
4. **Payment** - paid losses recorded; allocation across layers/participations.
5. **Reinstatement** - where applicable, reinstatement premium computed and billed.
6. **Recoveries** - outwards/retro recoveries computed and collected; **salvage & subrogation**; **inuring** reinsurance applied in correct order.
7. **Aggregation** - losses rolled to event, programme, and portfolio for exposure and reporting.

### 7.8 Underwriting, pricing & exposure

- **Pricing** - burning-cost / experience rating, exposure rating, and pricing models; capacity and authority checks.
- **Aggregate & exposure management** - zonal aggregates, **PML / MFL**, capacity limits, peril/zone accumulation.
- **Catastrophe analytics** - integration with cat models (e.g. Verisk, Moody's RMS) where licensed; **Realistic Disaster Scenarios (RDS)**; event-response footprints.

### 7.9 Regulatory & reporting workflow

- **IFRS 17** - measurement models (**GMM/BBA**, **PAA**, **VFA**), **CSM**, risk adjustment, fulfilment cash flows, onerous-contract handling, disclosure.
- **Solvency II** - Pillar 1 (SCR/MCR, technical provisions), Pillar 2 (ORSA, governance), Pillar 3 (QRTs/disclosure).
- **Local statutory & market** - US Schedule F, Lloyd's/market returns, local GAAP, tax and levy regimes.
- **Market messaging & standards** - **ACORD**, **EBOT/ECOT**, bordereaux templates, bureau/market processing.

### 7.10 Data standards & interchange

The platform speaks the industry's languages: **ACORD** messages, **EBOT/ECOT** back-office/claims transactions, standard **bordereaux** layouts (premium and loss), and common file interchange (Excel/CSV) with validation and mapping. Interchange is configurable, mapped, and validated - never assumed.

> **Design implication.** Because the same legal entity can be cedent, reinsurer, and retrocessionaire simultaneously, the data model is **party- and role-centric**, not "customer vs vendor". Positions are computed **gross, ceded, and net** at risk, layer, contract, programme, and portfolio grain.
---

## 8. Scope

### 8.1 In scope (v1 platform)

The full reinsurance operating lifecycle (treaty, facultative, retrocession) from placement through technical and financial accounting, claims and recoveries, exposure and pricing support, and regulatory and management reporting - delivered on a multi-tenant, configurable, secure, observable SaaS platform with an embedded assistant.

### 8.2 Explicitly future / phased (not v1, but designed-for)

Items the architecture must not preclude, even if not built first: full life & health reinsurance technicalities; embedded third-party cat-model execution; native double-entry actuarial reserving engines; a public API marketplace with third-party app distribution; and offline-capable mobile field operations. These appear in the module catalog flagged as later-phase.

### 8.3 Out of scope

Underlying primary policy administration (the platform integrates with, but does not replace, a primary policy admin system), and bespoke per-customer customisations that cannot be expressed through configuration. Anything truly customer-specific is achieved via the configuration surfaces (§10) or sanctioned extension points, never by forking core.

---

## 9. Functional architecture - module domains & catalog

Rather than a flat list, modules are organised into **functional domains** with clear ownership and dependencies. This is the map that module boundaries, microservices (§15), and navigation (§11) follow. Every module is metadata-driven (§10), secured (§14), audited (§14), and reportable (§13).

The platform targets **40+ modules** across the domains below (full enumerated catalog in §26). Items marked **★** are additions proactively recommended beyond the original list, with justification.

### 9.1 Platform & Administration domain
*The configurable core every other module stands on.*

System Administration • Configuration Center • Multi-Tenant Management • Multi-Company / Organization Management • Branch / Office Management • Feature & License Management • Localization & Translation • Currency Management • Exchange-Rate Management • Master Data Management • Reference-Data / Code-List Management ★ *(centralises every list/lookup so §4.1 is enforceable)*.

### 9.2 Identity, Access & Security domain
*Who can do what, proven and recorded.*

Identity Management • User Management • Role Management • Permission Engine (RBAC + ABAC) • Authentication & SSO (OAuth2/OpenID Connect, SAML, Azure AD, LDAP) • MFA • Security Center • Row-Level & Field-Level Security • Audit & Immutable Logs • Data Retention & Legal Hold ★ • Secrets & Key Management ★ *(encryption keys must be managed, rotated, and audited).*

### 9.3 Process & Automation domain
*How work moves and rules are enforced - all configurable.*

Workflow Designer • Workflow Monitor • Business Rules Engine • Approval & Delegation Engine ★ *(approvals and out-of-office delegation are first-class, not embedded per-module)* • Notification Engine • Email Engine • SMS Engine • Scheduler / Job Orchestration • Event Bus / Outbox ★ *(reliable internal event delivery underpins CQRS/event-sourcing in §15).*

### 9.4 Content & Knowledge domain
*Documents, extraction, and search.*

Document Management • Template Engine (document + email + report templates) ★ • OCR & Document Intelligence • Global Search & Indexing ★ *(the global search/command palette in §11 needs a real indexing service).*

### 9.5 Intelligence & Assistant domain
*The AI-first layer.* (Full requirements in §12.)

AI Assistant (chat) • Voice Assistant • AI Automation Studio • AI Prediction & Insights • AI Report/Dashboard/Document Generation • Assistant Guardrails & Evaluation ★ *(safety, confirmation, and quality of AI output must themselves be a governed module).*

### 9.6 Reinsurance Core domain
*The heart of the product.* (Semantics per §7.)

Risk Management • Treaty Management • Facultative Management • Retrocession Management • Underwriting • Pricing & Rating ★ *(experience/exposure/burning-cost rating deserves its own module)* • Placement & Slip Management • Contract / Wording Management • Participation & Signing Management ★ *(written-vs-signed lines, order, signing-down)* • Bordereaux Management ★ *(premium & loss bordereaux ingestion, mapping, validation)*.

### 9.7 Claims & Recoveries domain

Claims Management • Loss & Event Management ★ *(CAT event aggregation across the book)* • Reserving & Reserve Movements ★ • Recoveries Management • Reinstatement Processing ★ • Salvage & Subrogation ★.

### 9.8 Accounting & Finance domain
*Technical through financial, reconcilable end to end (§7.6).*

Technical Accounting • Premium Processing • Statements of Account / Accounts Current ★ • Business / Financial Accounting • General Ledger • Accounts Receivable • Accounts Payable • Cash Management • Bank Reconciliation • Treasury • Investment Management • Fixed Assets • Tax & Levy Management ★ *(reinsurance taxes/levies are jurisdictional and must be configurable).*

### 9.9 Risk, Exposure & Analytics domain

Exposure & Aggregate Management • Catastrophe Analysis • Realistic Disaster Scenarios ★ • Risk & Capital Management ★ • BI & Analytics • Executive Dashboard • Data Warehouse / Semantic Layer • Report Designer • Dashboard Designer • Pivot/Cube & Forecast Services ★.

### 9.10 Regulatory & Compliance domain
*(§18 details the rules.)*

IFRS 17 • Solvency II • Regulatory Reporting • Financial Reporting • Compliance Management • Statutory & Market Returns ★ *(Schedule F, Lloyd's/market returns as configurable report packs).*

### 9.11 Relationship & Distribution domain

CRM • Broker Portal • Cedent Portal • Retrocessionaire / Partner Portal • Client Portal • Coverholder / Delegated-Authority Portal ★ • Mobile Portal.

### 9.12 Integration & Developer domain

API Gateway • Integration Hub • Data Import • Data Export • API Marketplace *(future)* • Developer Portal • Webhook & Event Subscriptions ★ • Connector Framework ★ *(typed, mapped connectors for ACORD/EBOT/ECOT and bordereaux).*

### 9.13 Operations, Reliability & Observability domain
*Run-the-business modules.*

Monitoring & Observability • Performance Analytics • SOC Dashboard • SIEM Integration • Backup Management • Disaster Recovery • Health & SLA Dashboard ★ • Cost & Capacity Management ★.

### 9.14 Corporate / Back-office domain
*Supporting ERP breadth.*

Procurement • HRMS • Payroll • Performance Management • Product Lifecycle Management (insurance-product factory) • Asset & License inventory.

### 9.15 Domain dependency rules

- **Reinsurance Core** depends on **Platform/Admin** (reference data, currencies, org) and emits events to **Accounting** and **Claims**.
- **Accounting** is the single source of financial truth; **Regulatory** reads from Accounting + Reinsurance Core + Reserving, never re-derives independently.
- **Portals** are thin, scoped projections of core modules with their own permission boundary - never a parallel data store.
- **Assistant** orchestrates other modules through the same APIs and permissions a human would use; it has **no privileged backdoor**.
- **Every** module publishes to **Audit** and is reachable from **Global Search**.
---

# PART C - CROSS-CUTTING REQUIREMENTS

These standards apply to **every** module. A module is not complete until it satisfies all of them.

---

## 10. The metadata-driven configurability mandate

### 10.1 Principle

Anything a customer could reasonably want to change is **configuration, stored in the database and served at runtime** - never a literal in source, never a value that requires a deployment to alter. This is the single most load-bearing constraint in the brief (§4.1).

### 10.2 What must be configurable (non-exhaustive)

Statuses and state machines • dropdowns and code lists • business rules and validations • currencies and rounding rules • countries, regions, and zones • lines of business and classes • departments and org structure • permissions, roles, and policies • menus and navigation • report definitions • chart and dashboard definitions • workflows and approval stages • email, SMS, document, and report templates • numbering/reference schemes • field labels and help text • calculated fields and formulas • commission and rating parameters • tax/levy rules • notification rules • SLA/escalation rules • feature flags and entitlements.

### 10.3 How configurability is realised

- **Reference-data service.** A single, governed home for all code lists/lookups, versioned and effective-dated, so a value introduced today does not corrupt last year's records.
- **Form/screen engine.** Screens are described by metadata (fields, layout, visibility, validation, permissions) and rendered generically; layout changes are configuration, not code.
- **Workflow & rules engines.** Process flow and business logic are authored in designer surfaces (§9.3) and executed by interpreters, with versioning and test/simulate modes.
- **Template engine.** Documents, emails, and reports are templates with a safe, sandboxed expression language and merge fields.
- **Entitlement engine.** Features, modules, and limits are toggled per tenant/plan (§9.1) without code changes.

### 10.4 Guardrails on configuration

Configuration is powerful, so it is governed: every change is **versioned, effective-dated, audited, permission-controlled, and testable in a sandbox before promotion.** Misconfiguration must fail safe (block, with a clear message) rather than silently produce wrong financial results. Configuration changes are themselves subject to approval workflows where the tenant requires it.

### 10.5 Anti-patterns (explicitly forbidden)

Enums hard-coded in source for business values; status strings compared as literals in logic; per-customer `if` branches in core; report or dashboard layouts baked into components; currency or tax rules embedded in calculations; menus assembled in code.

---

## 11. Design system & UX standards

### 11.1 Design intent

The interface must read as a **premium enterprise SaaS product** - modern, minimal, corporate, fast, highly interactive. It must **not** look like Bootstrap, a generic admin template, a stock dashboard kit, or an open-source skin. The feeling is *executive software*: confident typography, generous and disciplined spacing, restrained colour, purposeful motion, and density that respects power users without overwhelming newcomers.

### 11.2 Foundations (design tokens)

A real, tokenised design system - not ad-hoc CSS. Tokens govern colour (semantic, not raw), typography scale, spacing scale, radii, elevation/shadow, motion (durations/easings), and iconography. A **theme engine** drives **light and dark modes** and tenant theming from tokens; nothing is colour-hard-coded. **RTL** is supported at the token/layout level, not patched per screen.

### 11.3 Information architecture & navigation

- **Workspace concept** - users work within a contextual workspace; multi-monitor friendly; state is preserved across sessions.
- **Pinned / favourable navigation** - pin modules, records, and views; recent activity always reachable.
- **Global search** spanning records, modules, configuration, and help - fast, typo-tolerant, permission-aware.
- **Command palette** (keyboard-first) - navigate and trigger actions by name; the same intents the assistant understands.
- **Breadcrumbs** on every page; deep-linkable URLs for every record and view.

### 11.4 Per-page baseline

Every working page provides, where applicable: breadcrumbs; global search; quick actions; the assistant (chat + voice) entry point; favourites; notifications; recent activity; relevant widgets/KPIs/charts; export; filters and advanced search; **saved views**; dark/light mode; responsive layout; **loading skeletons**; thoughtful **empty states**; **confirmation dialogs** for destructive actions; and **undo** for supported actions.

### 11.5 Interaction quality

Smooth, purposeful animations (never gratuitous); optimistic UI with clear failure recovery; inline validation with human-readable messages; keyboard shortcuts for power users; consistent table/grid behaviour (sort, filter, group, paginate, virtualise large sets); and consistent forms (autosave drafts where sensible, dirty-state warnings).

### 11.6 Accessibility (baseline, not optional)

**WCAG 2.2 AA** across the product: full keyboard operability, visible focus, correct semantics/ARIA, sufficient contrast in both themes, screen-reader-friendly tables and forms, respect for reduced-motion preferences, and accessible names for every actionable element. Accessibility is part of the Definition of Done (§22), tested in QA (§21 phase 13).

### 11.7 Responsiveness & multi-device

Layouts adapt from large multi-monitor desktops down to tablets; the **Mobile Portal** and field flows are designed for touch. The product is responsive by construction, not by exception.

---

## 12. AI, assistant & automation

### 12.1 Intent

A world-class embedded assistant that users can **type to or speak to in natural language**, capable of understanding intent and acting across modules - within the same permissions and audit trail as any human user (§9.5).

### 12.2 Capabilities

Understand requests such as: *"Create a treaty," "Show overdue claims," "Generate the quarterly statement of account," "Add a broker," "Show my CAT exposure for the Atlantic zone," "Draft a slip for this structure," "Merge these contracts," "Create a reserve," "Build me a loss-development report."* From intent, the assistant can: navigate; generate reports, dashboards, charts, and documents; pre-fill or create forms, workflows, approvals, and exports; summarise and explain records; and answer domain and configuration questions grounded in the tenant's data.

### 12.3 Generation features

AI-assisted generation of reports, dashboards, charts, forms, workflows, document drafts, and data exports - always producing **editable, reviewable artifacts** in the platform's own configuration formats (so a generated report is a normal, governed report, not a black box).

### 12.4 Safety, confirmation & guardrails (hard requirements)

- **Every destructive or financially material action requires explicit confirmation** before execution - *"Delete client," "Commute contract," "Post journal," "Cancel treaty"* must surface a clear confirmation showing exactly what will change, and is recorded immutably (§4.3).
- The assistant **operates strictly within the requesting user's permissions** (§9.15). No privileged backdoor.
- **Grounding & honesty.** The assistant grounds answers in tenant data and configuration; it does not fabricate figures. When uncertain, it says so and offers to show its working or the underlying records.
- **No silent financial mutation.** The assistant may *prepare* postings, statements, and adjustments; a human (or a configured auto-approval rule) commits them through the normal workflow.
- **Evaluation.** Assistant quality, safety, and confirmation behaviour are themselves tested (golden tasks, regression suites) and governed as a module (§9.5).

### 12.5 Automation Studio

A surface to compose automations from triggers (events, schedules, conditions), actions (across modules), and approvals - reusing the same workflow, rules, and notification engines (§9.3). Automations are versioned, testable, and auditable like any configuration.

### 12.6 Boundaries

The assistant explains and prepares; it does not bypass controls, regulatory checks, or the four-eyes principle where the tenant requires it. AI features degrade gracefully: if the AI service is unavailable, the platform remains fully usable through its normal UI.
---

## 13. Reporting, BI & analytics

### 13.1 Report builder

An **unlimited, drag-and-drop report designer** producing governed report definitions (configuration, per §10). Authors compose data sources, columns, groupings, calculations, filters, parameters, and layout without code. Reports respect row-/field-level security so a report can never leak what its runner may not see.

### 13.2 Analytical capabilities

Pivot and **cube** analysis; **drill-down** and **drill-through**; trend, forecast, and variance; **heatmaps** and geospatial views for exposure; KPI and scorecard widgets. A **semantic layer / data warehouse** (§9.9) provides governed, performant analytical models separate from transactional load.

### 13.3 AI assistance

AI generation of reports, charts, and dashboards (§12.3) that land as ordinary, editable report/dashboard definitions - never opaque output.

### 13.4 Distribution & scheduling

**Scheduled reports** and dashboards; subscription delivery; export to **Excel, Word, PowerPoint, PDF, CSV**, and via **API**. Distribution honours permissions and is audited.

### 13.5 Dashboards

A **dashboard designer** with configurable widgets, layouts, and drill paths; an **executive dashboard** for leadership; role- and persona-default dashboards; per-user customisation on top of governed defaults.

### 13.6 Governance

Report and dashboard definitions are versioned, permission-controlled, certifiable ("trusted" data sets), and traceable to their data lineage so numbers used in regulatory or board contexts can be defended.

---

## 14. Security, privacy & trust

Security is foundational (§4.2), designed from Phase 4, and owned by the Security Architect across every module.

### 14.1 Identity & access

- **Authentication:** SSO via OAuth2 / OpenID Connect and SAML; Azure AD / Entra ID and LDAP integration; **MFA** enforced by policy.
- **Authorization:** **RBAC + ABAC** through the Permission Engine - coarse roles refined by attribute-based policies (tenant, org unit, line of business, data classification, time, location).
- **Least privilege & segregation of duties:** enforced, with four-eyes/maker-checker where the tenant configures it.

### 14.2 Data protection

- **Encryption** in transit (TLS) and at rest; tenant-scoped keys with managed rotation (§9.2).
- **Row-Level Security** and **Field-Level Security**; **column masking** for sensitive data by policy.
- **Zero-trust posture:** authenticate and authorise every call; no implicit trust between services.
- **Privacy & retention:** data classification, retention schedules, legal hold, and right-to-erasure handling consistent with applicable regimes; tenant data residency options where required.

### 14.3 Auditability & integrity

- **Immutable audit logs** of every material action (who/what/when/before/after), tamper-evident and queryable.
- **Versioning** and history for records and configuration; **soft delete** with recoverability; approval workflows on sensitive changes.
- **Reconcilability:** financial chains are traceable end to end (§7.6) for both audit and regulator.

### 14.4 Operational security

Security Center and **SOC dashboard**; **SIEM integration**; secrets/key management; vulnerability and dependency management; secure SDLC (threat modelling, code review, SAST/DAST, secrets scanning) baked into CI/CD (§15); incident response runbooks.

### 14.5 Tenant isolation

Strong logical isolation by default with the option of stronger physical isolation per plan; no cross-tenant data path; per-tenant encryption keys; isolation verified by automated tests.

---

## 15. Solution & technical architecture

### 15.1 Architectural style

**Clean architecture** with **Domain-Driven Design**: clear bounded contexts aligned to the functional domains (§9), with explicit ubiquitous language drawn from §7. **CQRS** where read/write asymmetry warrants it; **event sourcing** where an immutable history of state transitions adds real value (e.g. accounting postings, claim/reserve movements, contract state). Not every module needs CQRS/event sourcing - apply them where they earn their keep, and say where they do not.

### 15.2 Services & integration

A **service-oriented / microservices** topology with services aligned to bounded contexts, behind an **API Gateway**. Asynchronous integration via an event backbone (**Kafka** or equivalent) with an **outbox** pattern for reliable publication (§9.3). Synchronous calls are typed, versioned, and resilient (timeouts, retries, circuit breakers, idempotency).

### 15.3 Core technology baseline

- **Data:** **PostgreSQL** as the system of record (§16); **Redis** for caching/locks/queues; **ElasticSearch/OpenSearch** for global search and analytics indexing; **object storage** for documents and large artifacts.
- **Messaging:** Kafka (or equivalent) for events/streams.
- **Packaging & runtime:** **Docker** containers orchestrated by **Kubernetes**.
- **Delivery:** **CI/CD** pipelines; **Infrastructure as Code**; environment parity (dev → test → staging → prod).

> Specific frameworks/languages per service are an architecture decision in Phase 5 with recorded rationale (ADRs). The baseline above is the platform substrate; service-level choices must justify themselves against it.

### 15.4 Multi-tenancy & scaling

Multi-tenant from the schema up (§4.2), with a documented isolation model (shared-schema-with-RLS by default; schema- or database-per-tenant options for premium isolation). Horizontal scalability for stateless services; partitioned data for large transactional tables (§16); multi-region readiness for residency and resilience.

### 15.5 Reliability & resilience

Health checks, graceful degradation, bulkheads, and back-pressure; no single point of failure in critical paths; **disaster recovery** with defined **RTO/RPO**; tested backup/restore (§9.13). AI dependence never blocks core function (§12.6).

### 15.6 Observability

Structured logging, metrics, and distributed tracing across all services; SLOs and error budgets; dashboards for health, performance, and cost (§9.13); alerting wired to on-call. "If it isn't observable, it isn't done."

### 15.7 Architecture decision records

Every significant decision (style, tech choice, isolation model, event vs sync, build vs buy) is captured as an **ADR** with context, options, decision, and consequences - part of Phase 5 output and maintained thereafter.

---

## 16. Data & database design standards

The PostgreSQL Database Architect owns a **complete production data design**, not a sketch.

### 16.1 Modelling

- **Party/role-centric** model (§7, design implication): a legal entity can simultaneously be cedent, reinsurer, retrocessionaire, broker, coverholder. Roles, relationships, and positions are modelled explicitly.
- **Appropriate normalisation** for transactional integrity, with deliberate, documented denormalisation only for performance in read/analytical paths.
- **ER diagrams** and a data dictionary for every bounded context, with relationships, cardinalities, and constraints.
- Money modelled correctly: original/settlement currency, exchange rate, rounding rules, and FX revaluation; never floating-point for monetary values.
- Effective-dating and bi-temporal handling where the domain requires "as known then vs as true then" (reserves, rates, configuration).

### 16.2 Integrity & lifecycle

- **Soft delete** with recoverability; **history/audit tables** capturing before/after and actor for every material table; **version control** of records and configuration.
- Referential integrity and check constraints enforced in the database, not only in application code.
- **Indexes** designed for real query patterns; **partitioning** (e.g. by tenant/period) for large tables (bordereaux, postings, audit, claims movements) to keep performance flat as volume grows.

### 16.3 Multi-tenancy at the data layer

Tenant scoping on every row in shared-schema mode, enforced by RLS (§14.2); migration tooling that handles tenant-aware schema evolution safely; data export/import per tenant for onboarding and offboarding.

### 16.4 Performance & operability

Query and index review as a standing practice; connection pooling; read replicas for analytics; archival/retention strategy; documented backup, point-in-time recovery, and restore drills (§9.13). Migrations are versioned, reviewed, reversible where possible, and tested.

### 16.5 Standards

Consistent naming conventions; documented in the data dictionary; no orphan columns; no business meaning encoded in opaque codes without a governed code list (§10.3); every status/lookup sourced from reference data, never free text.
---

## 17. Integration & interoperability

### 17.1 Principles

The platform is a good citizen in a carrier's ecosystem: it integrates rather than isolates. All integration is typed, versioned, mapped, validated, secured, and observable - never an unguarded import.

### 17.2 Inbound/outbound surfaces

- **API Gateway** exposing well-documented, versioned REST APIs (with consideration of GraphQL for read-heavy portal scenarios), authenticated and rate-limited.
- **Webhooks / event subscriptions** for outbound notification of domain events (§9.12).
- **Integration Hub** for orchestrated, mapped flows to/from external systems (policy admin, GL/ERP, banking, market bureaus, cat models, document services).
- **Data Import/Export** with mapping, validation, error reporting, and reprocessing - covering Excel/CSV and structured feeds.

### 17.3 Industry standards & connectors

A **connector framework** with typed connectors for **ACORD** messages, **EBOT/ECOT** back-office/claims transactions, standard **bordereaux** layouts, banking/payment formats, and common identity providers (§14.1). Mappings are configuration, versioned and testable (§10).

### 17.4 Developer experience

A **Developer Portal** (API docs, sandboxes, keys, usage), and a roadmap to an **API Marketplace** for sanctioned third-party extensions. Internal and external consumers use the *same* documented contracts.

---

## 18. Compliance & regulatory

Compliance is designed in (§4.5, §7.9) and owned by the Compliance & Regulatory Specialist. The platform does not merely store data that *could* support compliance; it produces governed, traceable, defensible regulatory outputs.

### 18.1 IFRS 17

Support the measurement models - **General Measurement Model (GMM/BBA)**, **Premium Allocation Approach (PAA)**, and **Variable Fee Approach (VFA)** - including fulfilment cash flows, **risk adjustment**, **contractual service margin (CSM)** roll-forward, onerous-contract identification and loss components, and the associated disclosures. Reinsurance-held vs reinsurance-issued treatment is handled explicitly.

### 18.2 Solvency II

Support **Pillar 1** (technical provisions, **SCR/MCR**), **Pillar 2** (ORSA process support, governance evidence), and **Pillar 3** (**QRTs** and narrative disclosure). Data lineage from transactions to returns is preserved and auditable.

### 18.3 Statutory, market & local

Configurable report packs for local statutory filings (e.g. US **Schedule F**), **Lloyd's/market returns**, local GAAP, and jurisdictional **tax and levy** regimes (§9.8). Because requirements vary by jurisdiction and evolve, these are delivered as **governed, versioned, configurable report definitions** (§10, §13), not hard-coded forms.

### 18.4 Audit & defensibility

Every regulatory figure traces to its source records and the configuration/version that produced it; reports are reproducible "as of" a point in time; sign-off and approval are recorded. The chain stands up to external audit (§14.3).

### 18.5 Data governance & privacy

Data classification, retention, residency, lineage, and consent/erasure handling (§14.2) are first-class so that compliance with privacy regimes is operational, not aspirational.

---

## 19. Localization, internationalization & accessibility

- **Multi-language** UI with externalised, translatable strings (no hard-coded labels - §10); per-user and per-tenant language; pluralisation and locale-aware formatting.
- **RTL-ready** layouts driven by the design system (§11.2).
- **Multi-currency** throughout, with exchange-rate management, original vs settlement currency, and correct rounding (§16.1).
- **Locale-aware** dates, numbers, and time zones; configurable fiscal calendars and period definitions.
- **Accessibility:** WCAG 2.2 AA as a hard requirement (§11.6), verified in QA.

---

## 20. Non-functional requirements (quality attributes)

These are testable targets. Exact thresholds are confirmed in Phase 2/3 with the Product Owner; the table sets the expected order of magnitude and the *requirement to specify and test* each.

| Attribute | Requirement |
|---|---|
| **Performance** | Interactive screens responsive under realistic load; common reads fast; heavy reports run async with progress. Define and meet p95/p99 latency budgets per critical path. |
| **Scalability** | Horizontal scale for stateless services; partitioned data (§16.2) keeps large-table performance flat with growth; tested to target tenant/volume scale. |
| **Availability** | High-availability targets for core services with documented SLA; no single point of failure in critical paths. |
| **Resilience / DR** | Defined **RTO/RPO**; tested backup, restore, and failover; graceful degradation (incl. AI-optional, §12.6). |
| **Security** | Per §14; passes SAST/DAST, dependency, and penetration testing before release. |
| **Auditability** | 100% of material actions audited and reconcilable (§14.3). |
| **Configurability** | Core configuration changes require no code deployment (§10) - verified by acceptance tests. |
| **Accessibility** | WCAG 2.2 AA verified (§11.6). |
| **Internationalisation** | No hard-coded user-facing strings; locale/currency/RTL correctness verified. |
| **Observability** | Logs, metrics, traces, SLOs for every service (§15.6). |
| **Maintainability** | Clean architecture boundaries (§15.1); documented; test-covered (§21 ph.13); ADRs current. |
| **Operability** | Deploy/observe/scale/back-up/recover via documented automation (§4.7, §9.13). |
| **Data integrity** | No monetary float; constraints enforced in DB; reconcilable financial chains (§16). |
| **Tenant isolation** | No cross-tenant data path; verified by automated tests (§14.5). |
| **Compliance** | Regulatory outputs reproducible and defensible (§18.4). |
---

# PART D - DELIVERY

---

## 21. Delivery methodology & phase gates

Work proceeds through fifteen phases. **No phase is skipped or silently simplified** (§3.1). Each phase below states its **objective**, **deliverables**, and **exit gate** - the conditions that must be true before the next phase begins. Every phase deliverable also carries the standard **Open Questions / Assumptions / Gaps** note (§3.3) and respects the cross-cutting standards in Part C.

> **Sequencing note.** The phases are ordered by dependency, but real delivery iterates: later phases surface gaps that send small, recorded changes back to earlier artifacts. The gate discipline governs *readiness to proceed*, not a prohibition on revisiting. Within phases 10–14, build vertically - deliver a thin but complete slice through a core domain (e.g. treaty placement → accounting → claim) before widening - so integration risk is found early.

### Phase 1 - Business Analysis
**Objective.** Establish a shared, correct understanding of the reinsurance business the platform serves (grounded in §5–§7) and the goals, personas, and jobs it must satisfy.
**Deliverables.** Market/process study summary (study-not-copy, §5); persona and JTBD catalogue (§6); end-to-end process maps for treaty, facultative, retrocession, accounting, claims, and regulatory lifecycles; pain-points and opportunity register; success criteria refined with the Product Owner (§1.4); glossary seeded (§25).
**Exit gate.** Domain Expert and Product Owner sign off that the process maps and personas are correct and complete enough to specify against; major ambiguities are listed as resolved decisions or explicit open questions.

### Phase 2 - Complete Functional Specification
**Objective.** Specify *what* the system does, in full, per module and per lifecycle - unambiguous enough to design and test against.
**Deliverables.** Functional spec per module (§9) covering capabilities, states/transitions, business rules, validations, roles/permissions touched, configurability points (§10), and acceptance criteria; cross-cutting specs for AI (§12), reporting (§13), security behaviours (§14), compliance outputs (§18), i18n (§19); confirmed non-functional targets (§20); traceability matrix (requirement → module → lifecycle).
**Exit gate.** Specs are reviewed by Domain Expert, Architect, Security, Compliance, and QA; acceptance criteria exist for every capability; no core flow has an unspecified step.

### Phase 3 - Module Architecture
**Objective.** Define bounded contexts, module boundaries, ownership, and dependencies (§9, §15.1).
**Deliverables.** Bounded-context map and ubiquitous-language definitions; module dependency graph and integration contracts at the boundary; decisions on where CQRS/event-sourcing apply (§15.1) with rationale; cross-cutting concern placement (auth, audit, search, config); initial ADRs (§15.7).
**Exit gate.** CTO/Architect sign-off that boundaries are coherent, dependencies are acyclic where required, and every module from §9 has a home and an owner.

### Phase 4 - Database Design
**Objective.** Produce the complete production data design (§16).
**Deliverables.** ER diagrams and data dictionary per bounded context; party/role-centric core model (§7 implication); audit/history and soft-delete patterns; indexing and partitioning strategy; multi-tenant isolation model at the data layer; money/FX and effective-dating patterns; migration strategy and tooling.
**Exit gate.** Database Architect, Security (RLS/FLS), and Domain Expert (semantics correct) sign off; the model demonstrably supports the Phase 2 specs and the NFRs in §20.

### Phase 5 - Microservice / Service Design
**Objective.** Design the service topology and platform substrate (§15).
**Deliverables.** Service decomposition aligned to bounded contexts; API Gateway and inter-service communication design (sync contracts, async events, outbox); technology choices per service with ADRs; multi-tenancy, scaling, resilience, and DR design; observability design (§15.6); security architecture (zero-trust, secrets, keys).
**Exit gate.** CTO/Cloud/DevOps/Security sign-off that the topology meets the NFRs, isolation, and operability requirements; ADRs recorded.

### Phase 6 - REST APIs
**Objective.** Define the contracts before implementing them.
**Deliverables.** Versioned API specifications (OpenAPI) for every service and the gateway; resource models, error model, pagination/filtering conventions, idempotency, rate-limit and auth scheme; webhook/event contracts (§17.2); examples and a contract-test suite.
**Exit gate.** Contracts reviewed by consumers (frontend, portals, integrations) and QA; backward-compatibility and versioning policy agreed; contract tests in place.

### Phase 7 - Frontend Design System
**Objective.** Build the tokenised design language and theming engine (§11.2).
**Deliverables.** Design tokens (colour/typography/spacing/radii/elevation/motion); light/dark and tenant theming; RTL foundations; accessibility primitives; documented usage; the visual identity that makes the product read as premium (§11.1).
**Exit gate.** UI/UX Director sign-off; accessibility primitives verified; tokens cover all needs of the wireframes to come.

### Phase 8 - UI Wireframes
**Objective.** Define information architecture and key screens (§11.3–§11.5).
**Deliverables.** Navigation/workspace model, command palette and global search interaction, per-page baseline applied (§11.4); wireframes for the primary flows of each core domain; empty/loading/error/confirmation states; responsive behaviour; saved-views and filter patterns.
**Exit gate.** UX Director and Product Owner sign off that flows match the Phase 2 specs and personas; destructive-action confirmations and undo patterns are present.

### Phase 9 - Component Library
**Objective.** Implement reusable, accessible components on the design system (§11).
**Deliverables.** Production component library (forms, tables/grids with sort/filter/group/virtualise, charts, dialogs, navigation, command palette, skeletons, empty states); the **metadata-driven form/screen renderer** (§10.3); component documentation and a living catalog; accessibility and theming verified per component.
**Exit gate.** Components meet accessibility, theming, and interaction standards; the form renderer can express the Phase 8 screens from metadata.

### Phase 10 - Backend Development
**Objective.** Implement services to contract, vertical slice first (§21 sequencing note).
**Deliverables.** Implemented services per Phase 5/6; domain logic correct per §7; configuration, rules, and workflow engines functioning (§10, §9.3); security enforced (RLS/FLS, RBAC/ABAC, audit) (§14); events and outbox working; reconcilable accounting chain (§7.6). Built test-first where practical with unit/integration coverage.
**Exit gate.** A complete vertical slice (e.g. place → bind → account → claim → recover for a treaty) works end to end with correct numbers, security, and audit; integration tests green.

### Phase 11 - Frontend Development
**Objective.** Build the application UI on the component library, wired to the APIs.
**Deliverables.** Module UIs implementing Phase 8 flows; per-page baseline (§11.4) present; saved views, advanced search, export, filters; dark/light, i18n, RTL, accessibility throughout; optimistic UI with robust error handling; report/dashboard designers (§13).
**Exit gate.** The vertical slice is fully usable through the UI to the standard of §11; accessibility and i18n verified on delivered screens.

### Phase 12 - AI Integration
**Objective.** Deliver the assistant and automation layer (§12) within permissions and guardrails.
**Deliverables.** Chat and voice assistant; intent handling across delivered modules; generation of reports/dashboards/documents/forms as editable artifacts; **confirmation on every destructive/material action** (§12.4); Automation Studio (§12.5); guardrails and evaluation suite (§9.5); graceful degradation when AI is unavailable (§12.6).
**Exit gate.** Assistant operates strictly within user permissions and audit; destructive-action confirmation verified by tests; evaluation suite passes; core platform proven fully usable with AI disabled.

### Phase 13 - Testing
**Objective.** Prove quality across functional and non-functional dimensions.
**Deliverables.** Test strategy and automated suites - unit, integration, contract, end-to-end, regression; performance/load tests against §20 budgets; security testing (SAST/DAST, dependency, penetration); accessibility testing (WCAG 2.2 AA); reconciliation/financial-correctness tests; tenant-isolation tests; AI evaluation; coverage and quality reporting.
**Exit gate.** All suites green at agreed thresholds; NFR targets met; no known critical or high-severity defects in core flows; QA Lead sign-off.

### Phase 14 - Deployment
**Objective.** Make the platform operable in production (§15.5–§15.6, §9.13).
**Deliverables.** IaC for all environments; CI/CD pipelines with quality gates (tests, security scans); blue-green/canary release strategy; observability (logs/metrics/traces, dashboards, alerts, SLOs); backup, DR, and restore drills executed; runbooks and on-call; tenant onboarding/offboarding procedures.
**Exit gate.** A clean deploy to a production-equivalent environment from IaC; restore and failover drills pass; observability and alerting live; DevOps/Cloud/Security sign-off.

### Phase 15 - Documentation
**Objective.** Ship the knowledge that makes the product sellable and supportable.
**Deliverables.** Architecture and data documentation (incl. ADRs); API reference and developer portal content (§17.4); administrator/configuration guide (how to use §10 surfaces); operator/runbook documentation; end-user help and in-app guidance; compliance/audit documentation (§18.4); release notes; security and DR documentation.
**Exit gate.** Technical Writer sign-off; every shipped capability has admin, operator, and user documentation; compliance evidence is assembled and reproducible.

---

## 22. Definition of Ready, Definition of Done & quality bars

### 22.1 Definition of Ready (a work item may start when…)

It traces to a Phase 2 specification and acceptance criteria; its configurability points are identified (§10); its security and audit implications are noted (§14); its data and API contracts exist (§4/§6); its UX states (empty/loading/error/confirmation) are defined; its non-functional expectations are stated (§20); and its open questions are either resolved or explicitly accepted.

### 22.2 Definition of Done (a capability is done when…)

Functionally complete to its acceptance criteria; **metadata-driven** where §10 requires; **secured** (RBAC/ABAC, RLS/FLS, audit) and **auditable** (§14); **reconcilable** if financial (§7.6); **accessible** to WCAG 2.2 AA (§11.6); **internationalised** (§19); **observable** (§15.6); **tested** (unit/integration/e2e + relevant NFR tests, §21 ph.13); **documented** (admin/operator/user, §21 ph.15); destructive actions **confirmed and reversible/recoverable** where applicable (§4.3); no known critical/high defects; reviewed and signed off by the relevant standing roles.

### 22.3 Quality bars (always-on)

- **Correctness over cleverness** (§4.4): numbers reconcile; logic is explainable.
- **No hard-coding** of business values (§10.5).
- **No silent gaps** (§3.3): everything deferred is named.
- **Premium experience** (§11.1): nothing ships looking templated.
- **Security and compliance are not negotiable against schedule** (§0 precedence).
- **Every destructive operation confirms** (§4.3, §12.4).

---

## 23. Output format & response protocol (per phase / per deliverable)

Each deliverable is produced in a consistent, reviewable shape so the work compounds rather than scatters.

**Standard structure for any deliverable:**

1. **Header** - phase, module/domain, version, the standing roles consulted.
2. **Purpose & scope** - what this artifact covers and what it deliberately does not.
3. **Body** - the actual specification/design/implementation, structured for the artifact type (e.g. ER diagrams + data dictionary for Phase 4; OpenAPI + examples for Phase 6).
4. **Traceability** - links back to the Phase 1/2 requirements and the §7 lifecycle(s) served, and forward to dependent artifacts.
5. **Cross-cutting compliance note** - how it satisfies the relevant items of Part C (config, security, audit, accessibility, i18n, NFR).
6. **Acceptance criteria / exit-gate checklist** - explicit, testable.
7. **Open Questions / Assumptions / Gaps** - named, never silent.

**Conventions.** Use diagrams (ER, sequence, context, flow) where they communicate better than prose. Mark anything illustrative vs production-ready explicitly. Keep terminology consistent with the glossary (§25). When proposing an addition beyond this brief, label it as a recommendation with justification (§3.2).

---

## 24. Assumptions, constraints, dependencies & risks

### 24.1 Assumptions

- Budget and ambition support an enterprise-grade build (multi-year roadmap, not a one-shot).
- The team has access to (or can responsibly construct) realistic test data spanning treaty, facultative, retrocession, accounting, and claims.
- Third-party services (cat models, identity providers, banking, market bureaus) are integrated under their own licences; the platform provides the connectors, not the licences.
- Regulatory rule specifics are confirmed per target jurisdiction during Phase 2 and delivered as configuration, not assumed universal.

### 24.2 Constraints

- The non-negotiables in §4 bind all work.
- Configuration-without-code (§10) constrains how features may be implemented.
- Security, compliance, and data-integrity constraints take precedence over delivery speed (§0).

### 24.3 Key dependencies

- Accounting depends on correct Reinsurance-Core semantics (§9.15).
- Regulatory depends on Accounting + Reserving + Core lineage (§18.4).
- Portals and Assistant depend on stable core APIs and the permission model.

### 24.4 Top risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Domain incorrectness (e.g. commission/reinstatement logic wrong) | Wrong money; loss of trust | Domain-Expert sign-off gates; reconciliation tests; correctness-over-cleverness (§4.4) |
| Over-configuration complexity | Slow, fragile, confusing | Governed config with sandbox/versioning (§10.4); sensible defaults; admin UX care |
| Multi-tenancy / isolation flaws | Data leak; deal-breaker for buyers | Isolation designed from Phase 4; automated isolation tests (§14.5) |
| Regulatory drift across jurisdictions | Non-compliant outputs | Config-driven report packs (§18.3); lineage and reproducibility (§18.4) |
| AI overreach (acts without confirmation) | Unauthorised/destructive change | Hard confirmation rule + permission-bound assistant + eval suite (§12.4) |
| Scope sprawl vs phase discipline | Never ships | Vertical-slice delivery; phase gates; explicit out-of-scope (§8.3) |
| Performance collapse at volume | Unusable at scale | Partitioning/indexing (§16.2); load tests to budget (§20) |
| "Looks like a template" | Fails premium positioning | Dedicated design system phase (§21 ph.7); UX sign-off in DoD (§22) |
---

# PART E - REFERENCE

---

## 25. Glossary

*Reinsurance & domain terms (semantics fixed for the build; see §7):*

- **Attachment point (priority / retention):** the loss level at which a non-proportional cover begins to respond.
- **ABAC / RBAC:** attribute-/role-based access control (§14.1).
- **Bordereau (pl. bordereaux):** periodic schedule of premiums or losses exchanged between parties.
- **Burning-cost / experience rating:** pricing from historical loss experience.
- **CAT XL:** catastrophe excess-of-loss cover responding to accumulated losses from a single event.
- **Cedent (ceding company):** the party transferring risk.
- **Ceding / overriding / profit commission:** commissions paid to the cedent/intermediary; profit commission shares favourable results subject to allowable expenses and loss carry-forward.
- **Commutation:** settling outstanding liabilities under a contract for an agreed lump sum, closing it.
- **Coverholder / MGA:** an entity authorised to bind business under delegated authority.
- **CSM (Contractual Service Margin):** unearned profit recognised over time under IFRS 17.
- **EBOT / ECOT:** Electronic Back-Office / Claims-Office Transactions - market messaging standards.
- **EPI (Estimated Premium Income):** projected premium used to set deposit/minimum premiums and adjust later.
- **Facultative:** reinsurance of a single, individually assessed risk.
- **GMM/BBA, PAA, VFA:** IFRS 17 measurement models (general, premium-allocation, variable-fee).
- **IBNR / IBNER:** incurred but not reported / not enough reported reserves.
- **Inuring reinsurance:** reinsurance applied before another cover, reducing what the latter pays.
- **Layer / band:** a tranche of a non-proportional structure defined by attachment and limit.
- **MDP (Minimum & Deposit Premium):** premium paid up front, adjusted to final.
- **PML / MFL:** probable / maximum foreseeable loss.
- **Portfolio transfer (entry/withdrawal):** premium and loss portfolios moved at inception/expiry of proportional treaties.
- **Quota Share / Surplus:** proportional treaty forms (fixed percentage / retention-based lines).
- **RDS:** Realistic Disaster Scenario - prescribed exposure stress scenarios.
- **Reinstatement (premium):** restoring exhausted XL limit after a loss, usually for additional premium (pro-rata as to time/amount).
- **Retrocession / retrocessionaire:** reinsurance of a reinsurer / the party providing it.
- **ROL (Rate on Line):** XL premium expressed as a percentage of the layer limit.
- **Salvage & subrogation:** recoveries from disposal of insured property / pursuit of third parties.
- **SCR / MCR:** Solvency Capital Requirement / Minimum Capital Requirement (Solvency II).
- **Signing down / written vs signed lines:** reduction of over-subscribed lines to fit the order; reconciliation of intended vs final shares.
- **Slip / MRC (Market Reform Contract):** the placing document describing the risk and terms.
- **Statement of account / accounts current:** periodic netting of premiums, commissions, taxes, and claims between parties.
- **Stop-loss / aggregate XL:** cover responding to aggregate losses over a period exceeding a threshold.
- **Technical vs financial accounting:** reinsurance-specific monetary events vs their posting into the GL (§7.6).
- **Treaty:** reinsurance covering a defined class/book rather than a single risk.
- **UPR (Unearned Premium Reserve):** premium relating to unexpired risk periods.

*Technical & delivery terms:*

- **ADR:** Architecture Decision Record (§15.7).
- **CQRS / Event Sourcing:** command-query responsibility segregation / storing state as a sequence of events (§15.1).
- **DDD / Bounded Context:** domain-driven design and its module boundary concept (§15.1).
- **DoR / DoD:** Definition of Ready / Done (§22).
- **FLS / RLS:** field-/row-level security (§14.2).
- **IaC:** Infrastructure as Code (§15.3).
- **NFR:** non-functional requirement (§20).
- **Outbox pattern:** reliable event publication tied to the local transaction (§15.2).
- **RTO / RPO:** recovery time / point objectives (§20).
- **SLO / SLA:** service-level objective / agreement (§15.6, §20).
- **WCAG 2.2 AA:** the accessibility conformance target (§11.6).

---

## 26. Module catalog (full enumeration, grouped)

The complete module set, organised by the domains of §9. Each is metadata-driven (§10), secured and audited (§14), searchable (§11.3), and reportable (§13). Items marked **★** are proactively recommended beyond the original list (§9). Items marked **▷** are designed-for but phased later (§8.2).

**1. Platform & Administration** - System Administration; Configuration Center; Multi-Tenant Management; Multi-Company / Organization Management; Branch / Office Management; Feature & License Management; Localization & Translation; Currency Management; Exchange-Rate Management; Master Data Management; Reference-Data / Code-List Management ★.

**2. Identity, Access & Security** - Identity Management; User Management; Role Management; Permission Engine (RBAC+ABAC); Authentication & SSO (OAuth2/OIDC, SAML, Azure AD, LDAP); MFA; Security Center; Row-/Field-Level Security; Audit & Immutable Logs; Data Retention & Legal Hold ★; Secrets & Key Management ★.

**3. Process & Automation** - Workflow Designer; Workflow Monitor; Business Rules Engine; Approval & Delegation Engine ★; Notification Engine; Email Engine; SMS Engine; Scheduler / Job Orchestration; Event Bus / Outbox ★.

**4. Content & Knowledge** - Document Management; Template Engine ★; OCR & Document Intelligence; Global Search & Indexing ★.

**5. Intelligence & Assistant** - AI Assistant (chat); Voice Assistant; AI Automation Studio; AI Prediction & Insights; AI Generation (reports/dashboards/documents); Assistant Guardrails & Evaluation ★.

**6. Reinsurance Core** - Risk Management; Treaty Management; Facultative Management; Retrocession Management; Underwriting; Pricing & Rating ★; Placement & Slip Management; Contract / Wording Management; Participation & Signing Management ★; Bordereaux Management ★.

**7. Claims & Recoveries** - Claims Management; Loss & Event Management ★; Reserving & Reserve Movements ★; Recoveries Management; Reinstatement Processing ★; Salvage & Subrogation ★.

**8. Accounting & Finance** - Technical Accounting; Premium Processing; Statements of Account / Accounts Current ★; Business / Financial Accounting; General Ledger; Accounts Receivable; Accounts Payable; Cash Management; Bank Reconciliation; Treasury; Investment Management; Fixed Assets; Tax & Levy Management ★.

**9. Risk, Exposure & Analytics** - Exposure & Aggregate Management; Catastrophe Analysis; Realistic Disaster Scenarios ★; Risk & Capital Management ★; BI & Analytics; Executive Dashboard; Data Warehouse / Semantic Layer; Report Designer; Dashboard Designer; Pivot/Cube & Forecast Services ★.

**10. Regulatory & Compliance** - IFRS 17; Solvency II; Regulatory Reporting; Financial Reporting; Compliance Management; Statutory & Market Returns ★.

**11. Relationship & Distribution** - CRM; Broker Portal; Cedent Portal; Retrocessionaire / Partner Portal; Client Portal; Coverholder / Delegated-Authority Portal ★; Mobile Portal.

**12. Integration & Developer** - API Gateway; Integration Hub; Data Import; Data Export; Webhook & Event Subscriptions ★; Connector Framework ★; Developer Portal; API Marketplace ▷.

**13. Operations, Reliability & Observability** - Monitoring & Observability; Performance Analytics; SOC Dashboard; SIEM Integration; Backup Management; Disaster Recovery; Health & SLA Dashboard ★; Cost & Capacity Management ★.

**14. Corporate / Back-office** - Procurement; HRMS; Payroll; Performance Management; Product Lifecycle Management (insurance-product factory); Asset & License inventory.

> This exceeds the original target of "30+ modules," organised so that boundaries, services (§15), and navigation (§11) follow the same map. The starred additions are justified inline in §9; portals, accounting sub-ledgers, and regulatory packs are first-class rather than buried inside other modules.

---

## 27. Final acceptance checklist

A compact restatement of what "world-class and commercially ready" means here. The build is acceptable when **every** item is demonstrably true.

- [ ] Full treaty, facultative, and retrocession lifecycles supported end to end with correct semantics (§7) - no dead ends.
- [ ] Reconcilable chain from technical accounting → sub-ledger → GL → regulatory output (§7.6, §18.4).
- [ ] Claims → reserves → reinstatements → recoveries → event aggregation flow correctly (§7.7).
- [ ] Core configuration (statuses, lists, rules, workflows, forms, templates, reports, dashboards, roles, permissions) changeable **without a deployment** (§10) - verified.
- [ ] Multi-tenant with verified isolation; RBAC+ABAC, RLS/FLS, encryption, immutable audit (§14).
- [ ] Assistant (chat + voice) acts within permissions, grounds answers in data, and **confirms every destructive/material action** (§12.4).
- [ ] Reporting/BI: drag-drop builder, pivot/cube, drill-down/through, scheduling, export to Excel/Word/PPT/PDF/CSV/API (§13).
- [ ] IFRS 17, Solvency II, and configurable statutory/market reporting with reproducible lineage (§18).
- [ ] Premium experience: design system, light/dark, RTL, WCAG 2.2 AA, command palette, global search, saved views, skeletons, empty states, undo (§11).
- [ ] Internationalised and multi-currency throughout (§19) - no hard-coded strings or currency logic.
- [ ] Clean architecture / DDD; documented service topology; CQRS/event-sourcing where justified; ADRs current (§15).
- [ ] NFRs met and tested: performance, scalability, availability, DR (RTO/RPO), security, observability (§20).
- [ ] Operable: IaC, CI/CD with quality gates, observability, tested backup/restore and failover (§21 ph.14).
- [ ] Complete documentation: architecture, data, API/developer, admin/config, operator, end-user, compliance (§21 ph.15).
- [ ] Original work - informed by the market, copying no vendor's UI or proprietary design (§4.6, §5).
- [ ] Every deliverable carried its Open Questions / Assumptions / Gaps note; nothing material was silently omitted (§3.3).

---

## 28. Appendix A - Illustrative core data model & state machines

*Illustrative, not final. The authoritative model is produced in Phase 4 (§21). This sketch fixes the shape so Phase 2/3 reason against something concrete. It is deliberately party/role-centric (§7 design implication) and avoids vendor-specific structures.*

### 28.1 Core entities (conceptual)

- **Party** - any legal entity (carrier, broker, coverholder, bank, vendor). Holds identity, contacts, financial setup, regulatory identifiers. A Party is not "customer" or "supplier"; its capacity is expressed through **Party Role**.
- **Party Role** - the capacity a Party holds in a context: *cedent, reinsurer, retrocessionaire, broker, coverholder, claimant payee*. The same Party may hold several roles, even on the same contract.
- **Programme** - a structured set of covers protecting a book or layer band for a period; groups related contracts.
- **Contract** - the cover instrument: *treaty, facultative certificate, or retrocession contract*. Carries type (proportional/non-proportional), period, currency, wording reference, market references, and terms.
- **Layer / Section** - a tranche of a non-proportional contract (attachment, limit, ROL, reinstatements, AAD).
- **Participation (Signed Line)** - a reinsurer's share of a contract/layer, with written vs signed line and order context (§7.3 step 4).
- **Term Set** - configurable commercial terms attached to a contract/layer: commissions (ceding/overriding/profit/sliding-scale), brokerage, taxes/levies, deposit/MDP, EPI, instalment schedule, reinstatement basis, indexation, hours clause, occurrence definition.
- **Risk** - the underlying exposure for facultative and exposure aggregation.
- **Bordereau** - an ingested premium or loss schedule, mapped and validated, linked to a Contract/Programme.
- **Financial Event** - an immutable technical-accounting event (premium, commission, tax, cash loss, paid loss, reserve movement, reinstatement premium, portfolio transfer, deposit/interest). Source of the reconcilable chain (§7.6).
- **Statement of Account** - a periodic netting document over Financial Events between parties, in original and settlement currency.
- **Ledger Posting** - the GL posting derived from one or more Financial Events (§7.6).
- **Loss / Claim** - a notified loss, with **Event** aggregation, **Reserve Movements**, payments, reinstatements, and **Recoveries**.
- **Event (CAT)** - a coded catastrophe/occurrence aggregating losses across contracts and programmes.

### 28.2 Key relationships (conceptual cardinalities)

- Party (1) - (N) Party Role; Party Role (N) - (1) Contract context.
- Programme (1) - (N) Contract; Contract (1) - (N) Layer; Layer (1) - (N) Participation.
- Contract (1) - (1) Term Set *(versioned/effective-dated)*.
- Contract (1) - (N) Financial Event; Financial Event (N) - (1) Statement of Account; Financial Event (N) - (N) Ledger Posting *(via posting rules)*.
- Loss (N) - (1) Event; Loss (1) - (N) Reserve Movement; Loss (1) - (N) Recovery.
- Every entity → (N) Audit Records *(who/what/when/before/after)*; soft-delete + history on all (§16.2).

### 28.3 Treaty contract - illustrative state machine

`Draft → Quoted → Placing → Bound → Active → (Endorsed*) → Expiring → Run-off → {Renewed | Lapsed | Commuted | Closed}`

- **Cancelled** is reachable from Draft/Quoted/Placing/Bound with reason capture.
- **Endorsed** is a self-loop producing a versioned amendment, not a new contract.
- State transitions are configurable (§10): which roles may trigger them, what approvals apply, what validations must pass, and what Financial Events/notifications they raise.

### 28.4 Claim - illustrative state machine

`Notified → Under Review → Reserved → (Cash Call?) → Part-Paid → Settled → {Recovering → Recovered} → Closed`

- **Reopened** is reachable from Closed with reason and audit.
- **Declined / Withdrawn** terminal states with reason.
- Each transition may raise reserve movements, reinstatement-premium calculations, recovery tasks, and ledger postings per configured rules.

### 28.5 Statement of account - illustrative state machine

`Open → Prepared → Under Review → Approved → Issued → Settled → Closed` *(with Disputed and Re-issued branches; four-eyes configurable).*

---

## 29. Appendix B - Core reinsurance module functional notes

*Capability-level notes for the six Reinsurance-Core modules (§9.6), to anchor Phase 2. Each respects the cross-cutting standards of Part C.*

### 29.1 Treaty Management
**Purpose.** Manage the full treaty lifecycle (§7.3) for proportional and non-proportional business.
**Key capabilities.** Structure programmes, contracts, layers, and term sets; capture written/signed lines and order; manage EPI, deposit/MDP, instalments, and adjustment schedules; trigger statements and reinstatements; handle endorsements, renewals, run-off, and commutation.
**Key rules (configurable).** Commission calculations (ceding/overriding/profit with allowable-expense and loss-carry-forward; sliding scale); loss participation/corridor; portfolio entry/withdrawal; occurrence/hours definitions; indexation.
**Acceptance criteria (samples).** Binding a treaty produces correct deposit-premium Financial Events and a Term Set version; a profit-commission run reconciles to its underlying premiums, commissions, and losses; renewal carries forward structure and history without data loss.

### 29.2 Facultative Management
**Purpose.** Fast single-risk cession/acceptance (§7.4), proportional or XL, including fac-obligatory.
**Key capabilities.** Risk capture and assessment; quote; cession/acceptance; certificate issuance; auto-generated premium and accounting; claims linkage at risk grain.
**Acceptance criteria (samples).** A single-risk cession completes on one screen and auto-creates the correct Financial Events; the risk feeds exposure aggregation (§9.9).

### 29.3 Retrocession Management
**Purpose.** Protect assumed books via retrocession (§7.5); compute gross/ceded/net.
**Key capabilities.** Outwards structures (proportional, XL, whole-account/stop-loss, ILW where modelled); inuring order; net-position computation across inwards and outwards.
**Acceptance criteria (samples).** Net retained exposure and recoveries are correct after inuring covers are applied in the configured order; the same Party appears correctly as reinsurer (inwards) and cedent (outwards).

### 29.4 Placement & Slip Management
**Purpose.** Market risk and capture market response (§7.3 steps 3–5).
**Key capabilities.** Slip/MRC authoring (template-driven, §10); marketing to (re)insurers; capture written lines; order and **signing down**; reconcile written vs signed; convert to bound contract with references.
**Acceptance criteria (samples).** An over-subscribed placement signs down to the order with correct final shares; signed lines flow into Participations without re-keying.

### 29.5 Pricing & Rating ★
**Purpose.** Support pricing and authority (§7.8).
**Key capabilities.** Burning-cost/experience rating, exposure rating, and pricing models; capacity and authority checks; what-if structuring with exposure impact.
**Acceptance criteria (samples).** A pricing run is reproducible from its inputs and version; authority breaches block binding with a clear message and route to approval.

### 29.6 Bordereaux Management ★
**Purpose.** Ingest and govern premium and loss bordereaux (§7.10).
**Key capabilities.** Mapped, validated ingestion (Excel/CSV/feeds); exception handling and reprocessing; linkage to contracts/programmes; conversion to Financial Events and Losses.
**Acceptance criteria (samples).** A malformed bordereau is rejected with line-level errors; a valid one produces reconciling Financial Events and feeds claims/exposure.

---

## 30. Appendix C - Persona dashboards & illustrative KPIs

*Default, governed dashboards (§13.5) per persona (§6.2). All drill-down/through; all permission- and tenant-scoped; all configurable.*

| Persona | Default dashboard focus | Illustrative KPIs |
|---|---|---|
| **Treaty Underwriter** | Renewal pipeline & exposure impact | Renewal status by programme; written vs signed; EPI vs booked; loss ratio trend; aggregate utilisation |
| **Facultative UW** | Cession throughput | Cessions by status/LOB; turnaround time; acceptance rate; capacity used |
| **Technical Accountant** | Statements & reconciliation | Statements by state; unreconciled items; overdue settlements; FX exposure; commission accruals |
| **Claims Handler** | Open losses & reserves | Open/overdue claims; reserve movements; cash calls due; reinstatements triggered; recoveries outstanding |
| **Cat / Exposure Manager** | Aggregates & events | Zonal aggregates vs limits; PML/MFL; live event footprints; RDS results |
| **Finance / Controller** | Close & ledgers | Sub-ledger-to-GL reconciliation; AR/AP ageing; cash position; period-close progress |
| **Compliance / Regulatory** | Filing readiness | IFRS 17 CSM roll-forward status; Solvency II SCR/MCR coverage; QRT/return readiness; lineage exceptions |
| **Executive** | Business at a glance | GWP/NWP, combined/loss ratios, net result; capital position; top exposures; renewal retention |

> Dashboards are defaults, not cages: every persona dashboard is a starting governed configuration the tenant and user can extend (§13.5), and every KPI traces to certified data (§13.6).

---

### Closing instruction to the delivery organization

Proceed phase by phase from §21. Begin with **Phase 1 - Business Analysis**, producing the deliverables and meeting the exit gate before requesting to advance. Throughout, hold the standard of §1.2, honour the non-negotiables of §4, challenge anything in this brief that is wrong or missing (§3.2), and never trade away correctness, security, compliance, or auditability for speed.

*End of brief.*
