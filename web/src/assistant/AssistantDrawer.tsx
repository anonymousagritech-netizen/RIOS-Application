import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, Volume2, Square, FileText, CircleAlert, TrendingUp, CalendarClock, ShieldAlert, ClipboardList, Gauge, Landmark } from 'lucide-react';
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
  'Portfolio insights',
  'What is the loss ratio?',
  'Technical result',
  'Capacity utilisation',
  'Peak accumulation zone',
  'Top brokers',
];

// Quick voice commands shown in voice mode.
const VOICE_COMMANDS = [
  { icon: FileText, label: 'Active treaties', text: 'How many treaties are active?' },
  { icon: CircleAlert, label: 'Open claims', text: 'Summarise open claims' },
  { icon: TrendingUp, label: 'Total GWP', text: 'What is total GWP this year?' },
  { icon: CalendarClock, label: "Who's on leave", text: 'Who is on leave today?' },
  { icon: ShieldAlert, label: 'High-risk', text: 'Show high-risk submissions' },
  { icon: ClipboardList, label: 'UW pipeline', text: 'Underwriting pipeline' },
  { icon: TrendingUp, label: 'Portfolio', text: 'Portfolio insights' },
  { icon: Gauge, label: 'Capacity', text: 'Capacity utilisation' },
  { icon: Landmark, label: 'Technical result', text: 'Technical result' },
];

export function AssistantDrawer({ open, onClose, autoVoice = false }: { open: boolean; onClose: () => void; autoVoice?: boolean }) {
  const toast = useToast();
  const navigate = useNavigate();
  const ask = useAssistant();
  const confirm = useAssistantConfirm();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<AssistantAction | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const voiceModeRef = useRef(autoVoice);
  voiceModeRef.current = autoVoice;

  // Speak a reply aloud (voice-out). Tracks a speaking state so the orb can
  // show "Speaking…". No-op where speechSynthesis is unavailable.
  const speak = (text: string) => {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 1.02;
      u.onstart = () => setSpeaking(true);
      u.onend = () => setSpeaking(false);
      u.onerror = () => setSpeaking(false);
      synth.speak(u);
    } catch { setSpeaking(false); }
  };

  // Voice command: transcribe speech and send it straight to the assistant.
  const voice = useVoice((text) => { setInput(text); void send(text); });

  // Warm up the speech-synthesis voice list (some browsers load it lazily).
  useEffect(() => { try { window.speechSynthesis?.getVoices(); } catch { /* ignore */ } }, []);

  // Opened via the floating Voice Assistant → start listening immediately.
  useEffect(() => {
    if (open && autoVoice && voice.supported && !voice.listening) voice.start();
    if (!open) { try { window.speechSynthesis?.cancel(); } catch { /* ignore */ } setSpeaking(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoVoice]);

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
      if (voiceModeRef.current) speak(res.reply);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'The assistant could not respond.';
      setTurns((t) => [...t, { role: 'assistant', text: msg }]);
    } finally {
      scrollDown();
    }
  };

  const stopVoice = () => {
    voice.stop();
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    setSpeaking(false);
  };

  const runAction = (action: AssistantAction) => {
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

  const voiceState = speaking ? 'speaking' : voice.listening ? 'listening' : 'idle';

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
          {/* Voice mode panel: speaking / listening orb, Stop, quick commands. */}
          {autoVoice && voice.supported && (
            <div className={styles.voicePanel}>
              <button
                type="button"
                className={`${styles.orb} ${styles[`orb_${voiceState}`]}`}
                onClick={() => (voice.listening || speaking ? stopVoice() : voice.start())}
                aria-label={voice.listening ? 'Stop listening' : 'Start listening'}
              >
                <span className={styles.orbRing} aria-hidden />
                <span className={styles.orbRing2} aria-hidden />
                {speaking ? <Volume2 size={30} /> : <Mic size={30} />}
              </button>
              <div className={styles.voiceStatus}>
                {speaking ? 'Speaking…' : voice.listening ? 'Listening…' : 'Tap the mic to speak'}
              </div>
              {(voice.listening || speaking) && (
                <Button variant="danger" size="sm" icon={<Square size={13} />} onClick={stopVoice}>Stop</Button>
              )}
              <div className={styles.voiceCmdLabel}>Quick voice commands</div>
              <div className={styles.voiceCmds}>
                {VOICE_COMMANDS.map((c) => (
                  <button key={c.label} type="button" className={styles.voiceCmd} onClick={() => send(c.text)}>
                    <c.icon size={15} /> {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.length === 0 && !autoVoice && (
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
