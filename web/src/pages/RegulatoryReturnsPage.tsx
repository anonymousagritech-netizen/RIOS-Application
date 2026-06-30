import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Tabs } from '../components/Tabs';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, Input, Select } from '../components/Form';
import { DefinitionList } from '../components/Feedback';
import { formatMoney, formatDateTime, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './workspace.module.css';

/* ---------------- Types (confirmed from server/src/modules/regulatoryAdvanced.ts) ---------------- */
interface Ifrs17Group {
  id: string;
  name: string;
  currency: string;
}
interface Ifrs17GroupsResponse { groups: Ifrs17Group[]; }

interface GmmResult {
  id: string;
  groupId: string;
  currency: string;
  model: string;
  fulfilmentCashFlowsMinor: number;
  csmMinor: number;
  onerous: boolean;
  lossComponentMinor: number;
  riskAdjustmentMinor: number;
  licMinor: number;
  totalLiabilityMinor: number;
}

interface RollforwardResult {
  id: string;
  groupId: string;
  currency: string;
  csmAfterInterest: number;
  csmAfterChanges: number;
  released: number;
  closingCsm: number;
}

interface MeasurementRow {
  id: string;
  asAt: string | null;
  inputs: unknown;
  lrcMinor: number;
  licMinor: number;
  lossComponentMinor: number;
  totalLiabilityMinor: number;
  isOnerous: boolean;
  csmMinor: number;
  fulfilmentCfMinor: number;
  riskAdjustmentMinor: number;
  createdAt: string | null;
}
interface MeasurementsResponse { groupId: string; measurements: MeasurementRow[]; }

type ReturnKind = 'SOLVENCY2_QRT' | 'SCHEDULE_F' | 'LLOYDS_RETURN' | 'IFRS17_DISCLOSURE';
const RETURN_KINDS: { value: ReturnKind; label: string }[] = [
  { value: 'SCHEDULE_F', label: 'US Schedule F' },
  { value: 'SOLVENCY2_QRT', label: 'Solvency II QRT' },
  { value: 'LLOYDS_RETURN', label: "Lloyd's return" },
  { value: 'IFRS17_DISCLOSURE', label: 'IFRS 17 disclosure' },
];

interface ReturnListItem {
  id: string;
  kind: ReturnKind;
  period: string | null;
  reference: string | null;
  status: string;
  createdAt: string | null;
  createdBy: string | null;
  approvedBy: string | null;
}
interface ReturnsResponse { returns: ReturnListItem[]; }

interface ReturnDetail extends ReturnListItem {
  data: unknown;
}

const TABS = [
  { id: 'ifrs17', label: 'IFRS 17 (GMM/VFA)' },
  { id: 'returns', label: 'Returns' },
];

/* ---------------- Data hooks ---------------- */
function useIfrs17Groups() {
  return useQuery({
    queryKey: ['regulatory', 'ifrs17', 'groups'],
    queryFn: () => api<Ifrs17GroupsResponse>('/api/regulatory/ifrs17/groups'),
  });
}
function useMeasurements(groupId: string | undefined) {
  return useQuery({
    queryKey: ['regulatory', 'ifrs17', groupId, 'measurements'],
    queryFn: () => api<MeasurementsResponse>(`/api/regulatory/ifrs17/groups/${groupId}/measurements`),
    enabled: !!groupId,
  });
}
function useMeasureGmm(groupId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { presentValueOfPremiums: number; presentValueOfClaims: number; riskAdjustment: number }) =>
      api<GmmResult>(`/api/regulatory/ifrs17/groups/${groupId}/measure-gmm`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['regulatory', 'ifrs17', groupId, 'measurements'] }),
  });
}
function useCsmRollforward(groupId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      openingCsm: number; interestAccretionRate: number; newBusinessCsm?: number;
      changeInEstimates?: number; coverageUnitsThisPeriod: number; coverageUnitsRemaining: number;
    }) => api<RollforwardResult>(`/api/regulatory/ifrs17/groups/${groupId}/csm-rollforward`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['regulatory', 'ifrs17', groupId, 'measurements'] }),
  });
}
function useReturns(kind: ReturnKind | '') {
  return useQuery({
    queryKey: ['regulatory', 'returns', kind || 'all'],
    queryFn: () => api<ReturnsResponse>(`/api/regulatory/returns${qs({ kind: kind || undefined })}`),
  });
}
function useReturnDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['regulatory', 'returns', 'detail', id],
    queryFn: () => api<ReturnDetail>(`/api/regulatory/returns/${id}`),
    enabled: !!id,
  });
}
function useGenerateReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { kind: ReturnKind; period?: string; reference?: string }) =>
      api<{ id: string; kind: ReturnKind; status: string }>('/api/regulatory/returns', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['regulatory', 'returns'] }),
  });
}
function useApproveReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ id: string; kind: ReturnKind; status: string }>(`/api/regulatory/returns/${id}/approve`, { body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['regulatory', 'returns'] }),
  });
}

