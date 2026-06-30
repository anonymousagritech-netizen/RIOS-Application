import { colorForStatus } from '../lib/status';
import { titleCase } from '../lib/format';
import styles from './BarChart.module.css';

export interface BarDatum {
  label: string;
  value: number;
  status?: string;
}

interface BarChartProps {
  data: BarDatum[];
  metaColors?: Record<string, string>;
  emptyLabel?: string;
}

const COLOR_VAR: Record<string, string> = {
  green: 'var(--c-green)', blue: 'var(--c-blue)', amber: 'var(--c-amber)',
  violet: 'var(--c-violet)', slate: 'var(--c-slate)', red: 'var(--c-red)',
  teal: 'var(--c-teal)', indigo: 'var(--c-indigo)', orange: 'var(--c-orange)',
  rose: 'var(--c-rose)', gray: 'var(--c-gray)',
};

/** Pure CSS horizontal bar chart - no charting dependency. */
export function BarChart({ data, metaColors, emptyLabel = 'No data yet' }: BarChartProps) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.length) {
    return <p className={styles.empty}>{emptyLabel}</p>;
  }
  return (
    <div className={styles.chart} role="img" aria-label="Bar chart">
      {data.map((d) => {
        const color = COLOR_VAR[colorForStatus(d.status ?? d.label, metaColors)];
        const pct = (d.value / max) * 100;
        return (
          <div key={d.label} className={styles.row}>
            <span className={styles.label}>{titleCase(d.label)}</span>
            <div className={styles.track}>
              <div
                className={styles.bar}
                style={{ width: `${pct}%`, background: color }}
              />
            </div>
            <span className={styles.value}>{d.value}</span>
          </div>
        );
      })}
    </div>
  );
}
