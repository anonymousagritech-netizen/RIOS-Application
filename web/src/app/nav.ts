import {
  LayoutDashboard, Search, Sparkles, Smartphone,
  Gavel,
  FileText, FileCheck2, ArrowLeftRight, PenLine, Calculator, Boxes, SlidersHorizontal,
  Users, Contact, FolderOpen, Briefcase,
  ShieldAlert, Grid2x2, Radar, Undo2,
  BookOpen, ReceiptText, Wallet, PiggyBank, CalendarCheck,
  BarChart3, LineChart, ShieldCheck, Scale, FileSpreadsheet, Workflow, GitBranch, Shapes,
  Clock, UserRound, Banknote, TrendingUp,
  ShoppingCart, Package,
  Activity, CalendarClock, Plug, Network, Store, Bot, Mail, PanelsTopLeft, Lock, Shield, ListChecks,
  Archive, EyeOff, Building2, Flag, Gauge, Settings, Globe2, Fingerprint,
  Map as MapIcon, ClipboardCheck,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  permission?: string;
}
export interface NavGroup {
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    icon: LayoutDashboard,
    items: [
      { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
      { label: 'Search', to: '/search', icon: Search },
      { label: 'Intelligence', to: '/intelligence', icon: Sparkles },
      { label: 'AI Insights', to: '/ai-insights', icon: Sparkles },
      { label: 'Executive', to: '/executive', icon: TrendingUp, permission: 'reporting:read' },
      { label: 'Mobile', to: '/mobile', icon: Smartphone },
    ],
  },
  {
    label: 'Underwriting',
    icon: FileText,
    items: [
      { label: 'Underwriting', to: '/underwriting', icon: Gavel, permission: 'treaty:read' },
      { label: 'UW Analytics', to: '/underwriting/analytics', icon: BarChart3, permission: 'treaty:read' },
      { label: 'Approvals', to: '/underwriting/approvals', icon: ShieldCheck, permission: 'treaty:read' },
      { label: 'Capacity', to: '/capacity', icon: Gauge, permission: 'treaty:read' },
      { label: 'Exposure Mgmt', to: '/exposure-management', icon: Radar, permission: 'exposure:read' },
      { label: 'Territories', to: '/territories', icon: Globe2, permission: 'exposure:read' },
      { label: 'Territory Mgmt', to: '/territory-management', icon: MapIcon, permission: 'exposure:read' },
      { label: 'Treaties', to: '/treaties', icon: FileText, permission: 'treaty:read' },
      { label: 'Treaty Admin', to: '/treaty-admin', icon: FileSpreadsheet, permission: 'treaty:read' },
      { label: 'Facultative', to: '/facultative', icon: FileCheck2, permission: 'facultative:read' },
      { label: 'Facultative Admin', to: '/facultative-admin', icon: ClipboardCheck, permission: 'facultative:read' },
      { label: 'Retrocession', to: '/retrocession', icon: ArrowLeftRight, permission: 'retro:read' },
      { label: 'Placement', to: '/placement', icon: PenLine, permission: 'placement:read' },
      { label: 'Pricing', to: '/pricing', icon: Calculator, permission: 'pricing:read' },
      { label: 'Products', to: '/products', icon: Boxes, permission: 'product:read' },
      { label: 'Adjustments', to: '/adjustments', icon: SlidersHorizontal, permission: 'treaty:read' },
    ],
  },
  {
    label: 'Distribution',
    icon: Users,
    items: [
      { label: 'Parties', to: '/parties', icon: Users, permission: 'party:read' },
      { label: 'Clients', to: '/clients', icon: Contact, permission: 'party:read' },
      { label: 'Brokers', to: '/brokers', icon: Briefcase, permission: 'party:read' },
      { label: 'Cedents', to: '/cedents', icon: Building2, permission: 'party:read' },
      { label: 'CRM', to: '/crm', icon: Contact, permission: 'crm:read' },
      { label: 'Documents', to: '/documents', icon: FolderOpen, permission: 'documents:read' },
    ],
  },
  {
    label: 'Operations',
    icon: ShieldAlert,
    items: [
      { label: 'Claims', to: '/claims', icon: ShieldAlert, permission: 'claims:read' },
      { label: 'Bordereaux', to: '/bordereaux', icon: Grid2x2, permission: 'bordereaux:read' },
      { label: 'Exposure', to: '/exposure', icon: Radar, permission: 'exposure:read' },
      { label: 'Recoveries', to: '/recoveries', icon: Undo2, permission: 'claims:read' },
    ],
  },
  {
    label: 'Finance',
    icon: Wallet,
    items: [
      { label: 'Accounting', to: '/accounting', icon: BookOpen, permission: 'accounting:read' },
      { label: 'Statements', to: '/statements', icon: ReceiptText, permission: 'statement:read' },
      { label: 'Finance', to: '/finance', icon: Wallet, permission: 'finance:read' },
      { label: 'Treasury', to: '/treasury', icon: PiggyBank, permission: 'treasury:read' },
      { label: 'Period Close', to: '/period-close', icon: CalendarCheck, permission: 'finance:read' },
    ],
  },
  {
    label: 'Analytics & Compliance',
    icon: BarChart3,
    items: [
      { label: 'Reports', to: '/reports', icon: BarChart3, permission: 'reporting:read' },
      { label: 'Scheduled Reports', to: '/scheduled-reports', icon: CalendarClock, permission: 'reporting:read' },
      { label: 'Analytics', to: '/analytics', icon: LineChart, permission: 'reporting:read' },
      { label: 'Risk & Capital', to: '/risk-capital', icon: ShieldCheck, permission: 'risk:read' },
      { label: 'Regulatory', to: '/regulatory', icon: Scale, permission: 'regulatory:read' },
      { label: 'Compliance', to: '/compliance', icon: ShieldCheck, permission: 'regulatory:read' },
      { label: 'Returns', to: '/returns', icon: FileSpreadsheet, permission: 'regulatory:read' },
      { label: 'Workflow', to: '/workflow', icon: Workflow, permission: 'workflow:read' },
      { label: 'Workflow Engine', to: '/workflow-engine', icon: GitBranch, permission: 'workflow:read' },
      { label: 'Delegation', to: '/delegation', icon: GitBranch },
      { label: 'Designer', to: '/designer', icon: Shapes, permission: 'config:read' },
    ],
  },
  {
    label: 'HRMS',
    icon: UserRound,
    items: [
      { label: 'Attendance', to: '/attendance', icon: Clock, permission: 'hr:read' },
      { label: 'People', to: '/hr', icon: UserRound, permission: 'hr:read' },
      { label: 'Payroll', to: '/payroll', icon: Banknote, permission: 'hr:read' },
      { label: 'Performance', to: '/performance', icon: TrendingUp, permission: 'hr:read' },
    ],
  },
  {
    label: 'Corporate',
    icon: Building2,
    items: [
      { label: 'Procurement', to: '/procurement', icon: ShoppingCart, permission: 'procurement:read' },
      { label: 'Assets', to: '/assets', icon: Package, permission: 'asset:read' },
    ],
  },
  {
    label: 'Platform',
    icon: Settings,
    items: [
      { label: 'Operations', to: '/operations', icon: Activity, permission: 'ops:read' },
      { label: 'Tasks & SLA', to: '/tasks', icon: ListChecks, permission: 'ops:read' },
      { label: 'Audit Log', to: '/audit', icon: Fingerprint, permission: 'ops:read' },
      { label: 'Scheduler', to: '/scheduler', icon: CalendarClock, permission: 'ops:read' },
      { label: 'Integration', to: '/integration', icon: Plug, permission: 'integration:read' },
      { label: 'Integration Hub', to: '/integration-hub', icon: Network, permission: 'integration:read' },
      { label: 'Marketplace', to: '/marketplace', icon: Store, permission: 'integration:read' },
      { label: 'Automation Studio', to: '/automation-studio', icon: Bot, permission: 'config:read' },
      { label: 'Messaging', to: '/messaging', icon: Mail, permission: 'integration:read' },
      { label: 'Portal', to: '/portal', icon: PanelsTopLeft, permission: 'portal:read' },
      { label: 'Security', to: '/security', icon: Lock },
      { label: 'Security Ops', to: '/security-ops', icon: Shield, permission: 'ops:read' },
      { label: 'Retention', to: '/retention', icon: Archive, permission: 'retention:read' },
      { label: 'Field Security', to: '/field-security', icon: EyeOff },
      { label: 'Organisation', to: '/organisation', icon: Building2, permission: 'platform:read' },
      { label: 'Org Structure', to: '/organization', icon: Network, permission: 'platform:read' },
      { label: 'Features', to: '/features', icon: Flag, permission: 'platform:read' },
      { label: 'Cost & Capacity', to: '/cost', icon: Gauge, permission: 'cost:read' },
      { label: 'Admin', to: '/admin', icon: Settings, permission: 'admin:manage' },
    ],
  },
];
