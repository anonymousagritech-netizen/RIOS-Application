# RIOS - Glossary

**Version:** 1.0 · **Status:** Reference · Self-contained (derived from brief §25, kept consistent with the code)

This glossary fixes the semantics used across the codebase and docs. Reinsurance terms first, then
technical/delivery terms. Where the platform implements a term, the implementing location is noted.

## Reinsurance & domain terms

- **AAD (Annual Aggregate Deductible):** an aggregate retention eroded across all qualifying losses in a
  period before a layer responds. *Implemented:* `applyLossesToLayer` (`nonproportional.ts`).
- **Attachment point (priority / retention):** the loss level at which a non-proportional cover begins to
  respond. *Implemented:* `Layer.attachment`.
- **Bordereau (pl. bordereaux):** a periodic schedule of premiums or losses exchanged between parties.
  *Designed-for* (not yet ingested).
- **Burning-cost / experience rating:** pricing from historical loss experience. *Designed-for.*
- **CAT XL:** catastrophe excess-of-loss cover responding to accumulated losses from a single event.
  *Modelled as* `contract.np_type = 'CAT_XL'`.
- **Cedent (ceding company):** the party transferring (ceding) risk.
- **Ceding / overriding / profit commission:** commissions paid to the cedent/intermediary; profit
  commission shares favourable results subject to allowable expenses and loss carry-forward.
  *Implemented:* `commissions`, `profitCommission` (`proportional.ts`).
- **Commutation:** settling outstanding liabilities under a contract for an agreed lump sum, closing it.
  *Designed-for* (a contract terminal state).
- **Coverholder / MGA:** an entity authorised to bind business under delegated authority. *Modelled as*
  a party role.
- **CSM (Contractual Service Margin):** unearned profit recognised over time under IFRS 17. *Designed-for.*
- **Direction (DR/CR):** debit/credit of a financial event from the **cedent's perspective** (premium = DR,
  commission/paid-loss/recovery = CR). *Implemented:* `accounting.ts`.
- **EBOT / ECOT:** Electronic Back-Office / Claims-Office Transactions - market messaging standards.
  *Designed-for.*
- **EPI (Estimated Premium Income):** projected premium used to set deposit/minimum premiums.
  *Implemented:* `minimumAndDepositPremium`.
- **Facultative:** reinsurance of a single, individually assessed risk. *Modelled as* `contract_kind = 'FAC'`.
- **Financial event:** an immutable technical-accounting fact (premium, commission, tax, paid loss,
  reserve movement, reinstatement premium, portfolio transfer, deposit/interest) - the source of the
  reconcilable chain. *Implemented:* `accounting.ts`, `financial_event` table.
- **GMM/BBA, PAA, VFA:** IFRS 17 measurement models. *Designed-for.*
- **IBNR / IBNER:** incurred but not reported / not enough reported reserves. *Designed-for at portfolio grain.*
- **Inuring reinsurance:** reinsurance applied before another cover, reducing what the latter pays.
  *Designed-for.*
- **Layer / band / section:** a tranche of a non-proportional structure defined by attachment and limit.
  *Implemented:* `contract_layer` table, `Layer` type.
- **MDP (Minimum & Deposit Premium):** premium paid up front, adjusted to final. *Implemented:*
  `minimumAndDepositPremium`.
- **Participation (signed line):** a (re)insurer's share of a contract/layer, with written vs signed line
  and order context. *Implemented:* `participation` table.
- **PML / MFL:** probable / maximum foreseeable loss. *Designed-for (exposure management).*
- **Portfolio transfer (entry/withdrawal):** premium and loss portfolios moved at inception/expiry of
  proportional treaties. *Modelled as* financial-event types `PORTFOLIO_PREMIUM_TRANSFER` /
  `PORTFOLIO_LOSS_TRANSFER`.
- **Programme:** a structured set of covers protecting a book or layer band for a period. *Implemented:*
  `programme` table.
