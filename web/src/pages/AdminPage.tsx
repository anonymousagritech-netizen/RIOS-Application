/**
 * Configuration / Administration page (brief §10, §10.3).
 *
 * Tabs:
 *  1. Code lists       — metadata-driven vocabularies; add values without a deployment.
 *  2. Currencies & rates — active currencies + most-recent exchange rates per pair.
 *  3. Audit log        — read-only hash-chained activity timeline (last 50 entries).
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Coins, ListTree, Plus, Tags, ArrowLeftRight, ShieldCheck,
  Fingerprint, Sparkles,
} from 'lucide-react';
import type { CodeValueDTO } from '@rios/shared';
import {
  useCodeLists, useCurrencies, useAddCodeValue,
  useExchangeRates, useAddExchangeRate, useAddCurrency,
} from '../lib/queries';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, Input, Select, TextField } from '../components/Form';
import { PageLoader, ErrorState } from '../components/Feedback';
import { Tabs } from '../components/Tabs';
import { isTokenColor, type TokenColor } from '../lib/status';
import { formatNumber, formatDate, titleCase } from '../lib/format';
import type { ExchangeRateDTO } from '../lib/types';
import shared from './shared.module.css';
import styles from './AdminPage.module.css';

const TOKEN_COLORS: TokenColor[] = [
  'green', 'blue', 'amber', 'violet', 'slate', 'red', 'teal', 'indigo', 'orange', 'rose', 'gray',
];

/* ------------------------------------------------------------------ */
/*  Root page                                                           */
/* ------------------------------------------------------------------ */

