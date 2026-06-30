import { useEffect, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { NAV_GROUPS } from './nav';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { AssistantDrawer } from '../assistant/AssistantDrawer';
import styles from './AppShell.module.css';

export function AppShell({ children }: { children: ReactNode }) {
  const { hasPermission } = useAuth();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  // ⌘K / Ctrl-K opens the command palette.
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

  return (
    <div className={styles.layout}>
      <aside className={`${styles.sidebar} ${navOpen ? styles.sidebarOpen : ''}`}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden>R</span>
          <div className={styles.brandText}>
            <strong>RIOS</strong>
            <span>Reinsurance OS</span>
          </div>
        </div>
        <nav className={styles.nav} aria-label="Primary">
          {NAV_GROUPS.map((group) => {
            const items = group.items.filter((i) => !i.permission || hasPermission(i.permission));
            if (!items.length) return null;
            return (
              <div key={group.label} className={styles.navGroup}>
                <span className={styles.navGroupLabel}>{group.label}</span>
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      `${styles.navLink} ${isActive ? styles.navLinkActive : ''}`
                    }
                    onClick={() => setNavOpen(false)}
                  >
                    <span className={styles.navIcon} aria-hidden>{item.icon}</span>
                    {item.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className={styles.sidebarFooter}>
          <button className={styles.assistantBtn} onClick={() => setAssistantOpen(true)}>
            <span className={styles.assistantSpark} aria-hidden>✦</span>
            Ask RIOS Assistant
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
