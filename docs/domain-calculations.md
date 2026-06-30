# RIOS — Domain Calculations Reference

**Phase:** 10 (Backend Development — domain core) · **Domain:** Reinsurance Core / Accounting · **Version:** 1.0
**Roles consulted:** Reinsurance Domain Expert, Enterprise Solution Architect, QA Lead, Technical Writer
**Status:** Delivered (38 passing unit tests)

## Purpose & scope

This document is the authoritative reference for the pure reinsurance mathematics implemented in
`packages/domain` (`@rios/domain`). It records, for every exported function, the formula, its inputs
and outputs, a **worked numeric example that uses the exact numbers from the unit tests** (so each
example is independently verifiable by running `npm test`), and the §7 lifecycle term it implements.

The domain library is deliberately **pure** — no I/O, no framework, no clock, no database (brief §4.4).
Financial correctness is therefore provable in isolation. The server (`server/src/modules/*`) calls
these functions; it never re-implements the maths.

Out of scope: persistence, GL chart-of-accounts mapping, FX rate sourcing, and the IFRS 17 / Solvency II
measurement engines (see [open-questions.md](./open-questions.md)).

Source files:

| File | Concern | Brief §7 area |
|---|---|---|
| `packages/domain/src/money.ts` | Integer-minor-unit money, rounding, penny-perfect allocation | §16.1, §20 (data integrity) |
| `packages/domain/src/proportional.ts` | Quota share, surplus, commissions, profit commission, sliding scale | §7.2 (proportional) |
| `packages/domain/src/nonproportional.ts` | XL layer recovery, programme tower, aggregate erosion, ROL, MDP, reinstatements | §7.2 (non-proportional) |
| `packages/domain/src/accounting.ts` | Financial events, statement netting, double-entry postings, reconciliation | §7.6 |

---

## 1. Money (`money.ts`)

> **Non-negotiable (brief §16.1, §20):** money is *never* a floating-point value. A `Money` is a signed
> **integer count of minor units** (e.g. cents) plus an upper-cased ISO-4217 currency code. All arithmetic
> is integer arithmetic; rates and percentages pass through one explicitly-rounded helper.

```ts
interface Money { readonly amount: number; readonly currency: string; }
```

### Minor units

`minorUnitsFor(currency)` returns the ISO default number of minor units: 2 for most (USD, EUR, GBP…),
**0 for JPY/KRW/CLP**, **3 for BHD/KWD/TND**. Unknown currencies default to 2. In the running platform
these are configuration (§10); the table here is a sane built-in default.

### Construction & conversion

- `money(amount, currency)` — throws `MoneyError` if `amount` is not an integer.
- `fromMajor(major, currency, rounding='half-up')` — build from a decimal major amount.
- `toMajor(m)` — back to a decimal (display/test only).

**Worked example** (`money.test.ts`):
`fromMajor(1234.56, 'USD').amount === 123456`; `fromMajor(1234.56, 'JPY').amount === 1235` (0 minor
units, rounded); `fromMajor(1.234, 'BHD').amount === 1234` (3 minor units).

### Arithmetic

`add`, `subtract`, `negate`, `sum`, `compare`, `max`, `min`, `clamp`. All assert matching currency —
**cross-currency arithmetic throws** (`Currency mismatch…`). Cross-currency must first pass through FX.

### Rounding (`Rounding`)

`'half-up' | 'half-even' | 'down' | 'up'`. Applied at one place only (`multiply`/`percentOf`/`fromMajor`),
so every monetary result is reproducible.

**Worked example:** `multiply(money(12345,'USD'), 0.5)` → `half-up` = **6173**, `down` = **6172**,
`half-even` = **6172** (6172.5 rounds to the even 6172).

### Rate & percentage application

- `multiply(m, factor, rounding)` — e.g. a share `0.30` or rate `0.025`.
- `percentOf(m, percent, rounding)` — `percent` is a whole-number percentage (`2.5` = 2.5%).

**Worked example:** `percentOf(money(10000,'USD'), 2.5).amount === 250` (100.00 × 2.5% = 2.50).

### Penny-perfect allocation — `allocate(m, weights)`

Splits an amount across integer weights so **the parts always sum back to the original exactly** — the
classic penny-allocation problem, essential for reconciliation (§7.6). It floor-divides, then distributes
the leftover one minor unit at a time to the largest weights (sign-aware for negative amounts).

