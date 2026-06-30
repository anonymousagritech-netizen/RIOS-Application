export interface NavItem {
  label: string;
  to: string;
  icon: string;
  permission?: string;
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ label: 'Dashboard', to: '/dashboard', icon: '◧' }],
  },
  {
    label: 'Underwriting',
    items: [
      { label: 'Treaties', to: '/treaties', icon: '▤', permission: 'treaty:read' },
      { label: 'Facultative', to: '/facultative', icon: '◆', permission: 'facultative:read' },
      { label: 'Retrocession', to: '/retrocession', icon: '⇄', permission: 'retro:read' },
      { label: 'Placement', to: '/placement', icon: '✎', permission: 'placement:read' },
      { label: 'Pricing', to: '/pricing', icon: '⊿', permission: 'pricing:read' },
      { label: 'Parties', to: '/parties', icon: '◎', permission: 'party:read' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Claims', to: '/claims', icon: '◬', permission: 'claims:read' },
      { label: 'Bordereaux', to: '/bordereaux', icon: '▦', permission: 'bordereaux:read' },
      { label: 'Exposure', to: '/exposure', icon: '◴', permission: 'exposure:read' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { label: 'Accounting', to: '/accounting', icon: '$', permission: 'accounting:read' },
      { label: 'Statements', to: '/statements', icon: '▥', permission: 'statement:read' },
      { label: 'Finance', to: '/finance', icon: '▣', permission: 'finance:read' },
    ],
  },
  {
    label: 'Risk & Compliance',
    items: [
      { label: 'Regulatory', to: '/regulatory', icon: '§', permission: 'regulatory:read' },
      { label: 'Workflow', to: '/workflow', icon: '◉', permission: 'workflow:read' },
    ],
  },
  {
    label: 'Settings',
    items: [{ label: 'Admin', to: '/admin', icon: '⚙', permission: 'admin:manage' }],
  },
];
