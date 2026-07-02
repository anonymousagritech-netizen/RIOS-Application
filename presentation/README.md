# RIOS Module Comparison Workbook

`RIOS-module-comparison.xlsx` benchmarks every RIOS module against the reinsurance /
insurance software the market actually uses. It is a leadership deliverable, built to
be honest: every RIOS claim is grounded in the repository, and every competitor claim
is drawn only from public, market-standard footprints.

## Sheets

1. **Module Comparison** (62 module rows) — one row per RIOS module, enumerated from
   `web/src/app/nav.ts`. Columns: Module · Category · How it works in RIOS (core) ·
   Status in RIOS (Delivered / Partial / Designed-for, colour-coded) · What makes
   RIOS's version strong · Comparable RI software · Same module exists in those? ·
   How the comparators do it (core) · Notes / gaps.
2. **Engines** (8 rows) — the reusable platform engines (Dynamic Form, Workflow,
   Formula, Validation, Document, Notification, Dashboard, AI Recommendation): what
   each does in RIOS, its status, where the code lives, and the comparator equivalent.
3. **Scorecard** (13 rows) — RIOS vs the comparator footprint across dimensions
   (Multi-tenancy, Money integrity, Audit, Reinsurance math, Accounting/GL,
   IFRS 17/Solvency II, Regulatory packs, Documents, AI, Adaptive forms, Cat modelling,
   ACORD/bureau, Investment sub-ledger), each with an honest status and a one-line
   grounded justification.
4. **Legend & Honesty Note** — defines the status terms and states the honesty basis in
   full.

## Honesty basis

- **RIOS column** — grounded in the repo, not memory: modules from
  `web/src/app/nav.ts`; mechanics from `server/src/modules/*` and
  `packages/domain/src/*`; status cross-checked against `docs/phases.md`,
  `docs/open-questions.md` and `docs/industry-gap-analysis.md`. No RIOS feature is
  invented; where a working engine has pending UI / external wiring / certified
  content, the row is marked **Partial** or **Designed-for** with the specific gap.
- **Comparator columns** — the 20 named platforms (SAP FS-RI, Sapiens
  ReinsuranceMaster, Eurobase Synergy2, Guidewire, Duck Creek, Fadata INSIS, Oracle
  Insurance, FIS, Majesco, SICS, Xuber/DXC, Verisk/RMS, Moody's RMS, Sequel, Effisoft
  WebXL/Omega, Tia/TietoEVRY, msg global, Novidea, Instanda, ClarionDoor) do not
  publish internal source. Their descriptions are inferred **only** from public,
  market-standard footprints (vendor module maps, Lloyd's/LMA MRC, ACORD EBOT/ECOT,
  NAIC Schedule F, Solvency II QRTs, published product-model descriptions). No
  proprietary competitor internals are asserted.
- **What RIOS is** — a correct, secure, audited vertical-slice *foundation*
  (place → bind → account → reconcile, plus claims and a guardrailed assistant), not a
  finished commercial product. The brief's full breadth is designed-for and named.

## How to regenerate

```bash
python3 presentation/build_comparison.py
```

Requires `openpyxl` (`python3 -c "import openpyxl"`; install with `pip install openpyxl`
if missing). The script is the single source of truth for the workbook contents; edit
the data lists in `build_comparison.py` and re-run. The workbook is self-contained (no
external links).
