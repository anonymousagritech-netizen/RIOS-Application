import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useCurrencies } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, FormSection, Input, Select } from '../components/Form';
import { formatMoney, formatDate, formatNumber, titleCase } from '../lib/format';
import { Banknote, Users, Wallet, Landmark } from 'lucide-react';
import { KpiCard } from '../components/KpiCard';
import { Card, CardHeader } from '../components/Card';
import shared from './shared.module.css';
import styles from './PayrollPage.module.css';

/* ---------------- Types ---------------- */
interface PayrollRun {
  id: string;
  period: string;
  payDate: string | null;
  currency: string;
  status: string;
  totalGrossMinor: number;
  totalNetMinor: number;
  totalTaxMinor: number;
  totalEmployerCostMinor: number;
  headcount: number;
  createdAt: string;
}
interface Payslip {
  id: string;
  employeeId: string;
  grossMinor: number;
  taxableMinor: number;
  incomeTaxMinor: number;
  employeeSocialMinor: number;
  netMinor: number;
  employerCostMinor: number;
  currency: string;
  detail: unknown;
  employeeName: string;
}
interface PayrollRunDetail extends PayrollRun {
  payslips: Payslip[];
}

interface TaxBand { from: string; rate: string; }
interface CreateRunBody {
  period: string;
  payDate?: string;
  currency: string;
  taxBands: { from: number; rate: number }[];
  employeeSocialRate: number;
  employerSocialRate: number;
}

/* ---------------- Data hooks (local) ---------------- */
function usePayrollRuns() {
  return useQuery({
    queryKey: ['hr', 'payroll', 'runs'],
    queryFn: () => api<{ runs: PayrollRun[] }>('/api/hr/payroll/runs'),
  });
}
function usePayrollRun(id: string | null) {
  return useQuery({
    queryKey: ['hr', 'payroll', 'runs', id],
    queryFn: () => api<PayrollRunDetail>(`/api/hr/payroll/runs/${id}`),
    enabled: !!id,
  });
}
function useCreateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRunBody) =>
      api<{ id: string; period: string; headcount: number; totalGrossMinor: number; totalNetMinor: number }>(
        '/api/hr/payroll/runs',
        { body },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr', 'payroll', 'runs'] }),
  });
}
function useApproveRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ id: string; status: string }>(`/api/hr/payroll/runs/${id}/approve`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr', 'payroll', 'runs'] }),
  });
}

