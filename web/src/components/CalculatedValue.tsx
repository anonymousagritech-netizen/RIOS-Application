import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Calculator, PencilLine, RotateCcw } from 'lucide-react';
import { Button } from './Button';
import { Textarea, Input, FormField } from './Form';
import styles from './CalculatedValue.module.css';

/** Provenance of a displayed figure — mirrors the formula-engine override model. */
export type CalculatedStatus = 'SYSTEM' | 'OVERRIDE' | 'IMPORTED' | 'MANUAL';

export interface CalculationStep {
  name: string;
  label: string;
  value: number;
}

interface StatusMeta {
  label: string;
  dot: string; // css var
}

const STATUS_META: Record<CalculatedStatus, StatusMeta> = {
  SYSTEM: { label: 'System', dot: 'var(--c-green)' },
  OVERRIDE: { label: 'Override', dot: 'var(--c-amber)' },
  IMPORTED: { label: 'Imported', dot: 'var(--c-blue)' },
  MANUAL: { label: 'Manual', dot: 'var(--c-slate)' },
};

export interface CalculatedValueProps {
  label?: string;
  value: number;
  formatValue?: (n: number) => string;
  status?: CalculatedStatus;
  steps?: CalculationStep[];
  /** The system-computed value, shown alongside `value` when they differ. */
  systemValue?: number;
  onOverride?: (overrideValue: number, reason: string) => void;
  onRestore?: () => void;
  canOverride?: boolean;
}

const defaultFormat = (n: number) => new Intl.NumberFormat().format(n);

/**
 * Presentational renderer for a computed figure. Shows the value with a
 * provenance chip, an invoice-style "View calculation" breakdown, and — when
 * permitted — an override form. It never fetches; all data + callbacks are props.
 */
export function CalculatedValue({
  label,
  value,
  formatValue = defaultFormat,
  status = 'SYSTEM',
  steps,
  systemValue,
  onOverride,
  onRestore,
  canOverride = false,
}: CalculatedValueProps) {
  const [showCalc, setShowCalc] = useState(false);
  const [showOverride, setShowOverride] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the popovers on outside click / Escape.
  useEffect(() => {
    if (!showCalc && !showOverride) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setShowCalc(false);
        setShowOverride(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setShowCalc(false); setShowOverride(false); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showCalc, showOverride]);

  const meta = STATUS_META[status];
  const hasSteps = !!steps && steps.length > 0;
  const systemDiffers = systemValue != null && systemValue !== value;
  const total = hasSteps ? steps!.reduce((s, st) => s + st.value, 0) : value;

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <div className={styles.valueRow}>
        {label && <span className={styles.label}>{label}</span>}
        <span className={styles.value}>{formatValue(value)}</span>
        <span className={styles.chip} title={`${meta.label} value`}>
          <span className={styles.dot} style={{ background: meta.dot }} aria-hidden />
          {meta.label}
        </span>

        {(hasSteps || systemDiffers) && (
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => { setShowCalc((v) => !v); setShowOverride(false); }}
            aria-expanded={showCalc}
          >
            <Calculator size={13} aria-hidden /> View calculation
          </button>
        )}

        {canOverride && onOverride && (
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => { setShowOverride((v) => !v); setShowCalc(false); }}
            aria-expanded={showOverride}
          >
            <PencilLine size={13} aria-hidden /> Override
          </button>
        )}
      </div>

      {showCalc && (hasSteps || systemDiffers) && (
        <CalculationPopover
          steps={steps ?? []}
          total={total}
          value={value}
          systemValue={systemDiffers ? systemValue : undefined}
          formatValue={formatValue}
        />
      )}

      {showOverride && canOverride && onOverride && (
        <OverridePopover
          currentValue={value}
          status={status}
          formatValue={formatValue}
          onSubmit={(v, reason) => { onOverride(v, reason); setShowOverride(false); }}
          onRestore={onRestore ? () => { onRestore(); setShowOverride(false); } : undefined}
        />
      )}
    </div>
  );
}

function CalculationPopover({
  steps, total, value, systemValue, formatValue,
}: {
  steps: CalculationStep[];
  total: number;
  value: number;
  systemValue?: number;
  formatValue: (n: number) => string;
}) {
  return (
    <div className={styles.popover} role="dialog" aria-label="Calculation breakdown">
      <div className={styles.popHead}>
        <Calculator size={14} aria-hidden /> Calculation breakdown
      </div>
      {steps.length > 0 ? (
        <ul className={styles.steps}>
          {steps.map((s) => (
            <li key={s.name} className={styles.step}>
              <span className={styles.stepLabel}>{s.label || s.name}</span>
              <span className={styles.stepValue}>{formatValue(s.value)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>No intermediate steps were reported for this figure.</p>
      )}
      <div className={styles.total}>
        <span className={styles.stepLabel}>Total</span>
        <span className={styles.totalValue}>{formatValue(total)}</span>
      </div>
      {systemValue != null && (
        <div className={styles.compare}>
          <div className={styles.compareRow}>
            <span className={styles.stepLabel}>System value</span>
            <span className={styles.stepValue}>{formatValue(systemValue)}</span>
          </div>
          <div className={styles.compareRow}>
            <span className={styles.stepLabel}>Displayed value</span>
            <span className={styles.stepValue}>{formatValue(value)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function OverridePopover({
  currentValue, status, formatValue, onSubmit, onRestore,
}: {
  currentValue: number;
  status: CalculatedStatus;
  formatValue: (n: number) => string;
  onSubmit: (value: number, reason: string) => void;
  onRestore?: () => void;
}): ReactNode {
  const [raw, setRaw] = useState(String(currentValue));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    const num = Number(raw);
    if (raw.trim() === '' || Number.isNaN(num)) { setError('Enter a valid numeric value.'); return; }
    if (!reason.trim()) { setError('A reason is required to override the system value.'); return; }
    onSubmit(num, reason.trim());
  };

  return (
    <div className={styles.popover} role="dialog" aria-label="Override value">
      <div className={styles.popHead}>
        <PencilLine size={14} aria-hidden /> Override value
      </div>
      <p className={styles.muted}>
        Manually override the calculated figure. The system value is preserved and the
        change is audited. A reason is required.
      </p>
      <FormField label="Override value" required>
        <Input
          type="number"
          step="any"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          autoFocus
        />
      </FormField>
      <FormField label="Reason" required hint="Explain why the system value is being overridden.">
        <Textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Manual adjustment per broker agreement dated 2026-06-30."
        />
      </FormField>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.popActions}>
        {status === 'OVERRIDE' && onRestore && (
          <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={onRestore}>
            Restore system value
          </Button>
        )}
        <span className={styles.spacer} />
        <Button
          size="sm"
          variant="primary"
          onClick={submit}
          disabled={!reason.trim()}
        >
          Save override
        </Button>
      </div>
      <p className={styles.footNote}>Current: {formatValue(currentValue)}</p>
    </div>
  );
}
