import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, PanelLeftClose, PanelLeftOpen, Sparkles } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { NAV_GROUPS } from './nav';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { AssistantDrawer } from '../assistant/AssistantDrawer';
import styles from './AppShell.module.css';

const COLLAPSE_KEY = 'rios.nav.collapsed';

export function AppShell({ children }: { children: ReactNode }) {
  const { hasPermission } = useAuth();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSE_KEY) === '1',
  );

  // Groups the current user is allowed to see (permission-filtered).
  const groups = useMemo(
    () =>
      NAV_GROUPS.map((g) => ({
        ...g,
        items: g.items.filter((i) => !i.permission || hasPermission(i.permission)),
      })).filter((g) => g.items.length > 0),
    [hasPermission],
  );

  const activeGroup = useMemo(
    () => groups.find((g) => g.items.some((i) => location.pathname.startsWith(i.to)))?.label,
    [groups, location.pathname],
  );

  // Accordion state: the group holding the active route opens automatically.
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (activeGroup) setOpenGroups((s) => (s.has(activeGroup) ? s : new Set(s).add(activeGroup)));
  }, [activeGroup]);

  const toggleGroup = (label: string) =>
    setOpenGroups((s) => {
      const next = new Set(s);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  const setCollapsedPersist = (v: boolean) => {
    setCollapsed(v);
    try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  };

  // Cmd/Ctrl-K opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  return (
    <div className={`${styles.layout} ${collapsed ? styles.collapsed : ''}`}>
      <aside className={`${styles.sidebar} ${navOpen ? styles.sidebarOpen : ''}`}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden>R</span>
          {!collapsed && (
            <div className={styles.brandText}>
              <strong>RIOS</strong>
              <span>Reinsurance OS</span>
            </div>
          )}
          <button
            className={styles.collapseBtn}
            onClick={() => setCollapsedPersist(!collapsed)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>

        <nav className={styles.nav} aria-label="Primary">
          {groups.map((group) => {
            const open = collapsed || openGroups.has(group.label);
            const isActiveGroup = group.label === activeGroup;
            return (
              <div key={group.label} className={styles.navGroup}>
                {collapsed ? (
                  <span className={styles.collapsedDivider} aria-hidden />
                ) : (
                  <button
                    type="button"
                    className={`${styles.groupHeader} ${isActiveGroup ? styles.groupHeaderActive : ''}`}
                    onClick={() => toggleGroup(group.label)}
                    aria-expanded={open}
                  >
                    <group.icon className={styles.groupIcon} size={16} />
                    <span className={styles.groupLabel}>{group.label}</span>
                    <ChevronDown
                      className={`${styles.groupChevron} ${open ? styles.groupChevronOpen : ''}`}
                      size={15}
                    />
                  </button>
                )}

                <div className={`${styles.groupItems} ${open ? styles.groupItemsOpen : ''}`}>
                  <div className={styles.groupItemsInner}>
                    {group.items.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        title={collapsed ? item.label : undefined}
                        className={({ isActive }) =>
                          `${styles.navLink} ${isActive ? styles.navLinkActive : ''}`
                        }
                      >
                        <span className={styles.navIcon} aria-hidden>
                          <item.icon size={18} strokeWidth={2} />
                        </span>
                        <span className={styles.navLabel}>{item.label}</span>
                      </NavLink>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </nav>

        <div className={styles.sidebarFooter}>
          <button
            className={styles.assistantBtn}
            onClick={() => setAssistantOpen(true)}
            title="Ask RIOS Assistant"
          >
            <Sparkles size={18} className={styles.assistantSpark} />
            {!collapsed && <span>Ask RIOS Assistant</span>}
          </button>
        </div>
      </aside>

      {navOpen && <div className={styles.scrim} onClick={() => setNavOpen(false)} aria-hidden />}

      <div className={styles.main}>
        <TopBar
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenAssistant={() => setAssistantOpen(true)}
          onToggleNav={() => setNavOpen((o) => !o)}
        />
        <main className={styles.content}>
          <div className={styles.contentInner}>{children}</div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <AssistantDrawer open={assistantOpen} onClose={() => setAssistantOpen(false)} />
    </div>
  );
}