const RETURN_STATUS_COLORS: Record<string, string> = { prepared: 'amber', approved: 'green' };

/* ---------------- Page ---------------- */
export function RegulatoryReturnsPage() {
  const { hasPermission } = useAuth();
  const canRun = hasPermission('regulatory:run');
  const [tab, setTab] = useState('ifrs17');

  return (
    <>
      <PageHeader
        title="Regulatory returns"
        description="IFRS 17 GMM/VFA measurement and governed regulatory return packs."
        actions={canRun ? <Badge color="green">regulatory:run granted</Badge> : <Badge color="slate">read-only</Badge>}
      />

      <Card padded={false}>
        <div className={styles.tabBar}><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>
        {tab === 'ifrs17' && <Ifrs17Tab canRun={canRun} />}
        {tab === 'returns' && <ReturnsTab canRun={canRun} />}
      </Card>
    </>
  );
}

/* ---------------- IFRS 17 tab ---------------- */
function Ifrs17Tab({ canRun }: { canRun: boolean }) {
  const { data, isLoading } = useIfrs17Groups();
  const groups = data?.groups ?? [];
  const [groupId, setGroupId] = useState('');
  const group = groups.find((g) => g.id === groupId);

  return (
    <div className={styles.tabBody}>
      <div className={styles.stack}>
        <Card>
          <CardHeader title="Measurement group" subtitle="Pick an IFRS 17 group to measure." />
          <div className={shared.grid2} style={{ display: 'grid' }}>
            <FormField label="Group" required>
              <Select value={groupId} onChange={(e) => setGroupId(e.target.value)} disabled={isLoading} aria-label="Select a group">
                <option value="">{isLoading ? 'Loading groups…' : 'Select a group…'}</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.currency})</option>)}
              </Select>
            </FormField>
          </div>
        </Card>

        {group && (
          <>
            <GmmCard group={group} canRun={canRun} />
            <RollforwardCard group={group} canRun={canRun} />
            <MeasurementsCard group={group} />
          </>
        )}
      </div>
    </div>
  );
}

function GmmCard({ group, canRun }: { group: Ifrs17Group; canRun: boolean }) {
  const toast = useToast();
  const measure = useMeasureGmm(group.id);
  const [pvPremiums, setPvPremiums] = useState('');
  const [pvClaims, setPvClaims] = useState('');
  const [riskAdjustment, setRiskAdjustment] = useState('');
  const [result, setResult] = useState<GmmResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await measure.mutateAsync({
        presentValueOfPremiums: Number(pvPremiums) || 0,
        presentValueOfClaims: Number(pvClaims) || 0,
        riskAdjustment: Number(riskAdjustment) || 0,
      });
      setResult(res);
      toast.success('GMM measurement complete');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not run the GMM measurement.');
    }
  };

  const ccy = result?.currency ?? group.currency;

  return (
    <Card>
      <CardHeader title="Measure GMM" subtitle="General Measurement Model - present values in major units." />
      {canRun ? (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div className={shared.grid3} style={{ display: 'grid' }}>
            <FormField label="PV of premiums" hint={`Major units of ${group.currency}.`}>
              <Input type="number" step="any" value={pvPremiums} onChange={(e) => setPvPremiums(e.target.value)} placeholder="e.g. 1000000" />
            </FormField>
            <FormField label="PV of claims" hint={`Major units of ${group.currency}.`}>
              <Input type="number" step="any" value={pvClaims} onChange={(e) => setPvClaims(e.target.value)} placeholder="e.g. 700000" />
            </FormField>
            <FormField label="Risk adjustment" hint={`Major units of ${group.currency}.`}>
              <Input type="number" step="any" value={riskAdjustment} onChange={(e) => setRiskAdjustment(e.target.value)} placeholder="e.g. 50000" />
            </FormField>
          </div>
          {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
          <div>
            <Button variant="primary" onClick={submit} loading={measure.isPending}>Measure GMM</Button>
          </div>
        </form>
      ) : (
        <p className={shared.cellSub}>You need the regulatory:run permission to run a GMM measurement.</p>
      )}

      {result && (
        <div style={{ marginTop: 'var(--space-5)' }}>
          <CardHeader
            title="GMM result"
            actions={result.onerous ? <StatusPill status="ONEROUS" label="Onerous" metaColors={{ ONEROUS: 'red' }} /> : <Badge color="green">Not onerous</Badge>}
          />
          <DefinitionList
            items={[
              { term: 'Fulfilment cash flows', value: <span className={shared.money}>{formatMoney(result.fulfilmentCashFlowsMinor, ccy)}</span> },
              { term: 'Contractual service margin (CSM)', value: <span className={shared.money}>{formatMoney(result.csmMinor, ccy)}</span> },
              { term: 'Loss component', value: <span className={shared.money}>{formatMoney(result.lossComponentMinor, ccy)}</span> },
              { term: 'Risk adjustment', value: <span className={shared.money}>{formatMoney(result.riskAdjustmentMinor, ccy)}</span> },
              { term: 'Total liability', value: <span className={shared.money}>{formatMoney(result.totalLiabilityMinor, ccy)}</span> },
            ]}
          />
        </div>
      )}
    </Card>
  );
}

