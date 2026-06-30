import {
  createContext, useCallback, useContext, useEffect, useState, type ReactNode,
} from 'react';
import { onAuthEvent } from '../lib/api';
import styles from './Toast.module.css';

type ToastKind = 'info' | 'success' | 'error' | 'warning';
interface Toast { id: number; kind: ToastKind; message: string; }

interface ToastCtx {
  push: (message: string, kind?: ToastKind) => void;
  success: (m: string) => void;
  error: (m: string) => void;
}

const Ctx = createContext<ToastCtx | null>(null);
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = ++seq;
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => remove(id), 5000);
  }, [remove]);

  // Surface 403s from the API layer as toasts.
  useEffect(() => {
    const off = onAuthEvent((e, detail) => {
      if (e === 'forbidden') push(detail ?? 'You do not have permission for that action.', 'error');
    });
    return () => { off(); };
  }, [push]);

  const value: ToastCtx = {
    push,
    success: (m) => push(m, 'success'),
    error: (m) => push(m, 'error'),
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className={styles.viewport} role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`${styles.toast} ${styles[t.kind]}`} role="status">
            <span className={styles.dot} aria-hidden />
            <span className={styles.msg}>{t.message}</span>
            <button className={styles.close} onClick={() => remove(t.id)} aria-label="Dismiss">×</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
