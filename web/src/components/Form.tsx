import {
  forwardRef, useId, type InputHTMLAttributes, type SelectHTMLAttributes,
  type TextareaHTMLAttributes, type ReactNode,
} from 'react';
import { ChevronDown } from 'lucide-react';
import styles from './Form.module.css';

/** Grouping primitives so create/edit forms read as titled sections, not a wall of inputs. */
export function FormSection({ title, description, children }: { title?: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section}>
      {title && (
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle}>{title}</h3>
          {description && <p className={styles.sectionDesc}>{description}</p>}
        </div>
      )}
      <div className={styles.grid}>{children}</div>
    </section>
  );
}

export function FormGrid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}

export function FormActions({ children }: { children: ReactNode }) {
  return <div className={styles.formActions}>{children}</div>;
}

interface FieldProps {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
}

export function FormField({ label, htmlFor, hint, error, required, children }: FieldProps) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
        {required && <span className={styles.req} aria-hidden> *</span>}
      </label>
      {children}
      {hint && !error && <p className={styles.hint}>{hint}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...rest }, ref) {
    return <input ref={ref} className={`${styles.control} ${className}`} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = '', ...rest }, ref) {
    return <textarea ref={ref} className={`${styles.control} ${styles.textarea} ${className}`} {...rest} />;
  },
);

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  children: ReactNode;
}
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ className = '', children, ...rest }, ref) {
    return (
      <div className={styles.selectWrap}>
        <select ref={ref} className={`${styles.control} ${styles.select} ${className}`} {...rest}>
          {children}
        </select>
        <ChevronDown className={styles.caret} size={16} aria-hidden />
      </div>
    );
  },
);

/** Convenience: labelled text input pairing FormField + Input with a generated id. */
export function TextField(props: {
  label: ReactNode; value: string; onChange: (v: string) => void;
  required?: boolean; placeholder?: string; type?: string; hint?: ReactNode; error?: ReactNode;
}) {
  const id = useId();
  return (
    <FormField label={props.label} htmlFor={id} required={props.required} hint={props.hint} error={props.error}>
      <Input
        id={id}
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        required={props.required}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </FormField>
  );
}
