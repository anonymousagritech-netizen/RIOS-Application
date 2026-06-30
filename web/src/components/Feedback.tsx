import type { ReactNode } from 'react';
import styles from './Feedback.module.css';

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span
      className={styles.spinner}
      style={{ width: size, height: size, borderWidth: Math.max(2, size / 9) }}
      role="status"
      aria-label="Loading"
    />
  );
}

export function Skeleton({ width, height = 14, radius }: { width?: string | number; height?: number; radius?: number }) {
  return (
    <span
      className={styles.skeleton}
      style={{ width: width ?? '100%', height, borderRadius: radius ?? 5 }}
    />
  );
}

export function PageLoader({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className={styles.pageLoader}>
      <Spinner size={26} />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ title = 'Something went wrong', message, action }: {
  title?: ReactNode; message?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className={styles.error}>
      <div className={styles.errorIcon} aria-hidden>!</div>
      <p className={styles.errorTitle}>{title}</p>
      {message && <p className={styles.errorMsg}>{message}</p>}
      {action}
    </div>
  );
}

export function DefinitionList({ items }: { items: { term: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className={styles.dl}>
      {items.map((it, i) => (
        <div key={i} className={styles.dlRow}>
          <dt className={styles.dt}>{it.term}</dt>
          <dd className={styles.dd}>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className={styles.sectionLabel}>{children}</h3>;
}