**Worked example** (`money.test.ts`):
`allocate(money(1000,'USD'), [1,1,1])` → `[334, 333, 333]`, which sums to **1000**.
`allocate(money(100001,'USD'), [30,50,20])` sums to **100001**. `allocate(money(-1000,'USD'), [1,1,1])`
sums to **-1000**.

---

## 2. Proportional treaties (`proportional.ts`) — brief §7.2, §7.3

### 2.1 Quota share cession — `quotaShareCession(grossPremium, { cededShare })`

A fixed fraction of every risk is ceded. `cededShare ∈ [0,1]` (out-of-range throws).

```
cededPremium    = grossPremium × cededShare
retainedPremium = grossPremium − cededPremium
```

**Worked example:** gross **1,000,000 USD**, `cededShare 0.30` → ceded **300,000**, retained **700,000**.

### 2.2 Surplus cession — `surplusCession(sumInsured, grossPremium, { retentionLine, numberOfLines })`

Retention ("line") is fixed; the surplus above it is ceded, capped by capacity = `retentionLine ×
numberOfLines`. The ceded share is expressed as a fraction of the sum insured.

```
capacity   = retentionLine × numberOfLines
surplus    = max(0, sumInsured − retentionLine)
ceded      = min(surplus, capacity)
cededShare = ceded / sumInsured
cededPremium = grossPremium × cededShare
```

**Worked examples:**
- Retention 1m, 9 lines (=9m capacity), risk **6m** → surplus 5m ceded → `cededShare = 5/6`,
  ceded premium **50,000** (of 60,000).
- Risk **20m**, same treaty → ceded capped at 9m → `cededShare = 9/20`.

### 2.3 Commission stack — `commissions(cededPremium, terms)`

Computed **on the ceded premium**. `cedingCommissionPct` (required), `overridingCommissionPct`,
`brokeragePct` (optional, default 0).

```
ceding      = cededPremium × cedingCommissionPct%
overriding  = cededPremium × overridingCommissionPct%
brokerage   = cededPremium × brokeragePct%
total       = ceding + overriding + brokerage
```

**Worked example:** ceded **300,000**, `{ ceding 25, overriding 2.5, brokerage 1 }` → ceding **75,000**,
overriding **7,500**, brokerage **3,000**, total **85,500**.

### 2.4 Profit commission with loss carry-forward — `profitCommission(input, terms)`

Implements the classic reinsurer-account basis (§7.2): the reinsurer shares favourable results with the
cedent **after** allowable expenses and after absorbing any prior-year deficit.

```
profit = cededPremium
       − commissionPaid            (ceding + overriding already paid)
       − allowableExpenses          (= cededPremium × allowableExpensesPct%, the reinsurer margin)
       − incurredLosses             (paid + outstanding)
       − lossBroughtForward         (prior-period deficit, default 0)

if profit > 0:  profitCommission = profit × ratePct% ;  lossCarriedForward = 0
else:           profitCommission = 0                 ;  lossCarriedForward = −profit  (positive deficit)
```

The result carries a full `workings` object for explainability (§4.4).

**Worked examples** (`proportional.test.ts`):
1. Ceded 1,000,000; commission 250,000; expenses 5% = 50,000; losses 400,000 →
   profit = **300,000**; PC @20% = **60,000**; carry-forward 0.
2. Same but losses 800,000 → profit = **−100,000** → PC **0**, carry-forward **100,000**.
3. Same as (1) but 250,000 brought forward → profit = 300,000 − 250,000 = **50,000** → PC @20% = **10,000**.

### 2.5 Sliding-scale commission — `slidingScaleCommissionPct(lossRatio, terms)`

Returns the commission % for an actual loss ratio by **linear interpolation** between band points,
clamped to `[minPct, maxPct]`. Commission is highest at low loss ratios. Below the first band point it
returns the first band's %, above the last it returns the last band's %.

```
bands sorted ascending by lossRatioFrom
between adjacent points (lo, hi):
  t   = (lossRatio − lo.from) / (hi.from − lo.from)
  pct = lo.pct + t × (hi.pct − lo.pct)
clamp to [minPct, maxPct]
```

**Worked example** with bands `0.40→35%`, `0.60→25%`, `0.80→15%`, min 15, max 35:
- LR 0.30 → **35** (max, below first point)
- LR 0.50 → **30** (halfway between 35% and 25%)
- LR 0.95 → **15** (min, above last point)

### 2.6 Account balance — `proportionalAccountBalance({ cededPremium, totalCommission, cededLosses })`

```
balance = cededPremium − totalCommission − cededLosses
```
A positive balance is owed by the cedent to the reinsurer.

**Worked example:** 300,000 − 85,500 − 120,000 = **94,500**.

