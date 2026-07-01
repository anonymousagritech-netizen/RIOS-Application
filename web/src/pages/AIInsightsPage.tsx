import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  Sparkles, ShieldAlert, AlertTriangle, Info, CheckCircle2,
  TrendingUp, Gauge, Globe2, Banknote, Activity, Layers,
  Send, Lightbulb, MessageSquare,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { Textarea } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import type { TokenColor } from '../lib/status';
import { titleCase } from '../lib/format';
import styles from './AIInsightsPage.module.css';

/* ---------------- Types (mirror the /api/ai/insights contract) ---------------- */
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
interface InsightSummary {
  POSITIVE: number;
  INFO: number;
  WATCH: number;
  RISK: number;
}
interface InsightsResponse {
  summary: InsightSummary;
  total: number;
  insights: Insight[];
  domains: { domain: string; insights: Insight[] }[];
}

/** Resilient assistant reply — the endpoint may use any of these fields. */
interface AssistantReplyShape {
  answer?: string;
  text?: string;
  reply?: string;
  grounding?: unknown;
}

interface ChatTurn {
  id: number;
  question: string;
  answer: string;
}

/* ---------------- Constants ---------------- */
const SEVERITY_COLOR: Record<Severity, TokenColor> = {
  RISK: 'red', WATCH: 'amber', INFO: 'blue', POSITIVE: 'green',
};
const SEVERITY_LABEL: Record<Severity, string> = {
  RISK: 'Risk', WATCH: 'Watch', INFO: 'Info', POSITIVE: 'Positive',
};

const DOMAIN_COLOR: Record<string, TokenColor> = {
  underwriting: 'indigo',
  claims: 'orange',
  finance: 'teal',
  portfolio: 'violet',
  exposure: 'rose',
  operations: 'slate',
};

const SUGGESTED_PROMPTS = [
  "What's my loss ratio?",
  'Any capacity breaches?',
  'Top exposure concentration?',
];

const domainLabel = (d: string) => titleCase(d);
const domainColor = (d: string): TokenColor => DOMAIN_COLOR[d.toLowerCase()] ?? 'slate';

function severityIcon(sev: Severity) {
  switch (sev) {
    case 'RISK': return <ShieldAlert size={14} />;
    case 'WATCH': return <AlertTriangle size={14} />;
    case 'INFO': return <Info size={14} />;
    case 'POSITIVE': return <CheckCircle2 size={14} />;
  }
}

function domainIcon(d: string) {
  switch (d.toLowerCase()) {
    case 'underwriting': return <Layers size={13} />;
    case 'claims': return <ShieldAlert size={13} />;
    case 'finance': return <Banknote size={13} />;
    case 'portfolio': return <TrendingUp size={13} />;
    case 'exposure': return <Globe2 size={13} />;
    case 'operations': return <Activity size={13} />;
    default: return <Gauge size={13} />;
  }
}

/** Pull whichever answer field the assistant returned; fall back to raw JSON. */
function readAnswer(r: AssistantReplyShape): string {
  return r.answer ?? r.text ?? r.reply ?? JSON.stringify(r);
}

/* ---------------- Data hook ---------------- */
function useInsights() {
  return useQuery({
    queryKey: ['ai', 'insights'],
    queryFn: () => api<InsightsResponse>('/api/ai/insights'),
  });
}

export function AIInsightsPage() {
  const { data, isLoading } = useInsights();
  const [domain, setDomain] = useState<string>('ALL');

  const insights = data?.insights ?? [];
  const summary = data?.summary;
  const domains = data?.domains ?? [];

  const tabs = [
    { id: 'ALL', label: `All${data ? ` · ${data.total}` : ''}` },
    ...domains.map((d) => ({
      id: d.domain,
      label: `${domainLabel(d.domain)} · ${d.insights.length}`,
    })),
  ];

  const visible = domain === 'ALL'
    ? insights
    : insights.filter((i) => i.domain === domain);

  return (
    <>
      <PageHeader
        title="AI Insights"
        description="Grounded, explainable insights across the platform — no black box."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'AI Insights' }]}
      />

      {isLoading ? (
        <PageLoader label="Analysing your book…" />
      ) : (
        <>
          <div className={styles.kpis}>
            <KpiCard
              label="Risk"
              value={summary?.RISK ?? 0}
              hint="Needs attention now"
              icon={<ShieldAlert size={20} />}
              accent="var(--accent-rose)"
            />
            <KpiCard
              label="Watch"
              value={summary?.WATCH ?? 0}
              hint="Trending toward a limit"
              icon={<AlertTriangle size={20} />}
              accent="var(--accent-orange)"
            />
            <KpiCard
              label="Info"
              value={summary?.INFO ?? 0}
              hint="Context worth knowing"
              icon={<Info size={20} />}
              accent="var(--accent-blue)"
            />
            <KpiCard
              label="Positive"
              value={summary?.POSITIVE ?? 0}
              hint="Healthy signals"
              icon={<CheckCircle2 size={20} />}
              accent="var(--accent-emerald)"
            />
          </div>

          <Card padded={false} className={styles.boardCard}>
            <CardHeader
              title={<span className={styles.titleRow}><Sparkles size={16} /> Insight board</span>}
              subtitle="Ranked observations, most urgent first. Each is grounded in your live data."
            />
            <div className={styles.filterBar}>
              <Tabs tabs={tabs} active={domain} onChange={setDomain} />
            </div>

            {visible.length === 0 ? (
              <div className={styles.empty}>
                <Sparkles size={22} />
                <p className={styles.emptyTitle}>No insights to show</p>
                <p className={styles.emptyMsg}>
                  {domain === 'ALL'
                    ? 'Nothing stands out right now — your book looks steady.'
                    : `No ${domainLabel(domain)} insights at the moment.`}
                </p>
              </div>
            ) : (
              <div className={styles.grid}>
                {visible.map((ins, i) => (
                  <InsightCard key={`${ins.domain}:${ins.title}:${i}`} insight={ins} />
                ))}
              </div>
            )}
          </Card>

          <AssistantPanel />
        </>
      )}
    </>
  );
}