export function PayrollPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('hr:write');
  const toast = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = usePayrollRuns();
  const runs = data?.runs ?? [];
  const primaryCurrency = runs[0]?.currency ?? 'USD';
  const totalHeadcount = runs.reduce((acc, r) => acc + (r.headcount ?? 0), 0);
  const totalGross = runs.reduce((acc, r) => acc + (r.totalGrossMinor ?? 0), 0);
  const totalNet = runs.reduce((acc, r) => acc + (r.totalNetMinor ?? 0), 0);
  const [showRun, setShowRun] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const approve = useApproveRun();

  const runApprove = async (id: string) => {
    try {
      const res = await approve.mutateAsync(id);
      toast.success(`Run ${titleCase(res.status)}`);
      qc.invalidateQueries({ queryKey: ['hr', 'payroll', 'runs', id] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not approve the run.');
    }
  };

  const columns: Column<PayrollRun>[] = [
    { key: 'period', header: 'Period', sortValue: (r) => r.period, render: (r) => <span className={shared.cellMain}>{r.period}</span> },
    { key: 'payDate', header: 'Pay date', sortValue: (r) => r.payDate ?? '', render: (r) => formatDate(r.payDate) },
    { key: 'headcount', header: 'Headcount', align: 'right', sortValue: (r) => r.headcount, render: (r) => r.headcount },
    { key: 'gross', header: 'Total gross', align: 'right', sortValue: (r) => r.totalGrossMinor, render: (r) => <span className={shared.money}>{formatMoney(r.totalGrossMinor, r.currency)}</span> },
    { key: 'net', header: 'Total net', align: 'right', sortValue: (r) => r.totalNetMinor, render: (r) => <span className={shared.money}>{formatMoney(r.totalNetMinor, r.currency)}</span> },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, render: (r) => <StatusPill status={r.status} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <div className={shared.toolbar} style={{ justifyContent: 'flex-end' }}>
          <Button size="sm" variant="secondary" onClick={() => setDetailId(r.id)}>Payslips</Button>
          {canWrite && r.status === 'draft' && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => runApprove(r.id)}
              loading={approve.isPending && approve.variables === r.id}
            >
              Approve
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Payroll"
        description="Run gross-to-net payroll across the active workforce and approve for payment."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Payroll' }]}
        actions={
          canWrite ? (
            <Button variant="primary" onClick={() => setShowRun(true)} icon={<span aria-hidden>+</span>}>
              Run payroll
            </Button>
          ) : null
        }
      />

      <div className={styles.page}>
        <div className={styles.kpis}>
          <KpiCard label="Payroll runs" value={formatNumber(runs.length)} hint="Across all periods" icon={<Banknote size={20} />} accent="var(--primary)" loading={isLoading} />
          <KpiCard label="Total gross" value={formatMoney(totalGross, primaryCurrency)} hint="Cumulative gross pay" icon={<Wallet size={20} />} accent="var(--accent-violet)" loading={isLoading} />
          <KpiCard label="Total net" value={formatMoney(totalNet, primaryCurrency)} hint="Paid to employees" icon={<Landmark size={20} />} accent="var(--accent-cyan)" loading={isLoading} />
          <KpiCard label="Headcount" value={formatNumber(totalHeadcount)} hint="Payslips generated" icon={<Users size={20} />} accent="var(--accent-emerald)" loading={isLoading} />
        </div>

        <Card padded={false}>
          <div className={styles.cardHead}>
            <CardHeader
              title="Payroll runs"
              subtitle="Each run computes payslips for every active, salaried employee, then approves for payment."
              actions={<span className={shared.cellSub}>{runs.length} run{runs.length === 1 ? '' : 's'}</span>}
            />
          </div>
          <Table
            columns={columns}
            rows={data?.runs}
            loading={isLoading}
            rowKey={(r) => r.id}
            empty={<EmptyState title="No payroll runs" message="Run payroll to generate payslips for the workforce." icon={<Banknote size={28} />} />}
          />
        </Card>
      </div>

      <RunPayrollModal open={showRun} onClose={() => setShowRun(false)} />
      <PayslipsModal id={detailId} onClose={() => setDetailId(null)} />
    </>
  );
}

/* ---------------- Run payroll modal ---------------- */
function RunPayrollModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateRun();
  const { data: ccyData } = useCurrencies();
  const currencies = ccyData?.currencies ?? [];
  const [period, setPeriod] = useState('');
  const [payDate, setPayDate] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [bands, setBands] = useState<TaxBand[]>([
    { from: '0', rate: '0.1' },
    { from: '50000', rate: '0.25' },
  ]);
  const [employeeSocialRate, setEmployeeSocialRate] = useState('0.08');
  const [employerSocialRate, setEmployerSocialRate] = useState('0.12');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPeriod(''); setPayDate(''); setCurrency('USD');
    setBands([{ from: '0', rate: '0.1' }, { from: '50000', rate: '0.25' }]);
    setEmployeeSocialRate('0.08'); setEmployerSocialRate('0.12'); setError(null);
  };
  const close = () => { reset(); onClose(); };

  const setBand = (i: number, key: keyof TaxBand, v: string) => {
    setBands((bs) => bs.map((b, idx) => (idx === i ? { ...b, [key]: v } : b)));
  };
  const addBand = () => setBands((bs) => [...bs, { from: '', rate: '' }]);
  const removeBand = (i: number) => setBands((bs) => bs.filter((_, idx) => idx !== i));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!period.trim()) { setError('Enter a period (e.g. 2026-06).'); return; }
    const empRate = Number(employeeSocialRate);
    const erRate = Number(employerSocialRate);
    if (Number.isNaN(empRate) || empRate < 0 || Number.isNaN(erRate) || erRate < 0) {
      setError('Enter valid social contribution rates.');
      return;
    }
    const taxBands: { from: number; rate: number }[] = [];
    for (const b of bands) {
      if (b.from === '' && b.rate === '') continue;
      const from = Number(b.from);
      const rate = Number(b.rate);
      if (Number.isNaN(from) || from < 0 || Number.isNaN(rate)) {
        setError('Each tax band needs a non-negative threshold (major units) and a rate.');
        return;
      }
      taxBands.push({ from, rate });
    }
    try {
      const res = await create.mutateAsync({
        period,
        payDate: payDate || undefined,
        currency,
        taxBands,
        employeeSocialRate: empRate,
        employerSocialRate: erRate,
      });
      toast.success(`Payroll run for ${res.period} created (${res.headcount} employees)`);
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not run payroll.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title="Run payroll"
      description="Compute payslips for every active, salaried employee. Tax-band thresholds are in major currency units."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!period.trim()}>
            Run payroll
          </Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Run period">
          <FormField label="Period" required hint="e.g. 2026-06">
            <Input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-06" />
          </FormField>
          <FormField label="Pay date" hint="Defaults to today if unset">
            <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
          </FormField>
          <FormField label="Currency" required>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencies.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
            </Select>
          </FormField>
        </FormSection>

        <FormSection title="Income tax bands" description="Progressive income tax. Threshold in major units of the selected currency; rate as a fraction (e.g. 0.25).">
          <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {bands.map((b, i) => (
              <div key={i} className={shared.toolbar}>
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={b.from}
                  onChange={(e) => setBand(i, 'from', e.target.value)}
                  placeholder="From (major)"
                  aria-label={`Tax band ${i + 1} threshold`}
                  style={{ flex: 1 }}
                />
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={b.rate}
                  onChange={(e) => setBand(i, 'rate', e.target.value)}
                  placeholder="Rate (e.g. 0.25)"
                  aria-label={`Tax band ${i + 1} rate`}
                  style={{ flex: 1 }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => removeBand(i)}
                  disabled={bands.length <= 1}
                >
                  Remove
                </Button>
              </div>
            ))}
            <div>
              <Button type="button" size="sm" variant="secondary" onClick={addBand}>Add band</Button>
            </div>
          </div>
        </FormSection>

        <FormSection title="Social contributions" description="Contribution rates as a fraction of gross pay.">
          <FormField label="Employee social rate" hint="Fraction, e.g. 0.08">
            <Input type="number" min="0" step="any" value={employeeSocialRate} onChange={(e) => setEmployeeSocialRate(e.target.value)} placeholder="0.08" />
          </FormField>
          <FormField label="Employer social rate" hint="Fraction, e.g. 0.12">
            <Input type="number" min="0" step="any" value={employerSocialRate} onChange={(e) => setEmployerSocialRate(e.target.value)} placeholder="0.12" />
          </FormField>
        </FormSection>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- Payslips modal ---------------- */
function PayslipsModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isLoading } = usePayrollRun(id);
  const slips = data?.payslips ?? [];
  const currency = data?.currency ?? 'USD';

  const columns: Column<Payslip>[] = [
    { key: 'employee', header: 'Employee', sortValue: (s) => s.employeeName, render: (s) => <span className={shared.cellMain}>{s.employeeName}</span> },
    { key: 'gross', header: 'Gross', align: 'right', sortValue: (s) => s.grossMinor, render: (s) => <span className={shared.money}>{formatMoney(s.grossMinor, s.currency)}</span> },
    { key: 'tax', header: 'Tax', align: 'right', sortValue: (s) => s.incomeTaxMinor, render: (s) => <span className={shared.money}>{formatMoney(s.incomeTaxMinor, s.currency)}</span> },
    { key: 'net', header: 'Net', align: 'right', sortValue: (s) => s.netMinor, render: (s) => <span className={shared.money}>{formatMoney(s.netMinor, s.currency)}</span> },
  ];

  return (
    <Modal
      open={!!id}
      onClose={onClose}
      size="lg"
      title="Payslips"
      description={data ? `${data.period} · ${data.headcount} employees · ${titleCase(data.status)}` : 'Payroll run'}
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      {data && (
        <div className={styles.payslipTotals}>
          <div className={styles.totalBlock}>
            <span className={styles.totalLabel}>Total gross</span>
            <span className={styles.totalValue}>{formatMoney(data.totalGrossMinor, currency)}</span>
          </div>
          <div className={styles.totalBlock}>
            <span className={styles.totalLabel}>Total tax</span>
            <span className={styles.totalValue}>{formatMoney(data.totalTaxMinor, currency)}</span>
          </div>
          <div className={styles.totalBlock}>
            <span className={styles.totalLabel}>Total net</span>
            <span className={`${styles.totalValue} ${styles.totalNet}`}>{formatMoney(data.totalNetMinor, currency)}</span>
          </div>
        </div>
      )}
      <Table
        columns={columns}
        rows={isLoading ? undefined : slips}
        loading={isLoading}
        rowKey={(s) => s.id}
        empty={<EmptyState title="No payslips" message="This run produced no payslips." icon={<Banknote size={16} />} />}
      />
    </Modal>
  );
}