export function AdminPage() {
  const [tab, setTab] = useState('code-lists');
  const { data, isLoading, isError } = useCodeLists();
  const { data: currencies } = useCurrencies();
  const { data: rates } = useExchangeRates();

  const listKeys = useMemo(() => Object.keys(data?.lists ?? {}).sort(), [data]);

  if (isLoading) return <PageLoader label="Loading configuration…" />;
  if (isError) return <Card><ErrorState message="Could not load configuration." /></Card>;

  const totalValues = listKeys.reduce((acc, k) => acc + (data?.lists?.[k]?.length ?? 0), 0);
  const currencyCount = currencies?.currencies?.length ?? 0;
  const rateCount = rates?.rates?.length ?? 0;

  return (
    <>
      <PageHeader
        title="Configuration"
        description="No-code configuration: add status values, currencies and exchange rates that take effect immediately — no deployment required."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Configuration' }]}
        actions={<Badge color="blue">No deploy required</Badge>}
      />

      <div className={styles.page}>
        <div className={styles.kpis}>
          <KpiCard label="Code lists" value={formatNumber(listKeys.length)} hint="Configurable vocabularies" icon={<ListTree size={20} />} accent="var(--primary)" />
          <KpiCard label="Values" value={formatNumber(totalValues)} hint="Across all lists" icon={<Tags size={20} />} accent="var(--accent-violet)" />
          <KpiCard label="Currencies" value={formatNumber(currencyCount)} hint="Settlement currencies" icon={<Coins size={20} />} accent="var(--accent-cyan)" />
          <KpiCard label="FX rates" value={formatNumber(rateCount)} hint="Latest rates per pair" icon={<ArrowLeftRight size={20} />} accent="var(--accent-amber)" />
        </div>

        <Card padded={false}>
          <Tabs
            tabs={[
              { id: 'code-lists', label: 'Code lists' },
              { id: 'currencies', label: 'Currencies & rates' },
              { id: 'audit', label: 'Audit log' },
            ]}
            active={tab}
            onChange={setTab}
          />

          {tab === 'code-lists' && <CodeListsTab data={data} listKeys={listKeys} />}
          {tab === 'currencies' && <CurrenciesTab />}
          {tab === 'audit' && <AuditTab />}
        </Card>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 1 — Code lists                                                  */
/* ------------------------------------------------------------------ */

function CodeListsTab({ data, listKeys }: {
  data: { lists: Record<string, CodeValueDTO[]> } | undefined;
  listKeys: string[];
}) {
  const [addTo, setAddTo] = useState<string | null>(null);

  return (
    <>
      <div className={styles.listHead}>
        <CardHeader title="Code lists" subtitle="Metadata-driven status and code vocabularies used across the app." />
      </div>
      <div className={styles.listGrid}>
        {listKeys.map((key) => {
          const values = data?.lists?.[key] ?? [];
          return (
            <CodeListCard
              key={key}
              listKey={key}
              values={values}
              onAdd={() => setAddTo(key)}
            />
          );
        })}
        {listKeys.length === 0 && (
          <div style={{ padding: 'var(--space-6)', gridColumn: '1 / -1' }}>
            <EmptyState title="No code lists" message="No metadata vocabularies found for this tenant." />
          </div>
        )}
      </div>
      <AddValueModal listKey={addTo} onClose={() => setAddTo(null)} />
    </>
  );
}

function CodeListCard({ listKey, values, onAdd }: {
  listKey: string; values: CodeValueDTO[]; onAdd: () => void;
}) {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('config:write') || hasPermission('admin:manage');

  const metaColors: Record<string, string> = {};
  for (const v of values) {
    const c = (v.meta as { color?: string } | undefined)?.color;
    if (c) metaColors[v.code] = c;
  }

  const columns: Column<CodeValueDTO>[] = [
    { key: 'code', header: 'Code', sortValue: (v) => v.code, render: (v) => <span className={shared.cellRef}>{v.code}</span> },
    { key: 'label', header: 'Label', sortValue: (v) => v.label, render: (v) => <span className={shared.cellMain}>{v.label}</span> },
    {
      key: 'preview',
      header: 'Preview',
      render: (v) => <StatusPill status={v.code} label={v.label} metaColors={metaColors} />,
    },
    {
      key: 'color',
      header: 'Colour',
      render: (v) => {
        const c = (v.meta as { color?: string } | undefined)?.color;
        return c ? <Badge color={isTokenColor(c) ? (c as TokenColor) : 'gray'}>{c}</Badge> : <span className={shared.cellSub}>-</span>;
      },
    },
    { key: 'sortOrder', header: 'Order', align: 'right', sortValue: (v) => v.sortOrder, render: (v) => v.sortOrder },
  ];

  return (
    <div className={styles.listPanel}>
      <div className={styles.panelHead}>
        <CardHeader
          title={titleCase(listKey)}
          subtitle={<code className={styles.keyCode}>{listKey}</code>}
          actions={canWrite ? <Button size="sm" variant="secondary" onClick={onAdd} icon={<Plus size={14} />}>Add value</Button> : undefined}
        />
      </div>
      <div className={styles.panelBody}>
        <Table
          columns={columns}
          rows={values}
          rowKey={(v) => v.code}
          empty={<EmptyState title="No values" message="Add the first value for this list." />}
          skeletonRows={3}
        />
      </div>
    </div>
  );
}

function AddValueModal({ listKey, onClose }: { listKey: string | null; onClose: () => void }) {
  const toast = useToast();
  const add = useAddCodeValue(listKey ?? '');
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [color, setColor] = useState<TokenColor>('blue');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setCode(''); setLabel(''); setColor('blue'); setError(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!code.trim() || !label.trim()) { setError('Code and label are required.'); return; }
    try {
      await add.mutateAsync({ code: code.trim().toUpperCase(), label: label.trim(), meta: { color } });
      toast.success(`Added "${label}" to ${listKey}`);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the value.');
    }
  };

  return (
    <Modal
      open={!!listKey}
      onClose={() => { reset(); onClose(); }}
      title={`Add value to ${listKey ? titleCase(listKey) : ''}`}
      description="Demonstrates configuration without deployment - the new value is available app-wide instantly."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={add.isPending} disabled={!code.trim() || !label.trim()}>Add value</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="Code" value={code} onChange={setCode} required placeholder="e.g. UNDER_REVIEW" />
          <TextField label="Label" value={label} onChange={setLabel} required placeholder="e.g. Under review" />
        </div>
        <FormField label="Colour" hint="Drives the status pill colour across the app">
          <Select value={color} onChange={(e) => setColor(e.target.value as TokenColor)}>
            {TOKEN_COLORS.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
          </Select>
        </FormField>
        <div className={styles.previewRow}>
          <span className={shared.cellSub}>Preview:</span>
          <StatusPill status={code || 'NEW_VALUE'} label={label || 'New value'} metaColors={{ [code || 'NEW_VALUE']: color }} />
        </div>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 2 — Currencies & exchange rates                                 */
/* ------------------------------------------------------------------ */

function CurrenciesTab() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('config:write') || hasPermission('admin:manage');

  const { data: currData, isLoading: currLoading } = useCurrencies();
  const { data: rateData, isLoading: rateLoading } = useExchangeRates();

  const [showAddCcy, setShowAddCcy] = useState(false);
  const [showAddRate, setShowAddRate] = useState(false);

  type CurrRow = { code: string; name: string; minorUnits: number; symbol: string; isActive?: boolean };

  const ccyCols: Column<CurrRow>[] = [
    { key: 'code', header: 'Code', sortValue: (c) => c.code, render: (c) => <span className={shared.cellRef}>{c.code}</span> },
    { key: 'name', header: 'Name', sortValue: (c) => c.name, render: (c) => <span className={shared.cellMain}>{c.name}</span> },
    { key: 'symbol', header: 'Symbol', align: 'center', render: (c) => c.symbol ?? '-' },
    { key: 'minor', header: 'Minor units', align: 'right', sortValue: (c) => c.minorUnits, render: (c) => c.minorUnits },
  ];

  const rateCols: Column<ExchangeRateDTO>[] = [
    {
      key: 'pair', header: 'Pair',
      render: (r) => <span className={shared.cellRef}>{r.fromCcy} → {r.toCcy}</span>,
    },
    { key: 'rate', header: 'Rate', align: 'right', sortValue: (r) => r.rate, render: (r) => r.rate.toFixed(6) },
    { key: 'date', header: 'Effective date', sortValue: (r) => r.rateDate, render: (r) => formatDate(r.rateDate) },
    { key: 'source', header: 'Source', render: (r) => <Badge color="slate">{r.source}</Badge> },
  ];

  return (
    <div className={styles.tabContent}>
      {/* Currencies table */}
      <Card padded={false}>
        <div className={shared.toolbar} style={{ padding: 'var(--space-4) var(--space-5) var(--space-2)' }}>
          <CardHeader
            title="Currencies"
            subtitle="ISO 4217 settlement currencies and their minor-unit exponents."
          />
          {canWrite && (
            <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setShowAddCcy(true)}>
              Add currency
            </Button>
          )}
        </div>
        <Table
          columns={ccyCols}
          rows={currData?.currencies}
          loading={currLoading}
          rowKey={(c) => c.code}
          empty={<EmptyState title="No currencies" message="No settlement currencies configured." />}
          skeletonRows={4}
        />
      </Card>

      {/* Exchange rates table */}
      <Card padded={false}>
        <div className={shared.toolbar} style={{ padding: 'var(--space-4) var(--space-5) var(--space-2)' }}>
          <CardHeader
            title="Exchange rates"
            subtitle="Most-recent rate per currency pair. Adding a rate for the same date overwrites the previous value."
          />
          {canWrite && (
            <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setShowAddRate(true)}>
              Add rate
            </Button>
          )}
        </div>
        <Table
          columns={rateCols}
          rows={rateData?.rates}
          loading={rateLoading}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No exchange rates" message="Add a rate to enable cross-currency FX conversions." icon={<ArrowLeftRight size={16} />} />}
          skeletonRows={4}
        />
      </Card>

      <AddCurrencyModal open={showAddCcy} onClose={() => setShowAddCcy(false)} />
      <AddRateModal open={showAddRate} onClose={() => setShowAddRate(false)} />
    </div>
  );
}

function AddCurrencyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const add = useAddCurrency();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [minorUnits, setMinorUnits] = useState('2');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setCode(''); setName(''); setSymbol(''); setMinorUnits('2'); setError(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!code.trim() || !name.trim()) { setError('Code and name are required.'); return; }
    if (code.trim().length !== 3) { setError('Currency code must be exactly 3 characters (ISO 4217).'); return; }
    try {
      await add.mutateAsync({
        code: code.trim().toUpperCase(),
        name: name.trim(),
        symbol: symbol.trim() || undefined,
        minorUnits: Number(minorUnits) || 2,
      });
      toast.success(`Currency ${code.trim().toUpperCase()} added`);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add currency.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Add currency"
      description="Adds an ISO 4217 currency to the tenant's settlement currencies. Existing codes are reactivated with updated metadata."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={add.isPending} disabled={!code.trim() || !name.trim()}>Add</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="Code" value={code} onChange={setCode} required placeholder="e.g. EUR" />
          <TextField label="Name" value={name} onChange={setName} required placeholder="e.g. Euro" />
        </div>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="Symbol" value={symbol} onChange={setSymbol} placeholder="e.g. €" />
          <FormField label="Minor units" hint="Decimal places (ISO 4217 exponent)">
            <Select value={minorUnits} onChange={(e) => setMinorUnits(e.target.value)}>
              <option value="0">0 — whole units</option>
              <option value="2">2 — cents (default)</option>
              <option value="3">3 — mils</option>
              <option value="4">4 — basis points</option>
            </Select>
          </FormField>
        </div>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

function AddRateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const add = useAddExchangeRate();
  const [fromCcy, setFromCcy] = useState('');
  const [toCcy, setToCcy] = useState('');
  const [rate, setRate] = useState('');
  const [rateDate, setRateDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFromCcy(''); setToCcy(''); setRate('');
    setRateDate(new Date().toISOString().slice(0, 10));
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const rateNum = parseFloat(rate);
    if (!fromCcy.trim() || !toCcy.trim()) { setError('Both currency codes are required.'); return; }
    if (!rate || isNaN(rateNum) || rateNum <= 0) { setError('Rate must be a positive number.'); return; }
    try {
      await add.mutateAsync({
        fromCcy: fromCcy.trim().toUpperCase(),
        toCcy: toCcy.trim().toUpperCase(),
        rate: rateNum,
        rateDate,
      });
      toast.success(`Rate ${fromCcy.trim().toUpperCase()} → ${toCcy.trim().toUpperCase()} = ${rateNum}`);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add rate.');
    }
  };

  const rateNum = parseFloat(rate);
  const ratePreviewOk = fromCcy && toCcy && rate && !isNaN(rateNum) && rateNum > 0;

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Add exchange rate"
      description="The most-recent rate per pair is used for FX conversions. Same-date entries overwrite the previous value."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={add.isPending} disabled={!fromCcy.trim() || !toCcy.trim() || !rate}>Add rate</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="From currency" value={fromCcy} onChange={setFromCcy} required placeholder="USD" />
          <TextField label="To currency" value={toCcy} onChange={setToCcy} required placeholder="GBP" />
        </div>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="Rate" value={rate} onChange={setRate} required placeholder="0.790000" />
          <FormField label="Effective date">
            <Input type="date" value={rateDate} onChange={(e) => setRateDate(e.target.value)} />
          </FormField>
        </div>
        {ratePreviewOk && (
          <p className={shared.cellSub}>
            1 {fromCcy.trim().toUpperCase()} = {rateNum.toFixed(6)} {toCcy.trim().toUpperCase()}
          </p>
        )}
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 3 — Audit log (read-only, last 50 entries)                     */
/* ------------------------------------------------------------------ */

interface AuditEntry {
  id: string; occurredAt: string; actor: string | null; action: string;
  entityType: string; entityId: string | null; viaAssistant: boolean; tamperEvident: boolean;
}
interface AuditResp {
  entries: AuditEntry[];
  chain: { total: number; hashed: number };
}

const ACTION_COLOR: Record<string, TokenColor> = {
  create: 'green', update: 'blue', delete: 'red', bind: 'violet', post: 'teal', confirm: 'indigo',
  transition: 'blue', price: 'violet', score: 'violet', refer: 'amber',
};
const actionColor = (a: string): TokenColor => ACTION_COLOR[a] ?? 'slate';

function AuditTab() {
  const q = useQuery({
    queryKey: ['audit-admin'],
    queryFn: () => api<AuditResp>('/api/audit?limit=50'),
  });

  const d = q.data;
  const chainText = d ? `${d.chain.hashed}/${d.chain.total} hash-chained` : 'Tamper-evident';

  const columns: Column<AuditEntry>[] = [
    {
      key: 'time',
      header: 'When',
      sortValue: (r) => r.occurredAt,
      render: (r) => (
        <span className={styles.auditTime}>
          {new Date(r.occurredAt).toLocaleString([], {
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
          })}
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      render: (r) => <Badge color={actionColor(r.action)}>{titleCase(r.action.replace(/_/g, ' '))}</Badge>,
    },
    {
      key: 'entity',
      header: 'Entity',
      render: (r) => (
        <div>
          <div className={shared.cellMain}>{titleCase(r.entityType.replace(/_/g, ' '))}</div>
          {r.entityId && <div className={shared.cellSub}>{r.entityId.slice(0, 8)}…</div>}
        </div>
      ),
    },
    {
      key: 'actor',
      header: 'Actor',
      render: (r) => (
        <span className={shared.cellSub}>
          {r.actor ?? 'system'}
          {r.viaAssistant && (
            <span className={styles.auditAiChip}>
              <Sparkles size={10} /> AI
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'hash',
      header: '',
      align: 'right',
      render: (r) => r.tamperEvident
        ? <span className={styles.auditHash} title="Hash-chained — tamper-evident"><Fingerprint size={14} /></span>
        : null,
    },
  ];

  return (
    <div className={styles.tabContent}>
      <div className={shared.toolbar}>
        <CardHeader
          title="Recent activity"
          subtitle="Last 50 entries, most recent first. Full timeline in Operations → Audit Log."
        />
        <Badge color="green"><ShieldCheck size={13} /> {chainText}</Badge>
      </div>
      <Table
        columns={columns}
        rows={d?.entries}
        loading={q.isLoading}
        rowKey={(r) => r.id}
        empty={<EmptyState icon={<ShieldCheck size={18} />} title="No activity" message="No audit entries yet." />}
        skeletonRows={8}
      />
    </div>
  );
}
