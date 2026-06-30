import type { ReactNode } from 'react';
import { colorForStatus, type TokenColor } from '../lib/status';
import { titleCase } from '../lib/format';
import styles from './Badge.module.css';

interface StatusPillProps {
  status: string | null | undefined;
  metaColors?: Record<string, string>;
  label?: string;
}

/** Coloured pill whose colour derives from code-list meta or status fallback. */
export function StatusPill({ status, metaColors, label }: StatusPillProps) {
  const color = colorForStatus(status, metaColors);
  return (
    <span className={styles.pill} data-color={color}>
      <span className={styles.pillDot} aria-hidden />
      {label ?? titleCase(status) ?? '-'}
    </span>
  );
}

interface BadgeProps {
  children: ReactNode;
  color?: TokenColor;
  variant?: 'soft' | 'outline';
}

export function Badge({ children, color = 'gray', variant = 'soft' }: BadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[variant]}`} data-color={color}>
      {children}
    </span>
  );
}
