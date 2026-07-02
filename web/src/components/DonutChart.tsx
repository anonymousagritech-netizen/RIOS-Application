import { colorForStatus } from '../lib/status';
import { titleCase } from '../lib/format';
import styles from './DonutChart.module.css';

export interface DonutDatum {
  label: string;
  value: number;
  status?: string;
}

interface DonutChartProps {
  data: DonutDatum[];
  metaColors?: Record<string, string>;
  centerLabel?: string;
  centerValue?: string;
  emptyLabel?: string;
  /** When set, segments and legend rows become drill-through links. */
  onSegmentClick?: (datum: DonutDatum) => void;
}

const COLOR_VAR: Record<string, string> = {
  green: 'var(--c-green)', blue: 'var(--c-blue)', amber: 'var(--c-amber)',
  violet: 'var(--c-violet)', slate: 'var(--c-slate)', red: 'var(--c-red)',
  teal: 'var(--c-teal)', indigo: 'var(--c-indigo)', orange: 'var(--c-orange)',
  rose: 'var(--c-rose)', gray: 'var(--c-gray)',
};

/** Dependency-free SVG donut chart with a legend. */
export function DonutChart({ data, metaColors, centerLabel, centerValue, emptyLabel = 'No data yet', onSegmentClick }: DonutChartProps) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (!data.length || total === 0) {
    return <p className={styles.empty}>{emptyLabel}</p>;
  }

  const R = 56;
  const STROKE = 18;
  const C = 2 * Math.PI * R;
  let offset = 0;

  const segments = data.map((d) => {
    const frac = d.value / total;
    const color = COLOR_VAR[colorForStatus(d.status ?? d.label, metaColors)];
    const seg = {
      key: d.label,
      color,
      dash: frac * C,
      gap: C - frac * C,
      rotation: (offset / total) * 360,
    };
    offset += d.value;
    return seg;
  });

  return (
    <div className={styles.wrap}>
      <div className={styles.chart}>
        <svg viewBox="0 0 140 140" className={styles.svg} role="img" aria-label="Donut chart">
          <circle cx="70" cy="70" r={R} fill="none" stroke="var(--surface-3)" strokeWidth={STROKE} />
          {segments.map((s, i) => (
            <circle
              key={s.key}
              cx="70" cy="70" r={R}
              fill="none"
              stroke={s.color}
              strokeWidth={STROKE}
              strokeDasharray={`${s.dash} ${s.gap}`}
              strokeDashoffset={0}
              transform={`rotate(${s.rotation - 90} 70 70)`}
              strokeLinecap="butt"
              style={onSegmentClick ? { cursor: 'pointer' } : undefined}
              onClick={onSegmentClick ? () => onSegmentClick(data[i]!) : undefined}
            />
          ))}
        </svg>
        <div className={styles.center}>
          <span className={styles.centerValue}>{centerValue ?? total}</span>
          {centerLabel && <span className={styles.centerLabel}>{centerLabel}</span>}
        </div>
      </div>
      <ul className={styles.legend}>
        {data.map((d) => {
          const color = COLOR_VAR[colorForStatus(d.status ?? d.label, metaColors)];
          const pct = Math.round((d.value / total) * 100);
          return (
            <li
              key={d.label}
              className={onSegmentClick ? styles.clickable : undefined}
              onClick={onSegmentClick ? () => onSegmentClick(d) : undefined}
              role={onSegmentClick ? 'button' : undefined}
              tabIndex={onSegmentClick ? 0 : undefined}
              onKeyDown={onSegmentClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSegmentClick(d); } } : undefined}
            >
              <span className={styles.dot} style={{ background: color }} />
              <span className={styles.legendLabel}>{titleCase(d.label)}</span>
              <span className={styles.legendVal}>{d.value}</span>
              <span className={styles.legendPct}>{pct}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
