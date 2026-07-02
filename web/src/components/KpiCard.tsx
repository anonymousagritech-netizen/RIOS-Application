import type { ReactNode, CSSProperties } from 'react';
import styles from './KpiCard.module.css';

interface KpiCardProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  loading?: boolean;
  accent?: string;
  /** When set, the card becomes a clickable drill-through to a filtered list. */
  onClick?: () => void;
}

export function KpiCard({ label, value, hint, icon, loading, accent, onClick }: KpiCardProps) {
  const accentVar = accent ? ({ '--kpi-accent': accent } as CSSProperties) : undefined;
  const clickable = !!onClick;
  return (
    <div
      className={`${styles.card} ${clickable ? styles.clickable : ''}`}
      style={accentVar}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
    >
      <span className={styles.accentBar} aria-hidden />
      <div className={styles.top}>
        <span className={styles.label}>{label}</span>
        {icon && (
          <span className={styles.icon} style={accent ? { color: accent } : undefined} aria-hidden>
            {icon}
          </span>
        )}
      </div>
      {loading ? (
        <span className={styles.skeleton} />
      ) : (
        <span className={styles.value}>{value}</span>
      )}
      {hint && !loading && <span className={styles.hint}>{hint}</span>}
    </div>
  );
}
