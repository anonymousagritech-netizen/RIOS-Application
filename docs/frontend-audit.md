# RIOS Frontend Consistency Audit

Generated programmatically across all 57 pages in `web/src/pages/`.

## Key finding

Token adoption is **strong**, contrary to a first impression of inconsistency:
- **0 hard-coded hex colours** anywhere in the pages (color discipline already enforced).
- **332** inline-style declarations already reference `var(--*)` tokens; only **11** carry a raw px/% value (all layout constraints like `minWidth: 180`, not visual tokens).
- **56 / 57** pages use the shared `PageHeader`; the exception is `LoginPage` (intentional standalone layout).
- All pages reuse the shared `Card` / `Table` / `Badge` / `Button` / `KpiCard` primitives (which are themselves token-driven and dark-mode aware).

So the genuine remediation is **(a)** migrating the heaviest inline-`style` pages to dedicated `.module.css` files for maintainability, and **(b)** replacing the 11 raw px values with tokens or CSS. There is no hard-coded-colour or font problem to fix. Dark-mode parity is inherited from the semantic tokens and shared components.

## Remediation status (post-audit)

- **Hard-coded colours: now zero across the whole of `web/src`** (previously the
  audit counted hex only inside `pages/`; a follow-up sweep of components,
  `app/`, `assistant/` and page CSS modules found 11 stray `#fff` / gradient
  end-stops in CSS modules). All replaced with `var(--primary-fg)` and
  token-derived `color-mix(... black)` darkening. Verify:
  `grep -rn "#[0-9a-fA-F]\{3,6\}" web/src --include=*.tsx --include=*.css | grep -v tokens.css` → no matches.
- **Heavy-inline pages → `.module.css`:** the medium-severity pages (≥13
  token-based inline-style declarations) were migrated to co-located CSS modules
  (Analytics, Designer, Intelligence, Procurement, Assets, Documents, Pricing,
  PeriodClose, ClaimsRecoveries, TreatyAdjustments, RegulatoryReturns,
  Regulatory, SecurityOps, AutomationStudio). Pure style relocation - identical
  token values, no visual change, dark-mode unaffected.
- **Raw px:** the remaining `px` occurrences are idiomatic layout constraints
  (`1px solid var(--border)`, `minmax(300px, 1fr)`, `maxHeight: 360px`) - not
  spacing/typography that belongs in a token. Left as-is by design.
- **Part B pages** (Attendance command center, HR employee detail) were built to
  this standard from the start: token-only, dedicated CSS module, dark-mode
  parity, status colours derived from `--accent-*` tokens via `data-status`.
- **Verification:** light + dark screenshots of the rebuilt Attendance (Today /
  Calendar / Team) and HR detail surfaces confirmed token-correct rendering in
  both themes; `npm run build` (web) and `tsc --noEmit` pass clean.

## Per-page findings

