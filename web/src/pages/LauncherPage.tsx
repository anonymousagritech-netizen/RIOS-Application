import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Search, Brain, Bell, LayoutDashboard } from 'lucide-react';
import { NAV_GROUPS, type NavGroup } from '../app/nav';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import styles from './LauncherPage.module.css';

/** One-line description per business domain (keyed by nav group label). */
const DOMAIN_BLURB: Record<string, string> = {
  'Overview': 'Dashboards, the executive view, AI insights and global search.',
  'Underwriting': 'Treaty & facultative underwriting, pricing, capacity and exposure.',
  'Distribution': 'Parties, brokers, cedents, clients and the CRM.',
  'Operations': 'Claims, bordereaux, recoveries, tasks and workflows.',
  'Finance': 'Accounting, statements, treasury, period close and procurement.',
  'Analytics & Compliance': 'Reports, analytics, risk & capital, regulatory and compliance.',
  'HRMS': 'People, attendance, payroll, performance and the org structure.',
  'Master Data': 'Products and the reference data that configures the platform.',
  'Documents & Knowledge': 'The central document repository and knowledge hub.',
  'Integration & Automation': 'Integrations, messaging, automation studio and the portal.',
  'Administration': 'Users, security, delegation, cost and system configuration.',
};

interface DomainCard {
  group: NavGroup;
  to: string;
  toolCount: number;
}

export function LauncherPage() {
  const { user, hasPermission } = useAuth();

  // Live badge: unread notifications surface on the Operations domain.
  const unread = useQuery({
    queryKey: ['launcher-unread'],
    queryFn: () => api<{ count: number }>('notifications/unread-count').catch(() => ({ count: 0 })),
    staleTime: 60_000,
  });

  // Role-filtered domains: show a domain only if the user can reach ≥1 of its tools.
  const domains = useMemo<DomainCard[]>(() => {
    return NAV_GROUPS.map((group) => {
      // Exclude the launcher's own "Home" entry so the Overview card doesn't self-link.
      const items = group.items.filter((i) => i.to !== '/home' && (!i.permission || hasPermission(i.permission)));
      return { group, items };
    })
      .filter((d) => d.items.length > 0)
      .map(({ group, items }) => ({ group, to: items[0]!.to, toolCount: items.length }));
  }, [hasPermission]);

  const firstName = (user?.displayName ?? user?.email ?? 'there').split(/[ @]/)[0];
  const greet = greeting();

  return (
    <div className={styles.launcher}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>ReNexis · Reinsurance Intelligent Operating System</p>
        <h1 className={styles.greeting}>{greet}, {firstName}.</h1>
        <p className={styles.sub}>Choose a workspace to get started. You only see the domains you're authorised for.</p>

        <div className={styles.quick}>
          <Link to="/dashboard" className={styles.quickLink}><LayoutDashboard size={16} /> Dashboard</Link>
          <Link to="/search" className={styles.quickLink}><Search size={16} /> Search</Link>
          <Link to="/ai-insights" className={styles.quickLink}><Brain size={16} /> AI Insights</Link>
          <Link to="/notifications" className={styles.quickLink}>
            <Bell size={16} /> Notifications
            {(unread.data?.count ?? 0) > 0 && <span className={styles.quickBadge}>{unread.data!.count}</span>}
          </Link>
        </div>
      </header>

      <section className={styles.grid} aria-label="Business workspaces">
        {domains.map(({ group, to, toolCount }) => {
          const Icon = group.icon;
          const showBadge = group.label === 'Operations' && (unread.data?.count ?? 0) > 0;
          return (
            <Link key={group.label} to={to} className={styles.card}>
              <div className={styles.cardTop}>
                <span className={styles.iconTile}><Icon size={22} strokeWidth={1.9} /></span>
                {showBadge && <span className={styles.badge}>{unread.data!.count}</span>}
              </div>
              <h2 className={styles.cardTitle}>{group.label}</h2>
              <p className={styles.cardBlurb}>{DOMAIN_BLURB[group.label] ?? `${toolCount} tools in this workspace.`}</p>
              <div className={styles.cardFoot}>
                <span className={styles.count}>{toolCount} {toolCount === 1 ? 'workspace' : 'workspaces'}</span>
                <span className={styles.open}>Open <ArrowRight size={15} /></span>
              </div>
            </Link>
          );
        })}
      </section>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
