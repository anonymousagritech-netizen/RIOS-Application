import { useEffect, useRef, useState } from 'react';
import { Menu, Search, Sparkles, ChevronDown, LogOut } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { initials } from '../lib/format';
import { ThemeToggle } from '../components/ThemeToggle';
import { Button } from '../components/Button';
import { NotificationBell } from '../components/NotificationBell';
import styles from './TopBar.module.css';

interface TopBarProps {
  onOpenPalette: () => void;
  onOpenAssistant: () => void;
  onToggleNav: () => void;
}

export function TopBar({ onOpenPalette, onOpenAssistant, onToggleNav }: TopBarProps) {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

  return (
    <header className={styles.bar}>
      <button className={styles.menuBtn} onClick={onToggleNav} aria-label="Toggle navigation">
        <Menu size={20} />
      </button>

      <button className={styles.search} onClick={onOpenPalette}>
        <Search className={styles.searchIcon} size={16} aria-hidden />
        <span className={styles.searchText}>Search treaties, parties...</span>
        <kbd className={styles.kbd}>{isMac ? '⌘' : 'Ctrl'} K</kbd>
      </button>

      <div className={styles.actions}>
        <Button variant="subtle" size="sm" onClick={onOpenAssistant} icon={<Sparkles size={16} />}>
          Assistant
        </Button>
        <NotificationBell />
        <ThemeToggle />
        <div className={styles.userWrap} ref={menuRef}>
          <button
            className={styles.user}
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className={styles.avatar} aria-hidden>{initials(user?.displayName)}</span>
            <span className={styles.userName}>{user?.displayName}</span>
            <ChevronDown className={styles.chev} size={15} aria-hidden />
          </button>
          {menuOpen && (
            <div className={styles.menu} role="menu">
              <div className={styles.menuHead}>
                <strong>{user?.displayName}</strong>
                <span>{user?.email}</span>
              </div>
              {user?.roles?.length ? (
                <div className={styles.roles}>
                  {user.roles.map((r) => <span key={r} className={styles.roleTag}>{r}</span>)}
                </div>
              ) : null}
              <button className={styles.menuItem} onClick={logout} role="menuitem">
                <LogOut size={15} /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
