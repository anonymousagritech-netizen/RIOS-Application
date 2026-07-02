/**
 * Catastrophe model / ELT import (brief §13). Imports an Event Loss Table from a
 * cat modelling vendor (CSV or JSON) and shows the pure @rios/domain metrics -
 * Average Annual Loss, the OEP exceedance curve and the PML profile at standard
 * return periods. The importer is the labelled seam for a licensed RMS/AIR feed.
 * Importing needs exposure:write.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Button } from '../components/Button';
import { FormField, Input, Select } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatMoney, formatDate } from '../lib/format';
import { Waves, Upload, Activity, AlertTriangle } from 'lucide-react';

interface EltRow { id: string; name: string; vendor: string; peril?: string | null; region?: string | null; currency: string; source: string; eventCount: number; createdAt: string; aalMinor?: number | null }
interface PmlPoint { returnPeriod: number; lossMinor: number }
interface EltDetail extends EltRow { epCurve?: unknown; pmlProfile?: PmlPoint[]; events?: { eventRef?: string | null; eventName?: string | null; rate: number; lossMinor: number }[] }

const SAMPLE_CSV = 'rate,lossMinor\n0.10,1000000\n0.02,5000000\n0.01,20000000';

export function CatModelPage() {
  const { hasPermission } = useAuth();
  const qc = useQueryClient();
  const canWrite = hasPermission('exposure:write');
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [peril, setPeril] = useState('HURRICANE');
  const [currency, setCurrency] = useState('USD');
  const [format, setFormat] = useState<'CSV' | 'JSON'>('CSV');
  const [data, setData] = useState(SAMPLE_CSV);
  const [error, setError] = useState<string | null>(null);

  const listQ = useQuery({ queryKey: ['catmodel', 'elts'], queryFn: () => api<{ elts: EltRow[] }>('/api/catmodel/elt') });
  const detailQ = useQuery({
    queryKey: ['catmodel', 'elt', selected],
    queryFn: () => api<EltDetail>(`/api/catmodel/elt/${selected}`),
    enabled: !!selected,
  });

  const importElt = useMutation({
    mutationFn: () => api<{ elt: EltRow }>('/api/catmodel/elt', {
      method: 'POST',
      body: { name: name || 'Imported ELT', peril, currency, format, data: format === 'JSON' ? JSON.parse(data) : data },
    }),
    onSuccess: (r) => { setError(null); setSelected(r.elt.id); qc.invalidateQueries({ queryKey: ['catmodel'] }); },
    onError: (e: any) => setError(e?.body?.detail ?? e?.message ?? 'Import failed'),
  });

  if (listQ.isLoading) return <PageLoader />;
  const elts = listQ.data?.elts ?? [];

  const columns: Column<EltRow>[] = [
    { key: 'name', header: 'Name', render: (e) => e.name },
    { key: 'vendor', header: 'Vendor', render: (e) => e.vendor },
    { key: 'peril', header: 'Peril', render: (e) => e.peril ?? '—' },
    { key: 'eventCount', header: 'Events', align: 'right', render: (e) => String(e.eventCount) },
    { key: 'aalMinor', header: 'AAL', align: 'right', render: (e) => e.aalMinor != null ? formatMoney(e.aalMinor, e.currency) : '—' },
    { key: 'createdAt', header: 'Imported', render: (e) => formatDate(e.createdAt) },
    { key: 'actions', header: '', render: (e) => <Button size="sm" variant="ghost" onClick={() => setSelected(e.id)}>Metrics</Button> },
  ];

  const detail = detailQ.data;
  const pml = detail?.pmlProfile ?? [];

  return (
    <>
      <PageHeader
        title="Cat Model / ELT"
        description="Import an Event Loss Table and derive AAL, the OEP exceedance curve and PML at return periods."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Cat Model / ELT' }]}
      />

      {canWrite && (
        <Card style={{ marginBottom: 'var(--space-5)' }}>
          <CardHeader title="Import ELT" subtitle="CSV (rate,lossMinor header) or a JSON array of {rate, lossMinor}" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-3)' }}>
            <FormField label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Imported ELT" /></FormField>
            <FormField label="Peril"><Input value={peril} onChange={(e) => setPeril(e.target.value)} /></FormField>
            <FormField label="Currency"><Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} /></FormField>
            <FormField label="Format">
              <Select value={format} onChange={(e) => setFormat(e.target.value as 'CSV' | 'JSON')}>
                <option value="CSV">CSV</option>
                <option value="JSON">JSON</option>
              </Select>
            </FormField>
          </div>
          <FormField label="Data">
            <textarea value={data} onChange={(e) => setData(e.target.value)} rows={6}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, padding: 'var(--space-3)', borderRadius: 8, border: '1px solid var(--color-border)' }} />
          </FormField>
          {error && (
            <p style={{ color: 'var(--color-danger, #c0392b)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertTriangle size={14} /> {error}
            </p>
          )}
          <Button onClick={() => importElt.mutate()} disabled={importElt.isPending} icon={<Upload size={15} />}>Import ELT</Button>
        </Card>
      )}

      {detail && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-4)', marginBottom: 'var(--space-5)' }}>
          <KpiCard label={`${detail.name} — AAL`} value={detail.aalMinor != null ? formatMoney(detail.aalMinor, detail.currency) : '—'} icon={<Activity size={18} />} />
          {pml.filter((p) => [100, 250].includes(p.returnPeriod)).map((p) => (
            <KpiCard key={p.returnPeriod} label={`1-in-${p.returnPeriod} PML`} value={formatMoney(p.lossMinor, detail.currency)} icon={<Waves size={18} />} />
          ))}
        </div>
      )}

      {detail && pml.length > 0 && (
        <Card padded={false} style={{ marginBottom: 'var(--space-5)' }}>
          <CardHeader title="PML profile" subtitle="Occurrence (OEP) loss at each return period" />
          <Table
            columns={[
              { key: 'rp', header: 'Return period', render: (p: PmlPoint) => `1-in-${p.returnPeriod}` },
              { key: 'loss', header: 'PML', align: 'right', render: (p: PmlPoint) => formatMoney(p.lossMinor, detail.currency) },
            ]}
            rows={pml}
            rowKey={(p) => String(p.returnPeriod)}
          />
        </Card>
      )}

      <Card padded={false}>
        <CardHeader title="Imported ELTs" subtitle="Event Loss Tables from cat modelling vendors" />
        {elts.length === 0
          ? <EmptyState title="No ELTs imported yet" message="Import an Event Loss Table to compute cat metrics." />
          : <Table columns={columns} rows={elts} rowKey={(e) => e.id} onRowClick={(e) => setSelected(e.id)} />}
      </Card>
    </>
  );
}