function RollforwardCard({ group, canRun }: { group: Ifrs17Group; canRun: boolean }) {
  const toast = useToast();
  const roll = useCsmRollforward(group.id);
  const [openingCsm, setOpeningCsm] = useState('');
  const [interestRate, setInterestRate] = useState('0.03');
  const [newBusinessCsm, setNewBusinessCsm] = useState('');
  const [changeInEstimates, setChangeInEstimates] = useState('');
  const [coverageThis, setCoverageThis] = useState('');
  const [coverageRemaining, setCoverageRemaining] = useState('');
  const [result, setResult] = useState<RollforwardResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await roll.mutateAsync({
        openingCsm: Number(openingCsm) || 0,
        interestAccretionRate: Number(interestRate) || 0,
        newBusinessCsm: newBusinessCsm ? Number(newBusinessCsm) : undefined,
        changeInEstimates: changeInEstimates ? Number(changeInEstimates) : undefined,
        coverageUnitsThisPeriod: Number(coverageThis) || 0,
        coverageUnitsRemaining: Number(coverageRemaining) || 0,
      });
      setResult(res);
      toast.success('CSM roll-forward complete');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not run the CSM roll-forward.');
    }
  };

  const ccy = result?.currency ?? group.currency;

  return (
    <Card>
      <CardHeader title="CSM roll-forward" subtitle="Accrete interest, recognise changes and release CSM for the period." />
      {canRun ? (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div className={shared.grid2} style={{ display: 'grid' }}>
            <FormField label="Opening CSM" hint={`Major units of ${group.currency}.`}>
              <Input type="number" step="any" value={openingCsm} onChange={(e) => setOpeningCsm(e.target.value)} placeholder="e.g. 500000" />
            </FormField>
            <FormField label="Interest accretion rate" hint="Fraction, e.g. 0.03">
              <Input type="number" step="any" value={interestRate} onChange={(e) => setInterestRate(e.target.value)} placeholder="0.03" />
            </FormField>
            <FormField label="New business CSM" hint={`Optional. Major units of ${group.currency}.`}>
              <Input type="number" step="any" value={newBusinessCsm} onChange={(e) => setNewBusinessCsm(e.target.value)} placeholder="Optional" />
            </FormField>
            <FormField label="Change in estimates" hint={`Optional. Major units of ${group.currency}.`}>
              <Input type="number" step="any" value={changeInEstimates} onChange={(e) => setChangeInEstimates(e.target.value)} placeholder="Optional" />
            </FormField>
            <FormField label="Coverage units this period" hint="e.g. 100">
              <Input type="number" step="any" value={coverageThis} onChange={(e) => setCoverageThis(e.target.value)} placeholder="100" />
            </FormField>
            <FormField label="Coverage units remaining" hint="e.g. 900">
              <Input type="number" step="any" value={coverageRemaining} onChange={(e) => setCoverageRemaining(e.target.value)} placeholder="900" />
            </FormField>
          </div>
          {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
          <div>
            <Button variant="primary" onClick={submit} loading={roll.isPending}>Run roll-forward</Button>
          </div>
        </form>
      ) : (
        <p className={shared.cellSub}>You need the regulatory:run permission to run a CSM roll-forward.</p>
      )}

      {result && (
        <div style={{ marginTop: 'var(--space-5)' }}>
          <CardHeader title="Roll-forward result" />
          <DefinitionList
            items={[
              { term: 'CSM after interest', value: <span className={shared.money}>{formatMoney(result.csmAfterInterest, ccy)}</span> },
              { term: 'CSM after changes', value: <span className={shared.money}>{formatMoney(result.csmAfterChanges, ccy)}</span> },
              { term: 'Released this period', value: <span className={shared.money}>{formatMoney(result.released, ccy)}</span> },
              { term: 'Closing CSM', value: <span className={shared.money}>{formatMoney(result.closingCsm, ccy)}</span> },
            ]}
          />
        </div>
      )}
    </Card>
  );
}

