import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useCurrencies } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { Button } from '../components/Button';
import { FormField, Input, Select } from '../components/Form';
import { DefinitionList } from '../components/Feedback';
import { formatMoney, formatPercent, formatDateTime, titleCase } from '../lib/format';
import shared from './shared.module.css';

interface Money { amount: number; currency: string }

interface BurningCostResult {
  technicalPremium: Money;
  rateOnLine: number;
  pureBurningCost: number;
  loadedBurningCost: number;
  totalLayerLosses: Money;
  perYear?: { year: number; losses: Money }[];
}

interface ExposureResult {
  expectedLoss: Money;
  technicalPremium: Money;
  rateOnLine: number;
}

interface RatingRun {
  id: string;
  method: string;
  technical_premium_minor: number;
  rate_on_line: number;
  currency: string;
  created_at: string;
}
interface RunsResponse { runs: RatingRun[] }

interface ExperienceYear { year: string; subjectPremium: string; losses: string }

function useRatingRuns(contractId: string | undefined) {
  return useQuery({
    queryKey: ['pricing', 'runs', contractId ?? null],
    queryFn: () => api<RunsResponse>(`/api/pricing/runs${qs({ contractId })}`),
  });
}

function useBurningCost() {
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api<BurningCostResult>('/api/pricing/burning-cost', { body }),
  });
}

function useExposureRating() {
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api<ExposureResult>('/api/pricing/exposure', { body }),
  });
}

export function PricingPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('pricing:write');
  const { data: runsData, isLoading: runsLoading } = useRatingRuns(undefined);

  const runColumns: Column<RatingRun>[] = [
    { key: 'method', header: 'Method', sortValue: (r) => r.method, render: (r) => <span className={shared.cellMain}>{titleCase(r.method)}</span> },
    { key: 'premium', header: 'Technical premium', align: 'right', sortValue: (r) => r.technical_premium_minor, render: (r) => <span className={shared.money}>{formatMoney(r.technical_premium_minor, r.currency)}</span> },
    { key: 'rol', header: 'Rate on line', align: 'right', sortValue: (r) => r.rate_on_line, render: (r) => formatPercent(r.rate_on_line) },
    { key: 'ccy', header: 'CCY', sortValue: (r) => r.currency, render: (r) => r.currency },
    { key: 'created', header: 'Run at', align: 'right', sortValue: (r) => r.created_at, render: (r) => formatDateTime(r.created_at) },
  ];

  return (
    <>
      <PageHeader
        title="Pricing"
        description="Actuarial rating of excess-of-loss layers via burning-cost and exposure methods."
      />

      {!canWrite && (
        <Card>
          <p className={shared.cellSub} style={{ margin: 0 }}>
            You have read-only access. Rating runs require the <code>pricing:write</code> permission.
          </p>
        </Card>
      )}

      <div className={shared.grid2} style={{ display: 'grid', marginBottom: 'var(--space-5)' }}>
        <BurningCostCard canWrite={canWrite} />
        <ExposureCard canWrite={canWrite} />
      </div>

      <Card padded={false}>
        <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
          <CardHeader title="Recent rating runs" subtitle="Saved burning-cost and exposure runs across the portfolio." />
        </div>
        <Table
          columns={runColumns}
          rows={runsData?.runs}
          loading={runsLoading}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No rating runs" message="Run a burning-cost or exposure rating to populate this list." icon="∿" />}
          skeletonRows={3}
        />
      </Card>
    </>
  );
}

