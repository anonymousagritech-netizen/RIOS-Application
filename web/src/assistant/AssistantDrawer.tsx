import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic } from 'lucide-react';
import type { AssistantAction } from '@rios/shared';
import { Drawer } from '../components/Drawer';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/Modal';
import { Spinner } from '../components/Feedback';
import { useToast } from '../components/Toast';
import { useAssistant, useAssistantConfirm } from '../lib/queries';
import { ApiError } from '../lib/api';
import { useVoice } from './useVoice';
import styles from './AssistantDrawer.module.css';

interface Grounding { entity: string; id: string; label: string; }

interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  actions?: AssistantAction[];
  grounding?: Grounding[];
}

const SUGGESTIONS = [
  'How many treaties are active?',
  'Summarise open claims',
  'What is total GWP this year?',
];

export function AssistantDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const ask = useAssistant();
  const confirm = useAssistantConfirm();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<AssistantAction | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Voice command: transcribe speech and send it straight to the assistant.
  const voice = useVoice((text) => { setInput(text); void send(text); });

  const scrollDown = () => {
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  };

  const send = async (message: string) => {
    const text = message.trim();
    if (!text || ask.isPending) return;
    setInput('');
    setTurns((t) => [...t, { role: 'user', text }]);
    scrollDown();
    try {
      const res = await ask.mutateAsync(text);
      setTurns((t) => [
        ...t,
        { role: 'assistant', text: res.reply, actions: res.actions, grounding: res.grounding },
      ]);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'The assistant could not respond.';
      setTurns((t) => [...t, { role: 'assistant', text: msg }]);
    } finally {
      scrollDown();
    }
  };

  const runAction = (action: AssistantAction) => {
    // Navigation actions are non-mutating and handled client-side.
    const route = (action.preview as { route?: string } | undefined)?.route;
    if (action.kind === 'navigate' && route) {
      navigate(route);
      onClose();
      return;
    }
    if (action.requiresConfirmation) {
      setPending(action);
    } else {
      doConfirm(action);
    }
  };

  const doConfirm = async (action: AssistantAction) => {
    try {
      const res = await confirm.mutateAsync({ kind: action.kind, preview: action.preview });
      toast.success(`Done - ${action.description}`);
      setTurns((t) => [
        ...t,
        { role: 'assistant', text: `✓ Confirmed: ${action.description} (ref ${res.id ?? action.id}).` },
      ]);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Action could not be completed.';
      toast.error(msg);
    } finally {
      setPending(null);
      scrollDown();
    }
  };

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title={<span className={styles.titleRow}><span className={styles.spark} aria-hidden>✦</span> RIOS Assistant</span>}
        subtitle="Grounded answers. Nothing is changed without your confirmation."
        width={440}
      >
        <div className={styles.scroll} ref={scrollRef}>
          {turns.length === 0 && (
            <div className={styles.intro}>
              <p className={styles.introText}>
                Ask about treaties, claims, parties or financials. I cite what I read and
                will always ask before making any change.
              </p>
              <div className={styles.suggestions}>
                {SUGGESTIONS.map((s) => (
                  <button key={s} className={styles.suggestion} onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}

          {turns.map((turn, i) => (
            <div key={i} className={`${styles.turn} ${turn.role === 'user' ? styles.user : styles.assistant}`}>
              <div className={styles.bubble}>{turn.text}</div>

              {turn.grounding && turn.grounding.length > 0 && (
                <div className={styles.grounding}>
                  {turn.grounding.map((g) => (
                    <span key={`${g.entity}-${g.id}`} className={styles.chip} title={`${g.entity} · ${g.id}`}>
                      <span className={styles.chipDot} aria-hidden />
                      {g.label}
                    </span>
                  ))}
                </div>
              )}

              {turn.actions && turn.actions.length > 0 && (
                <div className={styles.actions}>
                  {turn.actions.map((a) => (
                    <div key={a.id} className={styles.action}>
                      <div className={styles.actionText}>
                        <strong>{a.description}</strong>
                        {a.requiresConfirmation && (
                          <span className={styles.actionNote}>
                            {a.destructive ? 'Destructive - ' : ''}requires confirmation
                          </span>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant={a.destructive ? 'danger' : 'primary'}
                        onClick={() => runAction(a)}
                      >
                        {a.requiresConfirmation ? 'Review' : 'Run'}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {ask.isPending && (
            <div className={`${styles.turn} ${styles.assistant}`}>
              <div className={`${styles.bubble} ${styles.thinking}`}><Spinner size={14} /> Thinking…</div>
            </div>
          )}
        </div>

        <form
          className={styles.composer}
          onSubmit={(e) => { e.preventDefault(); send(input); }}
        >
          <input
            className={styles.composerInput}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={voice.listening ? 'Listening…' : 'Ask anything, or use voice…'}
            aria-label="Message the assistant"
          />
          {voice.supported && (
            <button
              type="button"
              className={`${styles.micBtn} ${voice.listening ? styles.micActive : ''}`}
              onClick={() => (voice.listening ? voice.stop() : voice.start())}
              aria-label={voice.listening ? 'Stop voice' : 'Voice command'}
              title="Voice command"
            >
              <Mic size={18} />
            </button>
          )}
          <Button type="submit" variant="primary" size="sm" disabled={!input.trim() || ask.isPending}>
            Send
          </Button>
        </form>
      </Drawer>

      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        onConfirm={() => pending && doConfirm(pending)}
        title={pending?.description ?? 'Confirm action'}
        destructive={pending?.destructive}
        loading={confirm.isPending}
        confirmLabel={pending?.destructive ? 'Yes, proceed' : 'Confirm'}
        message="Review exactly what will change before confirming. Nothing has been applied yet."
      >
        {pending && (
          <pre className={styles.preview}>{JSON.stringify(pending.preview, null, 2)}</pre>
        )}
      </ConfirmDialog>
    </>
  );
}