function MeasurementsCard({ group }: { group: Ifrs17Group }) {
  const { data, isLoading } = useMeasurements(group.id);
  const measurements = data?.measurements ?? [];

  const columns: Column<MeasurementRow>[] = [
    { key: 'asAt', header: 'As at', sortValue: (m) => m.asAt ?? '', render: (m) => formatDateTime(m.asAt ?? m.createdAt) },
    { key: 'csm', header: 'CSM', align: 'right', sortValue: (m) => m.csmMinor, render: (m) => <span className={shared.money}>{formatMoney(m.csmMinor, group.currency)}</span> },
    { key: 'lic', header: 'LIC', align: 'right', sortValue: (m) => m.licMinor, render: (m) => <span className={shared.money}>{formatMoney(m.licMinor, group.currency)}</span> },
    { key: 'liability', header: 'Total liability', align: 'right', sortValue: (m) => m.totalLiabilityMinor, render: (m) => <span className={shared.money}>{formatMoney(m.totalLiabilityMinor, group.currency)}</span> },
    { key: 'onerous', header: '', render: (m) => (m.isOnerous ? <StatusPill status="ONEROUS" label="Onerous" metaColors={{ ONEROUS: 'red' }} /> : null) },
  ];

  return (
    <Card padded={false}>
      <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
        <CardHeader title="Measurement history" subtitle="GMM, VFA and roll-forward measurements for this group." />
      </div>
      <Table
        columns={columns}
        rows={measurements}
        loading={isLoading}
        rowKey={(m) => m.id}
        empty={<EmptyState title="No measurements" message="Run a measurement to see history here." icon="§" />}
      />
    </Card>
  );
}

