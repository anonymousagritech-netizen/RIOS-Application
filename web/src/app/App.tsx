import { Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { lazyPage } from '../lib/lazyPage';
import { PageLoader } from '../components/Feedback';
import { AppShell } from './AppShell';
// Kept eager: the login page is the first paint for anonymous users.
import { LoginPage } from '../pages/LoginPage';

// Route-level code splitting (perf finding D-4): every page below is loaded on
// first navigation via React.lazy. Pages use NAMED exports, so lazyPage maps
// `m.XPage` onto the `{ default }` shape React.lazy expects.
const DashboardPage = lazyPage(() => import('../pages/DashboardPage'), 'DashboardPage');
const TreatiesPage = lazyPage(() => import('../pages/TreatiesPage'), 'TreatiesPage');
const UnderwritingPage = lazyPage(() => import('../pages/UnderwritingPage'), 'UnderwritingPage');
const UnderwritingAnalyticsPage = lazyPage(() => import('../pages/UnderwritingAnalyticsPage'), 'UnderwritingAnalyticsPage');
const UnderwritingApprovalsPage = lazyPage(() => import('../pages/UnderwritingApprovalsPage'), 'UnderwritingApprovalsPage');
const BrokerPage = lazyPage(() => import('../pages/BrokerPage'), 'BrokerPage');
const CedentPage = lazyPage(() => import('../pages/CedentPage'), 'CedentPage');
const CapacityPage = lazyPage(() => import('../pages/CapacityPage'), 'CapacityPage');
const ExposureMgmtPage = lazyPage(() => import('../pages/ExposureMgmtPage'), 'ExposureMgmtPage');
const TerritoriesPage = lazyPage(() => import('../pages/TerritoriesPage'), 'TerritoriesPage');
const TasksPage = lazyPage(() => import('../pages/TasksPage'), 'TasksPage');
const AuditLogPage = lazyPage(() => import('../pages/AuditLogPage'), 'AuditLogPage');
const NotificationsPage = lazyPage(() => import('../pages/NotificationsPage'), 'NotificationsPage');
const ClientsPage = lazyPage(() => import('../pages/ClientsPage'), 'ClientsPage');
const TreatyAdminPage = lazyPage(() => import('../pages/TreatyAdminPage'), 'TreatyAdminPage');
const OrganizationPage = lazyPage(() => import('../pages/OrganizationPage'), 'OrganizationPage');
const TerritoryManagementPage = lazyPage(() => import('../pages/TerritoryManagementPage'), 'TerritoryManagementPage');
const ScheduledReportsPage = lazyPage(() => import('../pages/ScheduledReportsPage'), 'ScheduledReportsPage');
const ExecutiveDashboardPage = lazyPage(() => import('../pages/ExecutiveDashboardPage'), 'ExecutiveDashboardPage');
const CompliancePage = lazyPage(() => import('../pages/CompliancePage'), 'CompliancePage');
const FacultativeAdminPage = lazyPage(() => import('../pages/FacultativeAdminPage'), 'FacultativeAdminPage');
const WorkflowEnginePage = lazyPage(() => import('../pages/WorkflowEnginePage'), 'WorkflowEnginePage');
const AIInsightsPage = lazyPage(() => import('../pages/AIInsightsPage'), 'AIInsightsPage');
const UnderwritingWorkspace = lazyPage(() => import('../pages/workspaces'), 'UnderwritingWorkspace');
const TreatyWorkspace = lazyPage(() => import('../pages/workspaces'), 'TreatyWorkspace');
const FacultativeWorkspace = lazyPage(() => import('../pages/workspaces'), 'FacultativeWorkspace');
const CapacityExposureWorkspace = lazyPage(() => import('../pages/workspaces'), 'CapacityExposureWorkspace');
const TerritoryWorkspace = lazyPage(() => import('../pages/workspaces'), 'TerritoryWorkspace');
const OperationsCenter = lazyPage(() => import('../pages/workspaces'), 'OperationsCenter');
const WorkflowCenter = lazyPage(() => import('../pages/workspaces'), 'WorkflowCenter');
const IntegrationHubWorkspace = lazyPage(() => import('../pages/workspaces'), 'IntegrationHubWorkspace');
const AutomationStudioWorkspace = lazyPage(() => import('../pages/workspaces'), 'AutomationStudioWorkspace');
const TreatyDetailPage = lazyPage(() => import('../pages/TreatyDetailPage'), 'TreatyDetailPage');
const FacultativeDetailPage = lazyPage(() => import('../pages/FacultativeDetailPage'), 'FacultativeDetailPage');
const PartiesPage = lazyPage(() => import('../pages/PartiesPage'), 'PartiesPage');
const PartyDetailPage = lazyPage(() => import('../pages/PartyDetailPage'), 'PartyDetailPage');
const ClaimsPage = lazyPage(() => import('../pages/ClaimsPage'), 'ClaimsPage');
const ClaimDetailPage = lazyPage(() => import('../pages/ClaimDetailPage'), 'ClaimDetailPage');
const AccountingPage = lazyPage(() => import('../pages/AccountingPage'), 'AccountingPage');
const AdminPage = lazyPage(() => import('../pages/AdminPage'), 'AdminPage');
const FacultativePage = lazyPage(() => import('../pages/FacultativePage'), 'FacultativePage');
const RetrocessionPage = lazyPage(() => import('../pages/RetrocessionPage'), 'RetrocessionPage');
const PlacementPage = lazyPage(() => import('../pages/PlacementPage'), 'PlacementPage');
const PricingPage = lazyPage(() => import('../pages/PricingPage'), 'PricingPage');
const BordereauxPage = lazyPage(() => import('../pages/BordereauxPage'), 'BordereauxPage');
const ExposurePage = lazyPage(() => import('../pages/ExposurePage'), 'ExposurePage');
const StatementsPage = lazyPage(() => import('../pages/StatementsPage'), 'StatementsPage');
const FinancePage = lazyPage(() => import('../pages/FinancePage'), 'FinancePage');
const RegulatoryPage = lazyPage(() => import('../pages/RegulatoryPage'), 'RegulatoryPage');
const WorkflowPage = lazyPage(() => import('../pages/WorkflowPage'), 'WorkflowPage');
const DocumentsPage = lazyPage(() => import('../pages/DocumentsPage'), 'DocumentsPage');
const ReportsPage = lazyPage(() => import('../pages/ReportsPage'), 'ReportsPage');
const CrmPage = lazyPage(() => import('../pages/CrmPage'), 'CrmPage');
const IntegrationPage = lazyPage(() => import('../pages/IntegrationPage'), 'IntegrationPage');
const HrmsPage = lazyPage(() => import('../pages/HrmsPage'), 'HrmsPage');
const AttendancePage = lazyPage(() => import('../pages/AttendancePage'), 'AttendancePage');
const ProcurementPage = lazyPage(() => import('../pages/ProcurementPage'), 'ProcurementPage');
const AssetsPage = lazyPage(() => import('../pages/AssetsPage'), 'AssetsPage');
const OperationsPage = lazyPage(() => import('../pages/OperationsPage'), 'OperationsPage');
const PayrollPage = lazyPage(() => import('../pages/PayrollPage'), 'PayrollPage');
const PeriodClosePage = lazyPage(() => import('../pages/PeriodClosePage'), 'PeriodClosePage');
const TreatyAdjustmentsPage = lazyPage(() => import('../pages/TreatyAdjustmentsPage'), 'TreatyAdjustmentsPage');
const ClaimsRecoveriesPage = lazyPage(() => import('../pages/ClaimsRecoveriesPage'), 'ClaimsRecoveriesPage');
const RegulatoryReturnsPage = lazyPage(() => import('../pages/RegulatoryReturnsPage'), 'RegulatoryReturnsPage');
const SecurityPage = lazyPage(() => import('../pages/SecurityPage'), 'SecurityPage');
const PortalPage = lazyPage(() => import('../pages/PortalPage'), 'PortalPage');
const DesignerPage = lazyPage(() => import('../pages/DesignerPage'), 'DesignerPage');
const AnalyticsPage = lazyPage(() => import('../pages/AnalyticsPage'), 'AnalyticsPage');
const TreasuryPage = lazyPage(() => import('../pages/TreasuryPage'), 'TreasuryPage');
const BureauPage = lazyPage(() => import('../pages/BureauPage'), 'BureauPage');
const CatModelPage = lazyPage(() => import('../pages/CatModelPage'), 'CatModelPage');
const RiskCapitalPage = lazyPage(() => import('../pages/RiskCapitalPage'), 'RiskCapitalPage');
const SearchPage = lazyPage(() => import('../pages/SearchPage'), 'SearchPage');
const RetentionPage = lazyPage(() => import('../pages/RetentionPage'), 'RetentionPage');
const FieldSecurityPage = lazyPage(() => import('../pages/FieldSecurityPage'), 'FieldSecurityPage');
const SchedulerPage = lazyPage(() => import('../pages/SchedulerPage'), 'SchedulerPage');
const DelegationPage = lazyPage(() => import('../pages/DelegationPage'), 'DelegationPage');
const PerformancePage = lazyPage(() => import('../pages/PerformancePage'), 'PerformancePage');
const ProductsPage = lazyPage(() => import('../pages/ProductsPage'), 'ProductsPage');
const CompaniesPage = lazyPage(() => import('../pages/CompaniesPage'), 'CompaniesPage');
const FeaturesPage = lazyPage(() => import('../pages/FeaturesPage'), 'FeaturesPage');
const CostPage = lazyPage(() => import('../pages/CostPage'), 'CostPage');
const MessagingPage = lazyPage(() => import('../pages/MessagingPage'), 'MessagingPage');
const IntegrationHubPage = lazyPage(() => import('../pages/IntegrationHubPage'), 'IntegrationHubPage');
const SecurityOpsPage = lazyPage(() => import('../pages/SecurityOpsPage'), 'SecurityOpsPage');
const IntelligencePage = lazyPage(() => import('../pages/IntelligencePage'), 'IntelligencePage');
const MobilePage = lazyPage(() => import('../pages/MobilePage'), 'MobilePage');
const MarketplacePage = lazyPage(() => import('../pages/MarketplacePage'), 'MarketplacePage');
const AutomationStudioPage = lazyPage(() => import('../pages/AutomationStudioPage'), 'AutomationStudioPage');
const FormulaManagementPage = lazyPage(() => import('../pages/FormulaManagementPage'), 'FormulaManagementPage');

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
      <Suspense fallback={<PageLoader label="Loading…" />}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/login" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/underwriting" element={<UnderwritingPage />} />
          <Route path="/underwriting/analytics" element={<UnderwritingAnalyticsPage />} />
          <Route path="/underwriting/approvals" element={<UnderwritingApprovalsPage />} />
          <Route path="/brokers" element={<BrokerPage />} />
          <Route path="/cedents" element={<CedentPage />} />
          <Route path="/capacity" element={<CapacityPage />} />
          <Route path="/exposure-management" element={<ExposureMgmtPage />} />
          <Route path="/territories" element={<TerritoriesPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/audit" element={<AuditLogPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/clients" element={<ClientsPage />} />
          <Route path="/treaty-admin" element={<TreatyAdminPage />} />
          <Route path="/organization" element={<OrganizationPage />} />
          <Route path="/territory-management" element={<TerritoryManagementPage />} />
          <Route path="/scheduled-reports" element={<ScheduledReportsPage />} />
          <Route path="/executive" element={<ExecutiveDashboardPage />} />
          <Route path="/compliance" element={<CompliancePage />} />
          <Route path="/facultative-admin" element={<FacultativeAdminPage />} />
          <Route path="/workflow-engine" element={<WorkflowEnginePage />} />
          <Route path="/ai-insights" element={<AIInsightsPage />} />
          {/* Enterprise workspaces — compose existing pages as tabs (originals still routed below). */}
          <Route path="/w/underwriting" element={<UnderwritingWorkspace />} />
          <Route path="/w/treaty" element={<TreatyWorkspace />} />
          <Route path="/w/facultative" element={<FacultativeWorkspace />} />
          <Route path="/w/capacity-exposure" element={<CapacityExposureWorkspace />} />
          <Route path="/w/territory" element={<TerritoryWorkspace />} />
          <Route path="/w/operations" element={<OperationsCenter />} />
          <Route path="/w/workflow" element={<WorkflowCenter />} />
          <Route path="/w/integration" element={<IntegrationHubWorkspace />} />
          <Route path="/w/automation" element={<AutomationStudioWorkspace />} />
          <Route path="/treaties" element={<TreatiesPage />} />
          <Route path="/treaties/:id" element={<TreatyDetailPage />} />
          <Route path="/parties" element={<PartiesPage />} />
          <Route path="/parties/:id" element={<PartyDetailPage />} />
          <Route path="/claims" element={<ClaimsPage />} />
          <Route path="/claims/:id" element={<ClaimDetailPage />} />
          <Route path="/accounting" element={<AccountingPage />} />
          <Route path="/facultative" element={<FacultativePage />} />
          <Route path="/facultative/:id" element={<FacultativeDetailPage />} />
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
          <Route path="/attendance" element={<AttendancePage />} />
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
          <Route path="/bureau" element={<BureauPage />} />
          <Route path="/cat-model" element={<CatModelPage />} />
          <Route path="/risk-capital" element={<RiskCapitalPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/retention" element={<RetentionPage />} />
          <Route path="/field-security" element={<FieldSecurityPage />} />
          <Route path="/scheduler" element={<SchedulerPage />} />
          <Route path="/delegation" element={<DelegationPage />} />
          <Route path="/performance" element={<PerformancePage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/organisation" element={<CompaniesPage />} />
          <Route path="/features" element={<FeaturesPage />} />
          <Route path="/cost" element={<CostPage />} />
          <Route path="/messaging" element={<MessagingPage />} />
          <Route path="/integration-hub" element={<IntegrationHubPage />} />
          <Route path="/security-ops" element={<SecurityOpsPage />} />
          <Route path="/intelligence" element={<IntelligencePage />} />
          <Route path="/mobile" element={<MobilePage />} />
          <Route path="/marketplace" element={<MarketplacePage />} />
          <Route path="/automation-studio" element={<AutomationStudioPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/formulas" element={<FormulaManagementPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