/* ---------------- Insight card ---------------- */
function InsightCard({ insight }: { insight: Insight }) {
  const sev = insight.severity;
  return (
    <article className={styles.insight} data-severity={sev}>
      <span className={styles.accent} aria-hidden />
      <div className={styles.insightHead}>
        <Badge color={SEVERITY_COLOR[sev]}>
          <span className={styles.badgeInner}>{severityIcon(sev)} {SEVERITY_LABEL[sev]}</span>
        </Badge>
        <Badge color={domainColor(insight.domain)} variant="outline">
          <span className={styles.badgeInner}>{domainIcon(insight.domain)} {domainLabel(insight.domain)}</span>
        </Badge>
      </div>

      <h3 className={styles.insightTitle}>{insight.title}</h3>
      <p className={styles.insightDetail}>{insight.detail}</p>

      {insight.metricLabel && insight.metricValue && (
        <span className={styles.metricPill}>
          <span className={styles.metricLabel}>{insight.metricLabel}</span>
          <span className={styles.metricDot} aria-hidden>·</span>
          <span className={styles.metricValue}>{insight.metricValue}</span>
        </span>
      )}

      {insight.recommendation && (
        <div className={styles.reco}>
          <span className={styles.recoIcon} aria-hidden><Lightbulb size={14} /></span>
          <span className={styles.recoText}>{insight.recommendation}</span>
        </div>
      )}
    </article>
  );
}

/* ---------------- Ask the assistant ---------------- */
function AssistantPanel() {
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [error, setError] = useState<string | null>(null);

  const ask = useMutation({
    mutationFn: (message: string) =>
      api<AssistantReplyShape>('/api/assistant', { body: { message } }),
    onSuccess: (r, message) => {
      setTurns((prev) => [
        ...prev,
        { id: (prev[prev.length - 1]?.id ?? 0) + 1, question: message, answer: readAnswer(r) },
      ]);
      setDraft('');
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'The assistant could not answer that. Please try again.'),
  });

  const submit = () => {
    const message = draft.trim();
    if (!message || ask.isPending) return;
    setError(null);
    ask.mutate(message);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Card className={styles.chatCard}>
      <CardHeader
        title={<span className={styles.titleRow}><MessageSquare size={16} /> Ask the assistant</span>}
        subtitle="Grounded answers with citations. The assistant confirms before it changes anything."
      />

      {turns.length > 0 && (
        <div className={styles.transcript}>
          {turns.map((t) => (
            <div key={t.id} className={styles.turn}>
              <div className={`${styles.bubble} ${styles.bubbleUser}`}>{t.question}</div>
              <div className={`${styles.bubble} ${styles.bubbleAssistant}`}>
                <span className={styles.bubbleIcon} aria-hidden><Sparkles size={13} /></span>
                <span className={styles.bubbleText}>{t.answer}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className={styles.prompts}>
        {SUGGESTED_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            className={styles.promptChip}
            onClick={() => setDraft(p)}
          >
            <Lightbulb size={12} /> {p}
          </button>
        ))}
      </div>

      <div className={styles.composer}>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder="Ask about your book — loss ratios, capacity, exposure concentration…"
          aria-label="Message the assistant"
        />
        <div className={styles.composerFoot}>
          <span className={styles.hintText}>Press ⌘/Ctrl + Enter to send</span>
          <Button
            variant="primary"
            icon={<Send size={15} />}
            onClick={submit}
            loading={ask.isPending}
            disabled={!draft.trim()}
          >
            Send
          </Button>
        </div>
      </div>

      {error && <p className={styles.chatError} role="alert">{error}</p>}
    </Card>
  );
}