---

## 3. Non-proportional / excess of loss (`nonproportional.ts`) — brief §7.2

A `Layer` is `{ attachment, limit, aggregateDeductible?, reinstatements, reinstatementRates? }`.
Total layer capacity = `limit × (reinstatements + 1)`.

### 3.1 Single-loss layer recovery — `layerRecovery(grossLoss, layer)`

```
recovery = min( max(0, grossLoss − attachment), limit )
```

**Worked example** ($5m xs $5m): loss 3m → **0**; loss 8m → **3m**; loss 12m → capped at **5m**.

### 3.2 Programme / tower recovery — `programmeRecovery(grossLoss, layers[])`

Sorts layers by attachment ascending; each pays its excess slice up to its own limit. Returns
`totalRecovery`, `retainedByCedent` (= grossLoss − totalRecovery), and a per-layer breakdown.

**Worked example:** tower `5 xs 5` + `10 xs 10`, loss **18m** → layer 1 pays **5m** (full), layer 2 pays
**8m**, total **13m**, cedent retains **5m** (the initial retention).

### 3.3 Aggregate erosion over a period — `applyLossesToLayer(grossLosses[], layer)`

Applies a sequence of losses, honouring (a) the **annual aggregate deductible (AAD)** — eroded first,
across losses — and (b) the **finite reinstatement capacity**. Recoveries stop once total capacity is
exhausted. Returns per-loss applications with cumulative usage, `totalRecovered`, `capacityRemaining`,
`aadEroded`.

```
totalCapacity = limit × (reinstatements + 1)   (or unbounded if reinstatements = Infinity)
for each loss:
  perLoss = layerRecovery(loss)
  absorb perLoss against remaining AAD first
  recovery = clamp(perLoss, 0, remaining capacity)
```

**Worked examples** (`nonproportional.test.ts`):
- $5m xs $5m, 1 reinstatement (capacity 10m), three 9m losses (each 4m recoverable) →
  recoveries **[4m, 4m, 2m]**, total **10m**, capacity remaining **0**.
- $5m xs $5m, 1 reinstatement, AAD 1m, losses 6m then 7m → loss 1 excess 1m fully absorbed by AAD
  (**recovery 0**), loss 2 excess 2m (**recovery 2m**), `aadEroded` **1m**.

### 3.4 Rate on line — `premiumFromRateOnLine(limit, rol)` / `rateOnLine(premium, limit)`

```
layerPremium = limit × rateOnLine
rateOnLine   = layerPremium / limit
```
**Worked example:** limit 5m, ROL 0.10 → premium **500,000**; back-computed ROL ≈ **0.10**.

### 3.5 Minimum & deposit premium — `minimumAndDepositPremium(terms)`

```
depositPremium = estimatedPremium × depositPct%
minimumPremium = estimatedPremium × minimumPct%
```
**Worked example:** EPI 500,000, deposit 80%, minimum 90% → deposit **400,000**, minimum **450,000**.

### 3.6 Reinstatement premium (pro-rata as to time **and** amount) — `reinstatementPremium(input)`

Restores exhausted limit after a loss, for additional premium (§7.2). Per recovery, in date order:

```
RP = annualPremium × (amountReinstated / limit) × rate × timeFraction
```

- **Amount basis:** `amountReinstated / limit` is the fraction of limit reinstated.
- **Time basis:** `timeFraction ∈ [0,1]` is the unexpired portion of the period at the loss date
  (default 1 = disabled).
- **Rate:** taken in order from `layer.reinstatementRates` (last rate repeats; `0` = free reinstatement;
  empty list defaults to rate 1.0).
- Capacity beyond the available reinstatements is **not** reinstated and incurs **no** premium.

**Worked examples** ($5m xs $5m, annual premium 500,000, 1 reinstatement):
- 4m recovery @ rate 1.0 → reinstates 4/5 = 80% → RP = 500,000 × 0.8 = **400,000**.
- Full-limit (5m) loss @ rate 1.0, `timeFraction 0.5` → RP = 500,000 × 1.0 × 0.5 = **250,000**.
- Two full-limit losses, 1 reinstatement → only the first reinstates → RP **500,000**, one charge.
- Rate `0` (free) → RP **0**.

---

## 4. Accounting & reconciliation (`accounting.ts`) — brief §7.6

### 4.1 Financial events

A `FinancialEvent` is the immutable technical-accounting fact:
`{ id, contractId, type, amount (positive Money), direction: 'DR'|'CR', bookedAt }`.