function BurningCostCard({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const { data: ccy } = useCurrencies();
  const rate = useBurningCost();

  const [currency, setCurrency] = useState('USD');
  const [attachment, setAttachment] = useState('');
  const [limit, setLimit] = useState('');
  const [reinstatements, setReinstatements] = useState('');
  const [loadingFactor, setLoadingFactor] = useState('1.1');
  const [minRateOnLine, setMinRateOnLine] = useState('');
  const [currentSubjectPremium, setCurrentSubjectPremium] = useState('');
  const [years, setYears] = useState<ExperienceYear[]>([
    { year: String(new Date().getFullYear() - 1), subjectPremium: '', losses: '' },
  ]);
  const [result, setResult] = useState<BurningCostResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currencies = ccy?.currencies ?? [];

  const setYear = (i: number, patch: Partial<ExperienceYear>) =>
    setYears((ys) => ys.map((y, idx) => (idx === i ? { ...y, ...patch } : y)));
  const addYear = () => setYears((ys) => [...ys, { year: '', subjectPremium: '', losses: '' }]);
  const removeYear = (i: number) => setYears((ys) => ys.filter((_, idx) => idx !== i));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const att = Number(attachment);
    const lim = Number(limit);
    if (Number.isNaN(att) || Number.isNaN(lim) || lim <= 0) { setError('Enter a valid attachment and limit.'); return; }
    const parsedYears = years
      .filter((y) => y.year.trim())
      .map((y) => ({
        year: Number(y.year),
        subjectPremium: Number(y.subjectPremium) || 0,
        losses: y.losses.split(',').map((l) => Number(l.trim())).filter((n) => !Number.isNaN(n) && n !== 0),
      }));
    if (!parsedYears.length) { setError('Add at least one experience year.'); return; }
    const body: Record<string, unknown> = {
      currency,
      attachment: att,
      limit: lim,
      loadingFactor: Number(loadingFactor) || 1,
      currentSubjectPremium: Number(currentSubjectPremium) || 0,
      years: parsedYears,
    };
    if (reinstatements) body.reinstatements = Number(reinstatements);
    if (minRateOnLine) body.minRateOnLine = Number(minRateOnLine);
    try {
      const res = await rate.mutateAsync(body);
      setResult(res);
      toast.success('Burning-cost rating complete');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not run the burning-cost rating.');
    }
  };

  return (
    <Card>
      <CardHeader title="Burning cost" subtitle="Rate a layer from historical loss experience. Amounts are in major units." />
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Currency" required>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {(currencies.length ? currencies.map((c) => c.code) : ['USD', 'EUR', 'GBP', 'JPY']).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </FormField>
          <FormField label="Reinstatements">
            <Input type="number" min="0" step="1" value={reinstatements} onChange={(e) => setReinstatements(e.target.value)} placeholder="e.g. 1" />
          </FormField>
          <FormField label="Attachment (major)" required>
            <Input type="number" min="0" step="any" value={attachment} onChange={(e) => setAttachment(e.target.value)} placeholder="e.g. 1000000" />
          </FormField>
          <FormField label="Limit (major)" required>
            <Input type="number" min="0" step="any" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="e.g. 4000000" />
          </FormField>
          <FormField label="Loading factor" required>
            <Input type="number" min="0" step="any" value={loadingFactor} onChange={(e) => setLoadingFactor(e.target.value)} placeholder="e.g. 1.1" />
          </FormField>
          <FormField label="Min rate on line">
            <Input type="number" min="0" max="1" step="any" value={minRateOnLine} onChange={(e) => setMinRateOnLine(e.target.value)} placeholder="e.g. 0.02" />
          </FormField>
        </div>
        <FormField label="Current subject premium (major)" required>
          <Input type="number" min="0" step="any" value={currentSubjectPremium} onChange={(e) => setCurrentSubjectPremium(e.target.value)} placeholder="e.g. 8000000" />
        </FormField>

        <div>
          <div className={shared.toolbar} style={{ marginBottom: 'var(--space-2)' }}>
            <span className={shared.filterLabel}>Experience years</span>
            <div className={shared.spacer} />
            <Button type="button" size="sm" variant="subtle" onClick={addYear} icon={<span aria-hidden>+</span>}>Add year</Button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {years.map((y, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 2fr auto', gap: 'var(--space-2)', alignItems: 'center' }}>
                <Input type="number" step="1" value={y.year} onChange={(e) => setYear(i, { year: e.target.value })} placeholder="Year" aria-label="Year" />
                <Input type="number" step="any" value={y.subjectPremium} onChange={(e) => setYear(i, { subjectPremium: e.target.value })} placeholder="Subject premium" aria-label="Subject premium" />
                <Input type="text" value={y.losses} onChange={(e) => setYear(i, { losses: e.target.value })} placeholder="Losses, comma-separated" aria-label="Losses" />
                <Button type="button" size="sm" variant="ghost" onClick={() => removeYear(i)} disabled={years.length === 1} aria-label="Remove year">×</Button>
              </div>
            ))}
          </div>
        </div>

        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)', margin: 0 }} role="alert">{error}</p>}
        <div>
          <Button variant="primary" onClick={submit} loading={rate.isPending} disabled={!canWrite}>Run burning cost</Button>
        </div>
      </form>

      {result && (
        <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-4)', borderTop: '1px solid var(--border)' }}>
          <DefinitionList
            items={[
              { term: 'Technical premium', value: <strong>{formatMoney(result.technicalPremium.amount, result.technicalPremium.currency)}</strong> },
              { term: 'Rate on line', value: formatPercent(result.rateOnLine) },
              { term: 'Pure burning cost', value: formatPercent(result.pureBurningCost) },
              { term: 'Loaded burning cost', value: formatPercent(result.loadedBurningCost) },
              { term: 'Total layer losses', value: formatMoney(result.totalLayerLosses.amount, result.totalLayerLosses.currency) },
            ]}
          />
        </div>
      )}
    </Card>
  );
}

