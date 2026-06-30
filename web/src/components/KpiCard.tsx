import type { ReactNode, CSSProperties } from 'react';
import styles from './KpiCard.module.css';

interface KpiCardProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  loading?: boolean;
  accent?: string;
}

export function KpiCard({ label, value, hint, icon, loading, accent }: KpiCardProps) {
  const accentVar = accent ? ({ '--kpi-accent': accent } as CSSProperties) : undefined;
  return (
    <div className={styles.card} style={accentVar}>
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
