/**
 * Enterprise workspaces — each composes several existing pages into one tabbed
 * surface (see Workspace.tsx). The sidebar links to these workspaces so related
 * functionality lives together as a single entry; the underlying pages and
 * routes are untouched and remain individually reachable.
 */
import { Workspace } from './Workspace';

import { UnderwritingPage } from '../UnderwritingPage';
import { UnderwritingApprovalsPage } from '../UnderwritingApprovalsPage';
import { UnderwritingAnalyticsPage } from '../UnderwritingAnalyticsPage';
import { TreatiesPage } from '../TreatiesPage';
import { TreatyAdminPage } from '../TreatyAdminPage';
import { FacultativePage } from '../FacultativePage';
import { FacultativeAdminPage } from '../FacultativeAdminPage';
import { CapacityPage } from '../CapacityPage';
import { ExposurePage } from '../ExposurePage';
import { ExposureMgmtPage } from '../ExposureMgmtPage';
import { TerritoriesPage } from '../TerritoriesPage';
import { TerritoryManagementPage } from '../TerritoryManagementPage';
import { TasksPage } from '../TasksPage';
import { NotificationsPage } from '../NotificationsPage';
import { WorkflowPage } from '../WorkflowPage';
import { WorkflowEnginePage } from '../WorkflowEnginePage';
import { IntegrationPage } from '../IntegrationPage';
import { IntegrationHubPage } from '../IntegrationHubPage';
import { MarketplacePage } from '../MarketplacePage';
import { AutomationStudioPage } from '../AutomationStudioPage';
import { DesignerPage } from '../DesignerPage';
import { SchedulerPage } from '../SchedulerPage';

export function UnderwritingWorkspace() {
  return (
    <Workspace
      title="Underwriting Workspace"
      subtitle="The underwriting desk — workbench, approvals and analytics in one place."
      tabs={[
        { id: 'workbench', label: 'Workbench', component: UnderwritingPage },
        { id: 'approvals', label: 'Approvals', component: UnderwritingApprovalsPage },
        { id: 'analytics', label: 'Analytics', component: UnderwritingAnalyticsPage },
      ]}
    />
  );
}

export function TreatyWorkspace() {
  return (
    <Workspace
      title="Treaty Workspace"
      subtitle="The treaty lifecycle — the register and the full administration workspace (layers, pricing, clauses, versions, endorsements, technical account, timeline)."
      tabs={[
        { id: 'register', label: 'Register', component: TreatiesPage },
        { id: 'administration', label: 'Administration', component: TreatyAdminPage },
      ]}
    />
  );
}

export function FacultativeWorkspace() {
  return (
    <Workspace
      title="Facultative Workspace"
      subtitle="Facultative risks — submissions and the placement / quotes / engineering administration workspace."
      tabs={[
        { id: 'submissions', label: 'Submissions', component: FacultativePage },
        { id: 'administration', label: 'Administration', component: FacultativeAdminPage },
      ]}
    />
  );
}

export function CapacityExposureWorkspace() {
  return (
    <Workspace
      title="Capacity & Exposure"
      subtitle="Capacity utilisation, exposure accumulation and the exposure-management console together."
      tabs={[
        { id: 'capacity', label: 'Capacity', component: CapacityPage },
        { id: 'exposure', label: 'Exposure', component: ExposurePage },
        { id: 'accumulation', label: 'Exposure Mgmt', component: ExposureMgmtPage },
      ]}
    />
  );
}

export function TerritoryWorkspace() {
  return (
    <Workspace
      title="Territory Workspace"
      subtitle="Geographic accumulation — the territory register and the zone/risk management console."
      tabs={[
        { id: 'territories', label: 'Territories', component: TerritoriesPage },
        { id: 'management', label: 'Territory Mgmt', component: TerritoryManagementPage },
      ]}
    />
  );
}

export function OperationsCenter() {
  return (
    <Workspace
      title="Operations Center"
      subtitle="Day-to-day operations — tasks & SLA and the notification centre."
      tabs={[
        { id: 'tasks', label: 'Tasks & SLA', component: TasksPage },
        { id: 'notifications', label: 'Notifications', component: NotificationsPage },
      ]}
    />
  );
}

export function WorkflowCenter() {
  return (
    <Workspace
      title="Workflow Center"
      subtitle="Active workflows, the workflow/rules designer and the SLA & escalation engine."
      tabs={[
        { id: 'active', label: 'Active Workflows', component: WorkflowPage },
        { id: 'engine', label: 'Workflow Engine', component: WorkflowEnginePage },
      ]}
    />
  );
}

export function IntegrationHubWorkspace() {
  return (
    <Workspace
      title="Integration Hub"
      subtitle="Connectors, APIs and the integration catalogue in one hub."
      tabs={[
        { id: 'integration', label: 'Integration', component: IntegrationPage },
        { id: 'hub', label: 'Hub & Connectors', component: IntegrationHubPage },
        { id: 'marketplace', label: 'Marketplace', component: MarketplacePage },
      ]}
    />
  );
}

export function AutomationStudioWorkspace() {
  return (
    <Workspace
      title="Automation Studio"
      subtitle="Automation flows, the visual designer and the job scheduler together."
      tabs={[
        { id: 'studio', label: 'Studio', component: AutomationStudioPage },
        { id: 'designer', label: 'Designer', component: DesignerPage },
        { id: 'scheduler', label: 'Scheduler', component: SchedulerPage },
      ]}
    />
  );
}
