import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronsLeft, PanelLeftOpen, Sparkles } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { NAV_GROUPS } from './nav';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { AssistantDrawer } from '../assistant/AssistantDrawer';
import { VoiceFab } from '../assistant/VoiceFab';
import styles from './AppShell.module.css';

const COLLAPSE_KEY = 'rios.nav.collapsed';

export function AppShell({ children }: { children: ReactNode }) {
  const { hasPermission } = useAuth();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSE_KEY) === '1',
  );

  const groups = useMemo(
    () =>
      NAV_GROUPS.map((g) => ({
        ...g,
        items: g.items.filter((i) => !i.permission || hasPermission(i.permission)),
      })).filter((g) => g.items.length > 0),
    [hasPermission],
  );

  // A nav link whose path is a prefix of another link's path (e.g. /underwriting
  // vs /underwriting/analytics) must match exactly, or React Router would flag
  // both as active on the child route. Links with no such sibling keep prefix
  // matching so a parent still highlights on its detail pages (/treaties/:id).
  const exactPaths = useMemo(() => {
    const all = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.to));
    return new Set(all.filter((to) => all.some((other) => other !== to && other.startsWith(`${to}/`))));
  }, []);

  // Sections are open by default; users can collapse individual ones.
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const toggleGroup = (label: string) =>
    setClosed((s) => {
      const next = new Set(s);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  const setCollapsedPersist = (v: boolean) => {
    setCollapsed(v);
    try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  };

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

  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  return (
    <div className={`${styles.layout} ${collapsed ? styles.collapsed : ''}`}>
      <aside className={`${styles.sidebar} ${navOpen ? styles.sidebarOpen : ''}`}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden>R</span>
          {!collapsed && (
            <div className={styles.brandText}>
              <strong>RIOS</strong>
              <span>Reinsurance Intelligent OS</span>
            </div>
          )}
        </div>

        <nav className={styles.nav} aria-label="Primary">
          {groups.map((group) => {
            const open = collapsed || !closed.has(group.label);
            return (
              <div key={group.label} className={styles.navGroup}>
                {collapsed ? (
                  <span className={styles.groupRule} aria-hidden />
                ) : (
                  <button
                    type="button"
                    className={styles.caption}
                    onClick={() => toggleGroup(group.label)}
                    aria-expanded={open}
                  >
                    <span>{group.label}</span>
                    <ChevronDown
                      className={`${styles.captionChevron} ${open ? '' : styles.captionChevronClosed}`}
                      size={14}
                    />
                  </button>
                )}
                <div className={`${styles.items} ${open ? styles.itemsOpen : ''}`}>
                  <div className={styles.itemsInner}>
                    {group.items.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        end={exactPaths.has(item.to)}
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
          <button
            className={styles.collapseBtn}
            onClick={() => setCollapsedPersist(!collapsed)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <ChevronsLeft size={18} />}
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

      <VoiceFab
        hidden={assistantOpen}
        onClick={() => { setVoiceMode(true); setAssistantOpen(true); }}
      />

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <AssistantDrawer
        open={assistantOpen}
        autoVoice={voiceMode}
        onClose={() => { setAssistantOpen(false); setVoiceMode(false); }}
      />
    </div>
  );
}