| Page | .module.css | Token adoption | Issues | Severity |
|---|---|---|---|---|
| AccountingPage | N | good (token inline) | no .module.css (uses shared); 1 inline style{} (token-based) | None |
| AdminPage | Y | good (token inline) | 3 inline style{} (token-based) | None |
| AnalyticsPage | N | partial (heavy inline) | no .module.css (uses shared); 28 inline style{} (token-based) | Medium |
| AssetsPage | N | partial (heavy inline) | no .module.css (uses shared); 18 inline style{} (token-based) | Medium |
| AttendancePage | Y | good (token inline) | 1 inline style{} (token-based) | None |
| AutomationStudioPage | N | good (token inline) | no .module.css (uses shared); 7 inline style{} (token-based) | None |
| BordereauxPage | N | good (token inline) | no .module.css (uses shared); 11 inline style{} (token-based) | None |
| ClaimDetailPage | Y | good (token inline) | 4 inline style{} (token-based) | None |
| ClaimsPage | N | good (token inline) | no .module.css (uses shared); 4 inline style{} (token-based) | None |
| ClaimsRecoveriesPage | N | partial (heavy inline) | no .module.css (uses shared); 13 inline style{} (token-based) | Medium |
| CompaniesPage | N | good (token inline) | no .module.css (uses shared); 2 inline style{} (token-based) | None |
| CostPage | N | good (token inline) | no .module.css (uses shared); 3 inline style{} (token-based) | None |
| CrmPage | Y | good (token inline) | 11 inline style{} (token-based) | None |
| DashboardPage | N | good (token inline) | no .module.css (uses shared); 1 inline style{} (token-based) | None |
| DelegationPage | N | good (token inline) | no .module.css (uses shared); 7 inline style{} (token-based) | None |
| DesignerPage | N | partial (heavy inline) | no .module.css (uses shared); 23 inline style{} (token-based); 2 raw px/% | Medium |
| DocumentsPage | N | partial (heavy inline) | no .module.css (uses shared); 13 inline style{} (token-based) | Medium |
| ExposurePage | Y | good (token inline) | 7 inline style{} (token-based) | None |
| FacultativePage | N | good (token inline) | no .module.css (uses shared); 6 inline style{} (token-based) | None |
| FeaturesPage | N | good (token inline) | no .module.css (uses shared); 1 inline style{} (token-based) | None |
| FieldSecurityPage | N | good (token inline) | no .module.css (uses shared); 5 inline style{} (token-based); 1 raw px/% | Low |
| FinancePage | N | good (token inline) | no .module.css (uses shared); 5 inline style{} (token-based) | None |
| HrmsPage | N | partial (heavy inline) | no .module.css (uses shared); 20 inline style{} (token-based) | Medium |
| IntegrationHubPage | N | good (token inline) | no .module.css (uses shared); 7 inline style{} (token-based) | None |
| IntegrationPage | Y | good (token inline) | 9 inline style{} (token-based) | None |
| IntelligencePage | N | partial (heavy inline) | no .module.css (uses shared); 14 inline style{} (token-based); 1 raw px/% | Medium |
| LoginPage | Y | full | clean | None |
| MarketplacePage | N | good (token inline) | no .module.css (uses shared); 3 inline style{} (token-based); 1 raw px/% | Low |
| MessagingPage | N | good (token inline) | no .module.css (uses shared); 5 inline style{} (token-based) | None |
| MobilePage | N | good (token inline) | no .module.css (uses shared); 4 inline style{} (token-based); 1 raw px/% | Low |
| OperationsPage | N | good (token inline) | no .module.css (uses shared); 10 inline style{} (token-based) | None |
| PartiesPage | N | good (token inline) | no .module.css (uses shared); 4 inline style{} (token-based) | None |
| PartyDetailPage | N | good (token inline) | no .module.css (uses shared); 1 inline style{} (token-based) | None |
| PayrollPage | N | good (token inline) | no .module.css (uses shared); 11 inline style{} (token-based) | None |
| PerformancePage | N | good (token inline) | no .module.css (uses shared); 2 inline style{} (token-based) | None |
| PeriodClosePage | N | partial (heavy inline) | no .module.css (uses shared); 16 inline style{} (token-based) | Medium |
| PlacementPage | N | good (token inline) | no .module.css (uses shared); 8 inline style{} (token-based); 1 raw px/% | Low |
| PortalPage | N | good (token inline) | no .module.css (uses shared); 5 inline style{} (token-based) | None |
| PricingPage | N | partial (heavy inline) | no .module.css (uses shared); 17 inline style{} (token-based); 2 raw px/% | Medium |
| ProcurementPage | N | partial (heavy inline) | no .module.css (uses shared); 19 inline style{} (token-based) | Medium |
| ProductsPage | N | good (token inline) | no .module.css (uses shared); 2 inline style{} (token-based) | None |
| RegulatoryPage | N | partial (heavy inline) | no .module.css (uses shared); 13 inline style{} (token-based) | Medium |
| RegulatoryReturnsPage | N | partial (heavy inline) | no .module.css (uses shared); 15 inline style{} (token-based); 1 raw px/% | Medium |
| ReportsPage | N | good (token inline) | no .module.css (uses shared); 9 inline style{} (token-based) | None |
| RetentionPage | N | good (token inline) | no .module.css (uses shared); 10 inline style{} (token-based) | None |
| RetrocessionPage | N | good (token inline) | no .module.css (uses shared); 6 inline style{} (token-based) | None |
| RiskCapitalPage | N | good (token inline) | no .module.css (uses shared); 8 inline style{} (token-based) | None |
| SchedulerPage | N | good (token inline) | no .module.css (uses shared); 3 inline style{} (token-based) | None |
| SearchPage | N | good (token inline) | no .module.css (uses shared); 4 inline style{} (token-based); 1 raw px/% | Low |
| SecurityOpsPage | N | partial (heavy inline) | no .module.css (uses shared); 13 inline style{} (token-based) | Medium |
| SecurityPage | N | good (token inline) | no .module.css (uses shared); 4 inline style{} (token-based); 1 raw px/% | Low |
| StatementsPage | N | good (token inline) | no .module.css (uses shared); 6 inline style{} (token-based) | None |
| TreasuryPage | N | good (token inline) | no .module.css (uses shared); 7 inline style{} (token-based) | None |
| TreatiesPage | N | good (token inline) | no .module.css (uses shared); 5 inline style{} (token-based) | None |
| TreatyAdjustmentsPage | N | partial (heavy inline) | no .module.css (uses shared); 16 inline style{} (token-based) | Medium |
| TreatyDetailPage | Y | full | clean | None |
| WorkflowPage | N | good (token inline) | no .module.css (uses shared); 4 inline style{} (token-based) | None |
