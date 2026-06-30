import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { PageLoader } from '../components/Feedback';
import { AppShell } from './AppShell';
import { LoginPage } from '../pages/LoginPage';
import { DashboardPage } from '../pages/DashboardPage';
import { TreatiesPage } from '../pages/TreatiesPage';
import { TreatyDetailPage } from '../pages/TreatyDetailPage';
import { PartiesPage } from '../pages/PartiesPage';
import { PartyDetailPage } from '../pages/PartyDetailPage';
import { ClaimsPage } from '../pages/ClaimsPage';
import { ClaimDetailPage } from '../pages/ClaimDetailPage';
import { AccountingPage } from '../pages/AccountingPage';
import { AdminPage } from '../pages/AdminPage';
import { FacultativePage } from '../pages/FacultativePage';
import { RetrocessionPage } from '../pages/RetrocessionPage';
import { PlacementPage } from '../pages/PlacementPage';
import { PricingPage } from '../pages/PricingPage';
import { BordereauxPage } from '../pages/BordereauxPage';
import { ExposurePage } from '../pages/ExposurePage';
import { StatementsPage } from '../pages/StatementsPage';
import { FinancePage } from '../pages/FinancePage';
import { RegulatoryPage } from '../pages/RegulatoryPage';
import { WorkflowPage } from '../pages/WorkflowPage';
import { DocumentsPage } from '../pages/DocumentsPage';
import { ReportsPage } from '../pages/ReportsPage';
import { CrmPage } from '../pages/CrmPage';
import { IntegrationPage } from '../pages/IntegrationPage';
import { HrmsPage } from '../pages/HrmsPage';
import { ProcurementPage } from '../pages/ProcurementPage';
import { AssetsPage } from '../pages/AssetsPage';
import { OperationsPage } from '../pages/OperationsPage';
import { PayrollPage } from '../pages/PayrollPage';
import { PeriodClosePage } from '../pages/PeriodClosePage';
import { TreatyAdjustmentsPage } from '../pages/TreatyAdjustmentsPage';
import { ClaimsRecoveriesPage } from '../pages/ClaimsRecoveriesPage';
import { RegulatoryReturnsPage } from '../pages/RegulatoryReturnsPage';
import { SecurityPage } from '../pages/SecurityPage';
import { PortalPage } from '../pages/PortalPage';
import { DesignerPage } from '../pages/DesignerPage';
import { AnalyticsPage } from '../pages/AnalyticsPage';
import { TreasuryPage } from '../pages/TreasuryPage';
import { RiskCapitalPage } from '../pages/RiskCapitalPage';
import { SearchPage } from '../pages/SearchPage';
import { RetentionPage } from '../pages/RetentionPage';
import { FieldSecurityPage } from '../pages/FieldSecurityPage';

export function App() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <PageLoader label="Restoring your session…" />;
  }

  if (status === 'anon') {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location }} />} />
      </Routes>
    );
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/login" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/treaties" element={<TreatiesPage />} />
        <Route path="/treaties/:id" element={<TreatyDetailPage />} />
        <Route path="/parties" element={<PartiesPage />} />
        <Route path="/parties/:id" element={<PartyDetailPage />} />
        <Route path="/claims" element={<ClaimsPage />} />
        <Route path="/claims/:id" element={<ClaimDetailPage />} />
        <Route path="/accounting" element={<AccountingPage />} />
        <Route path="/facultative" element={<FacultativePage />} />
        <Route path="/retrocession" element={<RetrocessionPage />} />
        <Route path="/placement" element={<PlacementPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/bordereaux" element={<BordereauxPage />} />
        <Route path="/exposure" element={<ExposurePage />} />
        <Route path="/statements" element={<StatementsPage />} />
        <Route path="/finance" element={<FinancePage />} />
        <Route path="/regulatory" element={<RegulatoryPage />} />
        <Route path="/workflow" element={<WorkflowPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/crm" element={<CrmPage />} />
        <Route path="/integration" element={<IntegrationPage />} />
        <Route path="/hr" element={<HrmsPage />} />
        <Route path="/procurement" element={<ProcurementPage />} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/operations" element={<OperationsPage />} />
        <Route path="/payroll" element={<PayrollPage />} />
        <Route path="/period-close" element={<PeriodClosePage />} />
        <Route path="/adjustments" element={<TreatyAdjustmentsPage />} />
        <Route path="/recoveries" element={<ClaimsRecoveriesPage />} />
        <Route path="/returns" element={<RegulatoryReturnsPage />} />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="/portal" element={<PortalPage />} />
        <Route path="/designer" element={<DesignerPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/treasury" element={<TreasuryPage />} />
        <Route path="/risk-capital" element={<RiskCapitalPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/retention" element={<RetentionPage />} />
        <Route path="/field-security" element={<FieldSecurityPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AppShell>
  );
}
