import { useEffect, useRef, useState } from 'react';

/**
 * Thin wrapper around the browser Web Speech API (SpeechRecognition) for
 * voice commands. Degrades gracefully: `supported` is false where the API is
 * unavailable, so the UI can hide the mic. No audio leaves the device beyond
 * the browser's own recognition service.
 */
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

export function useVoice(onTranscript: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const cbRef = useRef(onTranscript);
  cbRef.current = onTranscript;

  const Ctor =
    typeof window !== 'undefined'
      ? ((window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike })
          .SpeechRecognition ??
        (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition)
      : undefined;
  const supported = !!Ctor;

  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* ignore */ } }, []);

  const start = () => {
    if (!Ctor || listening) return;
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (e) => {
      const text = e.results?.[0]?.[0]?.transcript ?? '';
      if (text) cbRef.current(text.trim());
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    try { rec.start(); } catch { setListening(false); }
  };

  const stop = () => { try { recRef.current?.stop(); } catch { /* ignore */ } setListening(false); };

  return { supported, listening, start, stop };
}
