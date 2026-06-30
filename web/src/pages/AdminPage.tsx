import { useMemo, useState } from 'react';
import { Coins, ListTree, Plus, Tags } from 'lucide-react';
import type { CodeValueDTO } from '@rios/shared';
import { useCodeLists, useCurrencies, useAddCodeValue } from '../lib/queries';
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
import { isTokenColor, type TokenColor } from '../lib/status';
import { formatNumber, titleCase } from '../lib/format';
import { ApiError } from '../lib/api';
import shared from './shared.module.css';
import styles from './AdminPage.module.css';

const TOKEN_COLORS: TokenColor[] = [
  'green', 'blue', 'amber', 'violet', 'slate', 'red', 'teal', 'indigo', 'orange', 'rose', 'gray',
];

export function AdminPage() {
  const { data, isLoading, isError } = useCodeLists();
  const { data: currencies } = useCurrencies();
  const [addTo, setAddTo] = useState<string | null>(null);

  const listKeys = useMemo(() => Object.keys(data?.lists ?? {}).sort(), [data]);

  if (isLoading) return <PageLoader label="Loading configuration…" />;
  if (isError) return <Card><ErrorState message="Could not load configuration." /></Card>;

  const totalValues = listKeys.reduce((acc, k) => acc + (data?.lists?.[k]?.length ?? 0), 0);
  const currencyCount = currencies?.currencies?.length ?? 0;

  return (
    <>
      <PageHeader
        title="Configuration"
        description="No-code configuration: add status and code values that take effect immediately - no deployment required."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Configuration' }]}
        actions={<Badge color="blue">No deploy required</Badge>}
      />

      <div className={styles.page}>
        <div className={styles.kpis}>
          <KpiCard label="Code lists" value={formatNumber(listKeys.length)} hint="Configurable vocabularies" icon={<ListTree size={20} />} accent="var(--primary)" />
          <KpiCard label="Values" value={formatNumber(totalValues)} hint="Across all lists" icon={<Tags size={20} />} accent="var(--accent-violet)" />
          <KpiCard label="Currencies" value={formatNumber(currencyCount)} hint="Settlement currencies" icon={<Coins size={20} />} accent="var(--accent-cyan)" />
        </div>

        <Card padded={false}>
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
          </div>
        </Card>

        <Card padded={false}>
          <div className={styles.listHead}>
            <CardHeader title="Currencies" subtitle="Supported settlement currencies and their minor units." />
          </div>
          <CurrencyTable currencies={currencies?.currencies ?? []} />
        </Card>
      </div>

      <AddValueModal listKey={addTo} onClose={() => setAddTo(null)} />
    </>
  );
}

function CodeListCard({ listKey, values, onAdd }: {
  listKey: string; values: CodeValueDTO[]; onAdd: () => void;
}) {
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
          actions={<Button size="sm" variant="secondary" onClick={onAdd} icon={<Plus size={14} />}>Add value</Button>}
        />
      </div>
      <Table
        columns={columns}
        rows={values}
        rowKey={(v) => v.code}
        empty={<EmptyState title="No values" message="Add the first value for this list." />}
        skeletonRows={3}
      />
    </div>
  );
}

function CurrencyTable({ currencies }: { currencies: { code: string; name: string; minorUnits: number; symbol: string }[] }) {
  const columns: Column<typeof currencies[number]>[] = [
    { key: 'code', header: 'Code', sortValue: (c) => c.code, render: (c) => <span className={shared.cellRef}>{c.code}</span> },
    { key: 'name', header: 'Name', sortValue: (c) => c.name, render: (c) => c.name },
    { key: 'symbol', header: 'Symbol', align: 'center', render: (c) => c.symbol },
    { key: 'minor', header: 'Minor units', align: 'right', sortValue: (c) => c.minorUnits, render: (c) => c.minorUnits },
  ];
  return (
    <Table columns={columns} rows={currencies} rowKey={(c) => c.code} empty={<EmptyState title="No currencies" />} skeletonRows={3} />
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
      toast.success(`Added “${label}” to ${listKey}`);
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