/* ---------------- Returns tab ---------------- */
function ReturnsTab({ canRun }: { canRun: boolean }) {
  const toast = useToast();
  const [filterKind, setFilterKind] = useState<ReturnKind | ''>('');
  const { data, isLoading } = useReturns(filterKind);
  const generate = useGenerateReturn();
  const approve = useApproveReturn();

  const [genKind, setGenKind] = useState<ReturnKind>('SCHEDULE_F');
  const [period, setPeriod] = useState('');
  const [viewId, setViewId] = useState<string | null>(null);

  const returns = data?.returns ?? [];

  const onGenerate = async () => {
    try {
      await generate.mutateAsync({ kind: genKind, period: period || undefined });
      toast.success(`${RETURN_KINDS.find((k) => k.value === genKind)?.label ?? 'Return'} prepared`);
      setPeriod('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not generate the return.');
    }
  };

  const onApprove = async (id: string) => {
    try {
      await approve.mutateAsync(id);
      toast.success('Return approved');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not approve the return.');
    }
  };

  const columns: Column<ReturnListItem>[] = [
    { key: 'kind', header: 'Kind', sortValue: (r) => r.kind, render: (r) => <span className={shared.cellMain}>{RETURN_KINDS.find((k) => k.value === r.kind)?.label ?? titleCase(r.kind)}</span> },
    { key: 'period', header: 'Period', render: (r) => r.period ?? <span className={shared.cellSub}>-</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} metaColors={RETURN_STATUS_COLORS} /> },
    { key: 'created', header: 'Prepared', sortValue: (r) => r.createdAt ?? '', render: (r) => formatDateTime(r.createdAt) },
    {
      key: 'action', header: '', align: 'right',
      render: (r) => (
        <div className={shared.rowGap} style={{ display: 'inline-flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
          <Button size="sm" variant="ghost" onClick={() => setViewId(r.id)}>View</Button>
          {canRun && r.status !== 'approved' && (
            <Button size="sm" variant="secondary" onClick={() => onApprove(r.id)} loading={approve.isPending}>Approve</Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className={styles.tabBody}>
      <div className={styles.stack}>
        <Card>
          <CardHeader title="Generate return" subtitle="Prepare a governed regulatory pack from your tenant data. Packs start prepared and must be approved." />
          {canRun ? (
            <div className={shared.rowGap} style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-3)' }}>
              <FormField label="Return kind">
                <Select value={genKind} onChange={(e) => setGenKind(e.target.value as ReturnKind)}>
                  {RETURN_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </Select>
              </FormField>
              <FormField label="Period" hint="Optional, e.g. 2026-Q1">
                <Input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-Q1" />
              </FormField>
              <Button variant="primary" onClick={onGenerate} loading={generate.isPending}>Generate</Button>
            </div>
          ) : (
            <p className={shared.cellSub}>You need the regulatory:run permission to generate a return.</p>
          )}
        </Card>

        <Card padded={false}>
          <div style={{ padding: 'var(--space-4) var(--space-5) 0' }} className={shared.toolbar}>
            <CardHeader title="Prepared returns" subtitle="Regulatory return packs and their approval status." />
            <div className={shared.spacer} />
            <div className={shared.filter}>
              <span className={shared.filterLabel}>Kind</span>
              <Select value={filterKind} onChange={(e) => setFilterKind(e.target.value as ReturnKind | '')} aria-label="Filter by kind">
                <option value="">All</option>
                {RETURN_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </Select>
            </div>
          </div>
          <Table
            columns={columns}
            rows={returns}
            loading={isLoading}
            rowKey={(r) => r.id}
            empty={<EmptyState title="No returns" message="Generate a return to build a regulatory pack." icon="§" />}
          />
        </Card>
      </div>

      <ReturnModal id={viewId} canRun={canRun} onApprove={onApprove} approving={approve.isPending} onClose={() => setViewId(null)} />
    </div>
  );
}

function ReturnModal({ id, canRun, onApprove, approving, onClose }: {
  id: string | null; canRun: boolean; onApprove: (id: string) => void; approving: boolean; onClose: () => void;
}) {
  const { data, isLoading } = useReturnDetail(id ?? undefined);

  return (
    <Modal
      open={!!id}
      onClose={onClose}
      size="lg"
      title={data ? (RETURN_KINDS.find((k) => k.value === data.kind)?.label ?? titleCase(data.kind)) : 'Return'}
      description={data ? <span><span className={shared.cellRef}>{data.id}</span> · {data.period ?? 'no period'}</span> : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {canRun && data && data.status !== 'approved' && (
            <Button variant="primary" loading={approving} onClick={() => onApprove(data.id)}>Approve</Button>
          )}
        </>
      }
    >
      {isLoading && <p className={shared.cellSub}>Loading return…</p>}
      {data && (
        <>
          <DefinitionList
            items={[
              { term: 'Kind', value: RETURN_KINDS.find((k) => k.value === data.kind)?.label ?? titleCase(data.kind) },
              { term: 'Period', value: data.period ?? '-' },
              { term: 'Reference', value: data.reference ?? '-' },
              { term: 'Status', value: <StatusPill status={data.status} metaColors={RETURN_STATUS_COLORS} /> },
              { term: 'Prepared', value: formatDateTime(data.createdAt) },
            ]}
          />
          <div style={{ marginTop: 'var(--space-4)' }}>
            <pre
              style={{
                margin: 0,
                padding: 'var(--space-4)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                fontSize: 'var(--text-xs)',
                fontFamily: 'var(--font-mono)',
                overflow: 'auto',
                maxHeight: '360px',
              }}
            >
              {JSON.stringify(data.data ?? {}, null, 2)}
            </pre>
          </div>
        </>
      )}
    </Modal>
  );
}
