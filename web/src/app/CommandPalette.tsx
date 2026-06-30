import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, LayoutDashboard, FileText, Users, ShieldAlert, BookOpen, Settings } from 'lucide-react';
import { api, qs } from '../lib/api';
import type { TreatiesResponse, PartiesResponse } from '../lib/types';
import styles from './CommandPalette.module.css';

interface Item {
  id: string;
  label: string;
  sublabel?: string;
  group: string;
  to: string;
  icon: ReactNode;
}

const NAV_ITEMS: Item[] = [
  { id: 'nav-dashboard', label: 'Dashboard', group: 'Navigate', to: '/dashboard', icon: <LayoutDashboard size={16} /> },
  { id: 'nav-treaties', label: 'Treaties', group: 'Navigate', to: '/treaties', icon: <FileText size={16} /> },
  { id: 'nav-parties', label: 'Parties', group: 'Navigate', to: '/parties', icon: <Users size={16} /> },
  { id: 'nav-claims', label: 'Claims', group: 'Navigate', to: '/claims', icon: <ShieldAlert size={16} /> },
  { id: 'nav-accounting', label: 'Accounting', group: 'Navigate', to: '/accounting', icon: <BookOpen size={16} /> },
  { id: 'nav-admin', label: 'Admin', group: 'Navigate', to: '/admin', icon: <Settings size={16} /> },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const trimmed = query.trim();

  const treatySearch = useQuery({
    queryKey: ['palette-treaties', trimmed],
    queryFn: () => api<TreatiesResponse>(`/api/treaties${qs({})}`),
    enabled: open && trimmed.length >= 1,
    staleTime: 30_000,
  });
  const partySearch = useQuery({
    queryKey: ['palette-parties', trimmed],
    queryFn: () => api<PartiesResponse>(`/api/parties${qs({ q: trimmed })}`),
    enabled: open && trimmed.length >= 1,
    staleTime: 30_000,
  });

  const items = useMemo<Item[]>(() => {
    const q = trimmed.toLowerCase();
    const nav = NAV_ITEMS.filter((i) => !q || i.label.toLowerCase().includes(q));
    const treaties: Item[] = (treatySearch.data?.treaties ?? [])
      .filter((t) =>
        !q ||
        t.name.toLowerCase().includes(q) ||
        t.reference?.toLowerCase().includes(q) ||
        t.cedentName?.toLowerCase().includes(q))
      .slice(0, 6)
      .map((t) => ({
        id: `treaty-${t.id}`,
        label: t.name,
        sublabel: `${t.reference} · ${t.cedentName ?? t.contractKind}`,
        group: 'Treaties',
        to: `/treaties/${t.id}`,
        icon: <FileText size={16} />,
      }));
    const parties: Item[] = (partySearch.data?.parties ?? [])
      .slice(0, 6)
      .map((p) => ({
        id: `party-${p.id}`,
        label: p.legalName,
        sublabel: `${p.reference ?? ''} · ${p.kind}`,
        group: 'Parties',
        to: `/parties/${p.id}`,
        icon: <Users size={16} />,
      }));
    return [...nav, ...treaties, ...parties];
  }, [trimmed, treatySearch.data, partySearch.data]);

  useEffect(() => { setActive(0); }, [items.length]);

  if (!open) return null;

  const go = (item: Item) => {
    navigate(item.to);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[active]) go(items[active]!); }
    else if (e.key === 'Escape') { onClose(); }
  };

  // Group items preserving order.
  const groups: { group: string; items: Item[] }[] = [];
  for (const it of items) {
    let g = groups.find((x) => x.group === it.group);
    if (!g) { g = { group: it.group, items: [] }; groups.push(g); }
    g.items.push(it);
  }

  return createPortal(
    <div className={styles.overlay} onMouseDown={onClose}>
      <div className={styles.panel} role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.searchRow}>
          <Search className={styles.icon} size={18} aria-hidden />
          <input
            ref={inputRef}
            className={styles.input}
            placeholder="Jump to a page, or search treaties and parties…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Search"
          />
        </div>
        <div className={styles.results}>
          {items.length === 0 && (
            <p className={styles.empty}>No matches{trimmed ? ` for “${trimmed}”` : ''}.</p>
          )}
          {groups.map((g) => (
            <div key={g.group} className={styles.group}>
              <div className={styles.groupLabel}>{g.group}</div>
              {g.items.map((it) => {
                const idx = items.indexOf(it);
                return (
                  <button
                    key={it.id}
                    className={`${styles.item} ${idx === active ? styles.itemActive : ''}`}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => go(it)}
                  >
                    <span className={styles.itemIcon} aria-hidden>{it.icon}</span>
                    <span className={styles.itemText}>
                      <span className={styles.itemLabel}>{it.label}</span>
                      {it.sublabel && <span className={styles.itemSub}>{it.sublabel}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className={styles.footer}>
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
