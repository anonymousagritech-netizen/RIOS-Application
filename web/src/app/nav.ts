import {
  LayoutDashboard, TrendingUp, Sparkles, Brain, Search, Smartphone,
  Gavel, FileText, FileCheck2, PenLine, Calculator, Radar, Globe2, ArrowLeftRight, SlidersHorizontal,
  Users, Contact, Briefcase, Building2, Handshake,
  ShieldAlert, Grid2x2, Undo2, ListChecks, Workflow, Fingerprint,
  BookOpen, ReceiptText, Wallet, PiggyBank, CalendarCheck, ShoppingCart,
  BarChart3, CalendarClock, LineChart, ShieldCheck, Scale, ClipboardCheck, FileSpreadsheet,
  Clock, UserRound, Banknote, Award, Package, Network,
  Boxes, Database, FolderOpen, Library,
  Plug, Mail, Bot, PanelsTopLeft, Radio,
  Settings, Activity, GitBranch, Lock, Shield, EyeOff, Archive, Gauge, Flag,
  FunctionSquare,
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

/**
 * Sidebar information architecture, organised by business workflow.
 *
 * Related pages are consolidated into tabbed *workspaces* (routes under `/w/*`,
 * see pages/workspaces) so each business process is one sidebar entry rather
 * than many. The underlying pages keep their own routes and remain fully
 * functional — they are simply reached through the workspace. Every concept
 * appears exactly once here; do not duplicate a route across groups.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    icon: LayoutDashboard,
    items: [
      { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
      { label: 'Executive', to: '/executive', icon: TrendingUp, permission: 'reporting:read' },
      { label: 'Intelligence', to: '/intelligence', icon: Sparkles },
      { label: 'AI Insights', to: '/ai-insights', icon: Brain },
      { label: 'Search', to: '/search', icon: Search },
      { label: 'Mobile', to: '/mobile', icon: Smartphone },
    ],
  },
  {
    label: 'Underwriting',
    icon: Gavel,
    items: [
      { label: 'Underwriting Workspace', to: '/w/underwriting', icon: Gavel, permission: 'treaty:read' },
      { label: 'Treaty Workspace', to: '/w/treaty', icon: FileText, permission: 'treaty:read' },
      { label: 'Facultative Workspace', to: '/w/facultative', icon: FileCheck2, permission: 'facultative:read' },
      { label: 'Placement', to: '/placement', icon: PenLine, permission: 'placement:read' },
      { label: 'Pricing', to: '/pricing', icon: Calculator, permission: 'pricing:read' },
      { label: 'Capacity & Exposure', to: '/w/capacity-exposure', icon: Radar, permission: 'exposure:read' },
      { label: 'Territory Workspace', to: '/w/territory', icon: Globe2, permission: 'exposure:read' },
      { label: 'Retrocession', to: '/retrocession', icon: ArrowLeftRight, permission: 'retro:read' },
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
      { label: 'CRM', to: '/crm', icon: Handshake, permission: 'crm:read' },
    ],
  },
  {
    label: 'Operations',
    icon: ShieldAlert,
    items: [
      { label: 'Claims', to: '/claims', icon: ShieldAlert, permission: 'claims:read' },
      { label: 'Bordereaux', to: '/bordereaux', icon: Grid2x2, permission: 'bordereaux:read' },
      { label: 'Recoveries', to: '/recoveries', icon: Undo2, permission: 'claims:read' },
      { label: 'Operations Center', to: '/w/operations', icon: ListChecks, permission: 'ops:read' },
      { label: 'Workflow Center', to: '/w/workflow', icon: Workflow, permission: 'workflow:read' },
      { label: 'Audit Log', to: '/audit', icon: Fingerprint, permission: 'ops:read' },
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
      { label: 'Bureau / ACORD', to: '/bureau', icon: Radio, permission: 'accounting:read' },
      { label: 'Procurement', to: '/procurement', icon: ShoppingCart, permission: 'procurement:read' },
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
      { label: 'Cat Model / ELT', to: '/cat-model', icon: Radar, permission: 'exposure:read' },
      { label: 'Regulatory', to: '/regulatory', icon: Scale, permission: 'regulatory:read' },
      { label: 'Compliance', to: '/compliance', icon: ClipboardCheck, permission: 'regulatory:read' },
      { label: 'Sanctions', to: '/sanctions', icon: ShieldAlert, permission: 'party:read' },
      { label: 'Returns', to: '/returns', icon: FileSpreadsheet, permission: 'regulatory:read' },
    ],
  },
  {
    label: 'HRMS',
    icon: UserRound,
    items: [
      { label: 'Attendance', to: '/attendance', icon: Clock, permission: 'hr:read' },
      { label: 'People', to: '/hr', icon: UserRound, permission: 'hr:read' },
      { label: 'Payroll', to: '/payroll', icon: Banknote, permission: 'hr:read' },
      { label: 'Performance', to: '/performance', icon: Award, permission: 'hr:read' },
      { label: 'Assets', to: '/assets', icon: Package, permission: 'asset:read' },
      { label: 'Org Structure', to: '/organization', icon: Network, permission: 'platform:read' },
    ],
  },
  {
    label: 'Master Data',
    icon: Database,
    items: [
      { label: 'Products', to: '/products', icon: Boxes, permission: 'product:read' },
    ],
  },
  {
    label: 'Documents & Knowledge',
    icon: Library,
    items: [
      { label: 'Documents', to: '/documents', icon: FolderOpen, permission: 'documents:read' },
    ],
  },
  {
    label: 'Integration & Automation',
    icon: Plug,
    items: [
      { label: 'Integration Hub', to: '/w/integration', icon: Plug, permission: 'integration:read' },
      { label: 'Messaging', to: '/messaging', icon: Mail, permission: 'integration:read' },
      { label: 'Automation Studio', to: '/w/automation', icon: Bot, permission: 'config:read' },
      { label: 'Portal', to: '/portal', icon: PanelsTopLeft, permission: 'portal:read' },
    ],
  },
  {
    label: 'Administration',
    icon: Settings,
    items: [
      { label: 'Admin', to: '/admin', icon: Settings, permission: 'admin:manage' },
      { label: 'Formula Engine', to: '/formulas', icon: FunctionSquare },
      { label: 'Legal Entities', to: '/organisation', icon: Building2, permission: 'platform:read' },
      { label: 'Ops Console', to: '/operations', icon: Activity, permission: 'ops:read' },
      { label: 'Delegation', to: '/delegation', icon: GitBranch },
      { label: 'Security', to: '/security', icon: Lock },
      { label: 'Security Ops', to: '/security-ops', icon: Shield, permission: 'ops:read' },
      { label: 'Field Security', to: '/field-security', icon: EyeOff },
      { label: 'Retention', to: '/retention', icon: Archive, permission: 'retention:read' },
      { label: 'Cost Management', to: '/cost', icon: Gauge, permission: 'cost:read' },
      { label: 'Features', to: '/features', icon: Flag, permission: 'platform:read' },
    ],
  },
];
