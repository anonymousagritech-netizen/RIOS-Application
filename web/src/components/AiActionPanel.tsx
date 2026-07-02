/**
 * AiActionPanel — a reusable, contextual AI action embedded inside a module,
 * so AI is available where the work happens (not only in the floating drawer).
 *
 * It is wired to the REAL AI backend. Two modes, chosen per embedding:
 *
 *  - `insightDomain`  → GET /api/ai/insights (the grounded, explainable insight
 *    engine) and renders the ranked observations for that domain. Deterministic,
 *    always works, and identical to what the AI Insights console shows.
 *
 *  - `prompt`         → POST /api/assistant (the guardrailed embedded assistant).
 *    The module context is folded into a well-formed message. When an Anthropic
 *    key is configured the answer is a live LLM analysis grounded in tenant data;
 *    otherwise the assistant's deterministic intent engine answers. There is no
 *    dedicated "AI pricing" endpoint, so pricing uses this general assistant —
 *    the panel says so honestly rather than faking a bespoke model.
 *
 * If the assistant proposes actions they are shown READ-ONLY: this panel never
 * mutates data. Any change is confirmed through the existing assistant guardrail.
 *
 * Hooks are kept LOCAL to this component (inline useMutation) by design.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Sparkles, Lightbulb, ShieldAlert, AlertTriangle, Info, CheckCircle2, Lock,
} from 'lucide-react';
import type { AssistantAction } from '@rios/shared';
import { api, ApiError } from '../lib/api';
import { Card, CardHeader } from '../components/Card';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Spinner } from '../components/Feedback';
import { useToast } from '../components/Toast';
import type { TokenColor } from '../lib/status';
import { titleCase } from '../lib/format';
import styles from './AiActionPanel.module.css';

/* ---------------- Shapes (mirror the real endpoint contracts) ---------------- */
type Severity = 'POSITIVE' | 'INFO' | 'WATCH' | 'RISK';

interface Insight {
  domain: string;
  severity: Severity;
  title: string;
  detail: string;
  recommendation?: string;
  metricLabel?: string;
  metricValue?: string;
}
interface InsightsResponse {
  total: number;
  insights: Insight[];
  domains: { domain: string; insights: Insight[] }[];
}

interface Grounding { entity: string; id: string; label: string }
interface AssistantReply {
  reply: string;
  actions?: AssistantAction[];
  grounding?: Grounding[];
}

/* ---------------- Props ---------------- */
type Ctx = Record<string, string | number | null | undefined>;

interface BaseProps {
  /** Panel heading, e.g. "AI pricing insight". */
  title: string;
  /** Entity / module context; shown for transparency and (assistant mode) sent. */
  context?: Ctx;
  /** Label for the trigger button. Defaults to a mode-appropriate label. */
  buttonLabel?: string;
  /** Optional extra honesty note appended under the subtitle. */
  note?: string;
}
interface AssistantProps extends BaseProps {
  /** Assistant mode: a well-formed question; context is folded into the message. */
  prompt: string;
  insightDomain?: never;
}
interface InsightProps extends BaseProps {
  /** Insights mode: one of underwriting|claims|finance|portfolio|exposure|operations. */
  insightDomain: string;
  prompt?: never;
}
type AiActionPanelProps = AssistantProps | InsightProps;

/* ---------------- Severity presentation ---------------- */
const SEVERITY_COLOR: Record<Severity, TokenColor> = {
  RISK: 'red', WATCH: 'amber', INFO: 'blue', POSITIVE: 'green',
};
const SEVERITY_LABEL: Record<Severity, string> = {
  RISK: 'Risk', WATCH: 'Watch', INFO: 'Info', POSITIVE: 'Positive',
};
function severityIcon(sev: Severity) {
  switch (sev) {
    case 'RISK': return <ShieldAlert size={13} />;
    case 'WATCH': return <AlertTriangle size={13} />;
    case 'INFO': return <Info size={13} />;
    case 'POSITIVE': return <CheckCircle2 size={13} />;
  }
}

