import { Bot } from 'lucide-react';
import styles from './VoiceFab.module.css';

/**
 * Floating "Voice Assistant" button. Sits bottom-right above the content and
 * opens the RIOS Assistant straight into voice mode (starts listening, speaks
 * replies). Hidden while the assistant drawer is open.
 */
export function VoiceFab({ onClick, hidden }: { onClick: () => void; hidden?: boolean }) {
  if (hidden) return null;
  return (
    <button
      type="button"
      className={styles.fab}
      onClick={onClick}
      aria-label="Open the voice assistant"
      title="Voice Assistant"
    >
      <span className={styles.core}>
        <span className={styles.ring} aria-hidden />
        <span className={styles.ring2} aria-hidden />
        <Bot size={26} strokeWidth={2} />
      </span>
      <span className={styles.label}>Voice Assistant</span>
    </button>
  );
}
