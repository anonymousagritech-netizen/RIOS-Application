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
      { label: 'Treaties', to: '/treaties', icon: '▤' },
      { label: 'Parties', to: '/parties', icon: '◎' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Claims', to: '/claims', icon: '◬' },
      { label: 'Accounting', to: '/accounting', icon: '$' },
    ],
  },
  {
    label: 'Settings',
    items: [{ label: 'Admin', to: '/admin', icon: '⚙', permission: 'admin:manage' }],
  },
];