/** Fold the context object into a readable one-line clause for the assistant. */
function contextClause(context: Ctx | undefined): string {
  if (!context) return '';
  const parts = Object.entries(context)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${titleCase(k)}: ${v}`);
  return parts.join('; ');
}

export function AiActionPanel(props: AiActionPanelProps) {
  const { title, context, buttonLabel, note } = props;
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [reply, setReply] = useState<AssistantReply | null>(null);

  const isInsightMode = 'insightDomain' in props && !!props.insightDomain;

  const subtitle = isInsightMode
    ? 'Grounded, explainable insights from your live book — no black box.'
    : 'Answered by the grounded RIOS assistant. It cites what it reads and never changes data without your confirmation.';

  const run = useMutation({
    mutationFn: async () => {
      setError(null);
      if (isInsightMode) {
        const res = await api<InsightsResponse>('/api/ai/insights');
        const domain = (props as InsightProps).insightDomain.toLowerCase();
        return { kind: 'insights' as const, insights: res.insights.filter((i) => i.domain.toLowerCase() === domain) };
      }
      const clause = contextClause(context);
      const message = clause ? `${(props as AssistantProps).prompt}\n\nContext — ${clause}` : (props as AssistantProps).prompt;
      const res = await api<AssistantReply>('/api/assistant', { body: { message } });
      return { kind: 'assistant' as const, reply: res };
    },
    onSuccess: (data) => {
      if (data.kind === 'insights') { setInsights(data.insights); setReply(null); }
      else { setReply(data.reply); setInsights(null); }
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? e.message : 'The AI service could not respond. Please try again.';
      setError(msg);
      toast.error(msg);
    },
  });

  const defaultLabel = isInsightMode ? 'AI insight' : 'Ask AI';
  const hasRun = insights !== null || reply !== null;
  const contextEntries = context
    ? Object.entries(context).filter(([, v]) => v != null && v !== '')
    : [];

  return (
    <Card className={styles.panel}>
      <CardHeader
        title={<span className={styles.titleRow}><Sparkles size={16} /> {title}</span>}
        subtitle={
          <>
            {subtitle}
            {note && <span className={styles.note}> {note}</span>}
          </>
        }
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<Sparkles size={15} />}
            loading={run.isPending}
            onClick={() => run.mutate()}
          >
            {buttonLabel ?? defaultLabel}
          </Button>
        }
      />

      {contextEntries.length > 0 && (
        <div className={styles.contextChips} aria-label="Context in view">
          {contextEntries.map(([k, v]) => (
            <span key={k} className={styles.contextChip}>
              <span className={styles.contextKey}>{titleCase(k)}</span>
              <span className={styles.contextVal}>{String(v)}</span>
            </span>
          ))}
        </div>
      )}

      {run.isPending && (
        <div className={styles.loading}><Spinner size={16} /> Analysing your book…</div>
      )}

      {!run.isPending && error && (
        <p className={styles.error} role="alert">{error}</p>
      )}

      {!run.isPending && !error && !hasRun && (
        <p className={styles.hint}>
          {isInsightMode
            ? 'Generate grounded insights for this area, computed from your live data.'
            : 'Ask the assistant for a grounded recommendation using the context shown above.'}
        </p>
      )}

      {/* ---- Insights mode result ---- */}
      {!run.isPending && insights !== null && (
        insights.length === 0 ? (
          <p className={styles.hint}>No insights for this area right now — nothing stands out.</p>
        ) : (
          <div className={styles.insightList}>
            {insights.map((ins, i) => <InsightRow key={`${ins.title}:${i}`} insight={ins} />)}
          </div>
        )
      )}

      {/* ---- Assistant mode result ---- */}
      {!run.isPending && reply !== null && (
        <div className={styles.replyBlock}>
          <p className={styles.replyText}>{reply.reply}</p>

          {reply.grounding && reply.grounding.length > 0 && (
            <div className={styles.grounding}>
              {reply.grounding.map((g) => (
                <span key={`${g.entity}-${g.id}`} className={styles.groundChip} title={`${g.entity} · ${g.id}`}>
                  <span className={styles.groundDot} aria-hidden />
                  {g.label}
                </span>
              ))}
            </div>
          )}

          {reply.actions && reply.actions.length > 0 && (
            <div className={styles.prepared}>
              <div className={styles.preparedNote}>
                <Lock size={12} /> Prepared action — this panel does not apply changes. Confirm it in the RIOS assistant to proceed.
              </div>
              {reply.actions.map((a) => (
                <div key={a.id} className={styles.preparedItem}>
                  <strong className={styles.preparedDesc}>{a.description}</strong>
                  {a.requiresConfirmation && (
                    <Badge color={a.destructive ? 'red' : 'amber'}>
                      {a.destructive ? 'Destructive · confirm' : 'Requires confirmation'}
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/* ---------------- One insight row ---------------- */
function InsightRow({ insight }: { insight: Insight }) {
  const sev = insight.severity;
  return (
    <article className={styles.insight} data-severity={sev}>
      <span className={styles.accent} aria-hidden />
      <div className={styles.insightHead}>
        <Badge color={SEVERITY_COLOR[sev]}>
          <span className={styles.badgeInner}>{severityIcon(sev)} {SEVERITY_LABEL[sev]}</span>
        </Badge>
        {insight.metricLabel && insight.metricValue && (
          <span className={styles.metricPill}>
            <span className={styles.metricLabel}>{insight.metricLabel}</span>
            <span aria-hidden>·</span>
            <span className={styles.metricValue}>{insight.metricValue}</span>
          </span>
        )}
      </div>
      <h4 className={styles.insightTitle}>{insight.title}</h4>
      <p className={styles.insightDetail}>{insight.detail}</p>
      {insight.recommendation && (
        <div className={styles.reco}>
          <span className={styles.recoIcon} aria-hidden><Lightbulb size={13} /></span>
          <span className={styles.recoText}>{insight.recommendation}</span>
        </div>
      )}
    </article>
  );
}
