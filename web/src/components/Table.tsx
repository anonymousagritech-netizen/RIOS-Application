import { useMemo, useState, type ReactNode } from 'react';
import styles from './Table.module.css';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number;
  align?: 'left' | 'right' | 'center';
  width?: string;
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  loading?: boolean;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  skeletonRows?: number;
}

export function Table<T>({
  columns, rows, loading = false, rowKey, onRowClick, empty, skeletonRows = 6,
}: TableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);

  const sorted = useMemo(() => {
    if (!rows || !sort) return rows ?? [];
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [rows, sort, columns]);

  const toggleSort = (key: string) => {
    setSort((s) =>
      s?.key === key
        ? s.dir === 'asc' ? { key, dir: 'desc' } : null
        : { key, dir: 'asc' },
    );
  };

  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((col) => {
              const sortable = !!col.sortValue;
              const active = sort?.key === col.key;
              return (
                <th
                  key={col.key}
                  className={`${styles.th} ${styles[col.align ?? 'left']}`}
                  style={col.width ? { width: col.width } : undefined}
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {sortable ? (
                    <button className={styles.sortBtn} onClick={() => toggleSort(col.key)}>
                      {col.header}
                      <span className={styles.sortIcon} aria-hidden>
                        {active ? (sort!.dir === 'asc' ? '↑' : '↓') : '↕'}
                      </span>
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: skeletonRows }).map((_, i) => (
              <tr key={`sk-${i}`} className={styles.skeletonRow}>
                {columns.map((c) => (
                  <td key={c.key} className={styles.td}>
                    <span className={styles.skeleton} />
                  </td>
                ))}
              </tr>
            ))}

          {!loading && sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} className={styles.emptyCell}>
                {empty ?? <EmptyState title="Nothing to show" />}
              </td>
            </tr>
          )}

          {!loading &&
            sorted.map((row) => (
              <tr
                key={rowKey(row)}
                className={onRowClick ? styles.clickable : ''}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => { if (e.key === 'Enter') onRowClick(row); }
                    : undefined
                }
              >
                {columns.map((col) => (
                  <td key={col.key} className={`${styles.td} ${styles[col.align ?? 'left']}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyState({
  title, message, icon, action,
}: { title: ReactNode; message?: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.empty}>
      {icon && <div className={styles.emptyIcon} aria-hidden>{icon}</div>}
      <p className={styles.emptyTitle}>{title}</p>
      {message && <p className={styles.emptyMsg}>{message}</p>}
      {action && <div className={styles.emptyAction}>{action}</div>}
    </div>
  );
}