- **Quota Share / Surplus:** proportional treaty forms (fixed percentage / retention-based lines).
  *Implemented:* `quotaShareCession`, `surplusCession`.
- **RDS:** Realistic Disaster Scenario - prescribed exposure stress scenarios. *Designed-for.*
- **Reinstatement (premium):** restoring exhausted XL limit after a loss, usually for additional premium
  (pro-rata as to time/amount). *Implemented:* `reinstatementPremium`.
- **Retrocession / retrocessionaire:** reinsurance of a reinsurer / the party providing it. *Modelled as*
  `contract.direction = 'OUTWARDS'` + party roles.
- **ROL (Rate on Line):** XL premium as a percentage of the layer limit. *Implemented:* `rateOnLine`.
- **Salvage & subrogation:** recoveries from disposal of insured property / pursuit of third parties.
  *Designed-for.*
- **SCR / MCR:** Solvency Capital Requirement / Minimum Capital Requirement (Solvency II). *Designed-for.*
- **Signing down / written vs signed lines:** reduction of over-subscribed lines to fit the order.
  *Modelled in* the `participation` table (`written_line`, `signed_line`, `order_pct`).
- **Slip / MRC (Market Reform Contract):** the placing document describing the risk and terms.
  *Designed-for.*
- **Statement of account / accounts current:** periodic netting of premiums, commissions, taxes, and
  claims between parties. *Implemented:* `buildStatement`, `statement_of_account` table.
- **Stop-loss / aggregate XL:** cover responding to aggregate losses over a period exceeding a threshold.
  *Partially modelled* via AAD/aggregate erosion.
- **Technical vs financial accounting:** reinsurance-specific monetary events vs their posting into the GL.
  *Implemented:* the financial-event → statement → ledger-posting → reconcile chain.
- **Term Set:** the configurable commercial terms attached to a contract/layer (commissions, brokerage,
  taxes, deposit/MDP, EPI, reinstatement basis…). *Implemented:* `term_set` table (effective-dated).
- **Treaty:** reinsurance covering a defined class/book rather than a single risk. *Modelled as*
  `contract_kind = 'TREATY'`.
- **UPR (Unearned Premium Reserve):** premium relating to unexpired risk periods. *Designed-for.*

## Technical & delivery terms

- **ABAC / RBAC:** attribute-/role-based access control. RBAC is implemented (role→permission); ABAC
  (attribute policies) is designed-for. See [security.md](./security.md).
- **ADR:** Architecture Decision Record. See [adr/](./adr/).
- **CQRS / Event Sourcing:** command-query responsibility segregation / storing state as a sequence of
  events. Applied selectively (financial events are an append-only event log); full CQRS is designed-for.
- **DDD / Bounded Context:** domain-driven design and its module-boundary concept. See
  [architecture.md](./architecture.md).
- **DoR / DoD:** Definition of Ready / Done (brief §22).
- **FLS / RLS:** field-/row-level security. RLS is implemented (Postgres policies); FLS/column masking is
  designed-for.
- **IaC:** Infrastructure as Code. Designed-for (not yet present).
- **Minor units:** the integer representation of money (e.g. cents). The platform never uses floats for
  money. See [domain-calculations.md](./domain-calculations.md) §1.
- **NFR:** non-functional requirement (brief §20).
- **Outbox pattern:** reliable event publication tied to the local transaction. `outbox` table exists; the
  relay/dispatcher is designed-for.
- **RTO / RPO:** recovery time / point objectives. Designed-for.
- **`runAs`:** the server helper that opens a transaction and sets `app.tenant_id` / `app.user_id` as
  `LOCAL` session variables so Postgres RLS enforces tenant isolation for that request. See
  [security.md](./security.md).
- **SLO / SLA:** service-level objective / agreement. Designed-for.
- **WCAG 2.2 AA:** the accessibility conformance target. Designed-for / in progress on the web tier.
