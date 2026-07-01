import { Suspense, type ComponentType } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { PageLoader } from '../../components/Feedback';
import styles from './Workspace.module.css';

export interface WorkspaceTab {
  id: string;
  label: string;
  component: ComponentType;
}

interface WorkspaceProps {
  title: string;
  subtitle?: string;
  tabs: WorkspaceTab[];
}

/**
 * Enterprise workspace shell. Composes several existing pages into one tabbed
 * surface so related functionality lives together in the sidebar as a single
 * item, without removing any underlying page/route. The active tab is stored in
 * the `?tab=` query param (other params preserved), so tabs are deep-linkable.
 */
export function Workspace({ title, subtitle, tabs }: WorkspaceProps) {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const current = tabs.find((t) => t.id === requested) ?? tabs[0];
  if (!current) return null;
  const Active = current.component;

  const select = (id: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', id);
      return next;
    }, { replace: true });
  };

  return (
    <div className={styles.workspace}>
      <div className={styles.head}>
        <Breadcrumbs items={[{ label: 'Home', to: '/dashboard' }, { label: title }]} />
        <h1 className={styles.title}>{title}</h1>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>

      <div className={styles.tabstrip} role="tablist" aria-label={`${title} sections`}>
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === current.id}
            className={`${styles.tab} ${t.id === current.id ? styles.active : ''}`}
            onClick={() => select(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={styles.body}>
        {/* Tab pages are code-split; keep the loading state local to the tab body. */}
        <Suspense fallback={<PageLoader label="Loading…" />}>
          <Active />
        </Suspense>
      </div>
    </div>
  );
}
