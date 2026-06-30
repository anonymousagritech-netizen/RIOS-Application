import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import styles from './Breadcrumbs.module.css';

export interface Crumb { label: string; to?: string; }

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className={styles.nav} aria-label="Breadcrumb">
      <ol className={styles.list}>
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <Fragment key={`${item.label}-${i}`}>
              <li className={styles.item}>
                {item.to && !last ? (
                  <Link to={item.to} className={styles.link}>{item.label}</Link>
                ) : (
                  <span className={last ? styles.current : undefined} aria-current={last ? 'page' : undefined}>
                    {item.label}
                  </span>
                )}
              </li>
              {!last && <li className={styles.sep} aria-hidden>/</li>}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