`FinancialEventType` is a closed vocabulary (stored as reference data in the platform, §10):
`DEPOSIT_PREMIUM`, `INSTALMENT_PREMIUM`, `ADJUSTMENT_PREMIUM`, `REINSTATEMENT_PREMIUM`,
`MINIMUM_PREMIUM`, `CEDING_COMMISSION`, `OVERRIDING_COMMISSION`, `PROFIT_COMMISSION`, `BROKERAGE`,
`TAX`, `LEVY`, `PAID_LOSS`, `CASH_LOSS`, `OUTSTANDING_RESERVE_MOVEMENT`, `RECOVERY`,
`PORTFOLIO_PREMIUM_TRANSFER`, `PORTFOLIO_LOSS_TRANSFER`, `DEPOSIT_WITHHELD`, `DEPOSIT_INTEREST`.

`signedAmount(event)` signs from the **cedent's perspective**: `DR` is positive (cedent owes reinsurer,
e.g. premium), `CR` is negative (reinsurer pays the cedent, e.g. commission, paid loss, recovery).

### 4.2 Statement of account — `buildStatement(events[], currency)`

Nets events into a statement grouped by type. **All events must share the statement currency** —
mixed-currency netting throws (`…convert via FX before netting`). Returns lines (type, count, signed
total), the net `balance`, and `eventCount`.

**Worked example** (`accounting.test.ts`): DEPOSIT_PREMIUM 300,000 (DR), CEDING_COMMISSION 75,000 (CR),
PAID_LOSS 120,000 (CR) → balance = 300,000 − 75,000 − 120,000 = **105,000** owed by the cedent.

### 4.3 Double-entry postings — `assertBalanced(posting)`

A `LedgerPosting` has `sourceEventIds` (lineage, §18.4) and `legs` (`{ account, debit, credit }`).
`assertBalanced` throws `UnbalancedPostingError` unless **total debits == total credits**.

### 4.4 The reconciliation contract — `reconcile(statement, postings[], controlAccount)`

This is the heart of the technical→financial chain (§7.6, §27). Each financial event posts a balanced
entry with one leg hitting a counterparty **control account**. The net movement on that control account
across all postings **must equal the statement balance**.

```
controlMovement = Σ over postings, over legs where account == controlAccount of (debit − credit)
difference      = statementBalance − controlMovement
reconciled      = (difference == 0)
```

**Worked example:** the 105,000 statement above, posted as three balanced entries each touching
`REINSURER_CONTROL`, reconciles: `controlAccountMovement` = **105,000**, `difference` = **0**,
`reconciled` = **true**. A deliberately wrong posting (250,000 instead of 300,000) yields
`reconciled = false`, `difference = 50,000` — the chain refuses to lie.

This same contract is exercised end-to-end by the server vertical-slice integration test
(`/api/treaties/:id/post` returns `reconciled: true`, `controlMovementMinor == statementBalanceMinor`).

---

## Traceability

- **Brief §7.2** (proportional/non-proportional terms) → §2, §3 here.
- **Brief §7.3 / §7.6** (lifecycle, technical vs financial accounting) → §4 here and the bind→statement→post→reconcile chain.
- **Brief §16.1, §20** (money correctness, no float) → §1 here.
- **Brief §4.4** (correct before clever, explainable) → `workings` objects, pure functions, 38 unit tests.
- Forward: the server treaties/accounting modules ([api-reference.md](./api-reference.md)) consume these functions.

## Cross-cutting compliance note

Pure, deterministic, fully unit-tested (`npm test` → 38 passing). No hard-coded business values beyond
ISO defaults that are configuration in the platform (§10.5). Every monetary result is integer-exact and
reconcilable (§16, §20).

## Open Questions / Assumptions / Gaps

- **FX is out of band.** Cross-currency operations are deliberately rejected; an FX/revaluation service
  (rate sourcing, settlement currency, period-end revaluation) is designed-for, not implemented here.
- **Profit-commission variants.** One common basis is implemented; jurisdictional/contractual variants
  (e.g. expense treatment, multi-year carry-forward schemes) would be configuration (§3.5, §10).
- **Sliding scale** uses linear interpolation; stepped (non-interpolated) scales would be a config flag.
- **Indexation/stability clauses, hours clauses, occurrence definitions, swing/burning-cost rating,
  exposure rating** (§7.2, §7.8) are not yet in the domain library — see [open-questions.md](./open-questions.md).
- Reinstatement rate selection uses a simple cumulative-fraction index; complex tiered reinstatement
  schedules may need richer modelling.
