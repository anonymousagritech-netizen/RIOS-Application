import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ShieldCheck, Users, Briefcase, CircleDollarSign, PieChart, BarChart3, Database,
  FileText, Share2, Brain, Settings, ArrowRight, Sparkles, ChevronDown, Plus,
  Search as SearchIcon, type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import styles from './LauncherPage.module.css';

interface DomainDef {
  key: string;
  title: string;
  desc: string;
  icon: LucideIcon;
  color: string;         // token suffix, e.g. 'blue' → var(--c-blue)
  to: string;
  permission?: string;   // undefined ⇒ visible to everyone
}

/**
 * Business-domain workspaces surfaced on the launcher. Each opens the relevant
 * workspace/section; visibility is gated by the same permissions the sidebar
 * uses, so a user only ever sees the domains they can access.
 */
const DOMAINS: DomainDef[] = [
  { key: 'underwriting', title: 'Underwriting', desc: 'Manage submissions, treaties, facultative, pricing and approvals.', icon: ShieldCheck, color: 'blue', to: '/w/underwriting', permission: 'treaty:read' },
  { key: 'distribution', title: 'Distribution', desc: 'Manage clients, brokers, cedents and business relationships.', icon: Users, color: 'teal', to: '/parties', permission: 'party:read' },
  { key: 'operations', title: 'Operations', desc: 'Claims, bordereaux, recoveries, tasks, workflow and notifications.', icon: Briefcase, color: 'violet', to: '/claims', permission: 'claims:read' },
  { key: 'finance', title: 'Finance', desc: 'Accounting, statements, treasury, period close and procurement.', icon: CircleDollarSign, color: 'amber', to: '/accounting', permission: 'accounting:read' },
  { key: 'portfolio', title: 'Portfolio', desc: 'Portfolio overview, performance, exposure and accumulation.', icon: PieChart, color: 'indigo', to: '/w/capacity-exposure', permission: 'exposure:read' },
  { key: 'analytics', title: 'Analytics & Compliance', desc: 'Reports, analytics, risk & capital, regulatory and compliance.', icon: BarChart3, color: 'blue', to: '/reports', permission: 'reporting:read' },
  { key: 'masterdata', title: 'Master Data', desc: 'Products, clauses, perils, countries, currencies and reference data.', icon: Database, color: 'teal', to: '/products', permission: 'product:read' },
  { key: 'documents', title: 'Documents & Knowledge', desc: 'Document repository, templates, knowledge base and libraries.', icon: FileText, color: 'blue', to: '/documents', permission: 'documents:read' },
  { key: 'hrms', title: 'HRMS', desc: 'People, attendance, payroll, performance and organization.', icon: Users, color: 'rose', to: '/hr', permission: 'hr:read' },
  { key: 'integration', title: 'Integration & Automation', desc: 'Integrations, marketplace, automation studio and scheduler.', icon: Share2, color: 'orange', to: '/w/integration', permission: 'integration:read' },
  { key: 'ai', title: 'AI Workspace', desc: 'AI insights, recommendations, summaries and assistant.', icon: Brain, color: 'teal', to: '/ai-insights' },
  { key: 'admin', title: 'Administration', desc: 'Users, roles, security, legal entities and system configuration.', icon: Settings, color: 'slate', to: '/admin', permission: 'admin:manage' },
];

const QUICK_ACTIONS: { label: string; to: string; icon: LucideIcon }[] = [
  { label: 'New treaty', to: '/treaties', icon: Plus },
  { label: 'New facultative risk', to: '/facultative', icon: Plus },
  { label: 'New claim', to: '/claims', icon: Plus },
  { label: 'Global search', to: '/search', icon: SearchIcon },
  { label: 'AI insights', to: '/ai-insights', icon: Sparkles },
];

export function LauncherPage() {
  const { user, hasPermission } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  const unread = useQuery({
    queryKey: ['launcher-unread'],
    queryFn: () => api<{ count: number }>('notifications/unread-count').catch(() => ({ count: 0 })),
    staleTime: 60_000,
  });

  const domains = useMemo(
    () => DOMAINS.filter((d) => !d.permission || hasPermission(d.permission)),
    [hasPermission],
  );

  const firstName = (user?.displayName ?? user?.email ?? 'there').split(/[ @]/)[0];

  return (
    <div className={styles.launcher}>
      <header className={styles.head}>
        <div>
          <h1 className={styles.greeting}>{greeting()}, {firstName} <span className={styles.wave}>👋</span></h1>
          <p className={styles.sub}>Access all modules and insights from your unified reinsurance platform.</p>
        </div>
        <div className={styles.headActions}>
          <Link to="/features" className={styles.ghostBtn}><Settings size={16} /> Customize</Link>
          <div className={styles.qaWrap}>
            <button className={styles.primaryBtn} onClick={() => setMenuOpen((v) => !v)} aria-expanded={menuOpen}>
              <Sparkles size={16} /> Quick Actions <ChevronDown size={15} />
            </button>
            {menuOpen && (
              <>
                <div className={styles.qaBackdrop} onClick={() => setMenuOpen(false)} />
                <div className={styles.qaMenu} role="menu">
                  {QUICK_ACTIONS.map((a) => {
                    const Icon = a.icon;
                    return (
                      <Link key={a.label} to={a.to} className={styles.qaItem} role="menuitem" onClick={() => setMenuOpen(false)}>
                        <Icon size={15} /> {a.label}
                      </Link>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <section className={styles.grid} aria-label="Workspaces">
        {domains.map((d) => {
          const Icon = d.icon;
          const badge = d.key === 'operations' ? (unread.data?.count ?? 0) : 0;
          return (
            <Link key={d.key} to={d.to} className={styles.card} style={tint(d.color)}>
              <div className={styles.cardTop}>
                <span className={styles.iconTile}><Icon size={24} strokeWidth={1.9} /></span>
                {badge > 0 && <span className={styles.badge}>{badge}</span>}
              </div>
              <h2 className={styles.cardTitle}>{d.title}</h2>
              <p className={styles.cardDesc}>{d.desc}</p>
              <span className={styles.open}>Open Workspace <ArrowRight size={15} /></span>
            </Link>
          );
        })}
      </section>

      <footer className={styles.footer}>
        <span>Reinsurance Intelligent OS</span>
        <span className={styles.footRight}>
          <span>Version 2.0.0</span>
          <span className={styles.status}><span className={styles.dot} /> System Operational</span>
        </span>
      </footer>
    </div>
  );
}

/** Soft per-domain accent tint driven by the shared colour tokens. */
function tint(color: string): React.CSSProperties {
  return { '--tile': `var(--c-${color})` } as React.CSSProperties;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