function ExposureCard({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const { data: ccy } = useCurrencies();
  const rate = useExposureRating();

  const [currency, setCurrency] = useState('USD');
  const [attachment, setAttachment] = useState('');
  const [limit, setLimit] = useState('');
  const [reinstatements, setReinstatements] = useState('');
  const [alpha, setAlpha] = useState('1.5');
  const [bands, setBands] = useState<{ bandLimit: string; premium: string; lossRatio: string }[]>([
    { bandLimit: '', premium: '', lossRatio: '' },
  ]);
  const [result, setResult] = useState<ExposureResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currencies = ccy?.currencies ?? [];

  const setBand = (i: number, patch: Partial<{ bandLimit: string; premium: string; lossRatio: string }>) =>
    setBands((bs) => bs.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  const addBand = () => setBands((bs) => [...bs, { bandLimit: '', premium: '', lossRatio: '' }]);
  const removeBand = (i: number) => setBands((bs) => bs.filter((_, idx) => idx !== i));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const att = Number(attachment);
    const lim = Number(limit);
    if (Number.isNaN(att) || Number.isNaN(lim) || lim <= 0) { setError('Enter a valid attachment and limit.'); return; }
    const parsedBands = bands
      .filter((b) => b.bandLimit.trim())
      .map((b) => ({ bandLimit: Number(b.bandLimit) || 0, premium: Number(b.premium) || 0, lossRatio: Number(b.lossRatio) || 0 }));
    if (!parsedBands.length) { setError('Add at least one exposure band.'); return; }
    const body: Record<string, unknown> = {
      currency,
      attachment: att,
      limit: lim,
      alpha: Number(alpha) || 1,
      bands: parsedBands,
    };
    if (reinstatements) body.reinstatements = Number(reinstatements);
    try {
      const res = await rate.mutateAsync(body);
      setResult(res);
      toast.success('Exposure rating complete');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not run the exposure rating.');
    }
  };

  return (
    <Card>
      <CardHeader title="Exposure rating" subtitle="Rate a layer from an exposure curve and risk-profile bands. Amounts are in major units." />
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Currency" required>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {(currencies.length ? currencies.map((c) => c.code) : ['USD', 'EUR', 'GBP', 'JPY']).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </FormField>
          <FormField label="Alpha (Pareto)" required>
            <Input type="number" min="0" step="any" value={alpha} onChange={(e) => setAlpha(e.target.value)} placeholder="e.g. 1.5" />
          </FormField>
          <FormField label="Attachment (major)" required>
            <Input type="number" min="0" step="any" value={attachment} onChange={(e) => setAttachment(e.target.value)} placeholder="e.g. 1000000" />
          </FormField>
          <FormField label="Limit (major)" required>
            <Input type="number" min="0" step="any" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="e.g. 4000000" />
          </FormField>
          <FormField label="Reinstatements">
            <Input type="number" min="0" step="1" value={reinstatements} onChange={(e) => setReinstatements(e.target.value)} placeholder="e.g. 1" />
          </FormField>
        </div>

        <div>
          <div className={shared.toolbar} style={{ marginBottom: 'var(--space-2)' }}>
            <span className={shared.filterLabel}>Exposure bands</span>
            <div className={shared.spacer} />
            <Button type="button" size="sm" variant="subtle" onClick={addBand} icon={<span aria-hidden>+</span>}>Add band</Button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {bands.map((b, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.4fr 1fr auto', gap: 'var(--space-2)', alignItems: 'center' }}>
                <Input type="number" step="any" value={b.bandLimit} onChange={(e) => setBand(i, { bandLimit: e.target.value })} placeholder="Band limit" aria-label="Band limit" />
                <Input type="number" step="any" value={b.premium} onChange={(e) => setBand(i, { premium: e.target.value })} placeholder="Premium" aria-label="Premium" />
                <Input type="number" step="any" value={b.lossRatio} onChange={(e) => setBand(i, { lossRatio: e.target.value })} placeholder="Loss ratio" aria-label="Loss ratio" />
                <Button type="button" size="sm" variant="ghost" onClick={() => removeBand(i)} disabled={bands.length === 1} aria-label="Remove band">×</Button>
              </div>
            ))}
          </div>
        </div>

        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)', margin: 0 }} role="alert">{error}</p>}
        <div>
          <Button variant="primary" onClick={submit} loading={rate.isPending} disabled={!canWrite}>Run exposure rating</Button>
        </div>
      </form>

      {result && (
        <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-4)', borderTop: '1px solid var(--border)' }}>
          <DefinitionList
            items={[
              { term: 'Expected loss', value: formatMoney(result.expectedLoss.amount, result.expectedLoss.currency) },
              { term: 'Technical premium', value: <strong>{formatMoney(result.technicalPremium.amount, result.technicalPremium.currency)}</strong> },
              { term: 'Rate on line', value: formatPercent(result.rateOnLine) },
            ]}
          />
        </div>
      )}
    </Card>
  );
}
