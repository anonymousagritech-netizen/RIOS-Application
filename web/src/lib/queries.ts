import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs } from './api';
import type {
  DashboardSummary, CodeListsResponse, CurrenciesResponse, PartiesResponse,
  PartyDetail, TreatiesResponse, TreatyDetail, FinancialEventsResponse,
  StatementResponse, PostResponse, ClaimsResponse, ClaimDetail,
  TransitionResponse, AssistantReply, SoaEntriesResponse,
} from './types';
import type { CodeValueDTO } from '@rios/shared';

/* ---------------- Dashboard ---------------- */
export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<DashboardSummary>('/api/dashboard/summary'),
  });
}

/* ---------------- Config ---------------- */
export function useCodeLists() {
  return useQuery({
    queryKey: ['code-lists'],
    queryFn: () => api<CodeListsResponse>('/api/config/code-lists'),
    staleTime: 5 * 60 * 1000,
  });
}

export function useCurrencies() {
  return useQuery({
    queryKey: ['currencies'],
    queryFn: () => api<CurrenciesResponse>('/api/config/currencies'),
    staleTime: 30 * 60 * 1000,
  });
}

export function useAddCodeValue(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { code: string; label: string; meta?: Record<string, unknown> }) =>
      api<CodeValueDTO>(`/api/config/code-lists/${key}/values`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['code-lists'] }),
  });
}

/** Convenience hook: returns a map of code -> meta.color for a given list key. */
export function useStatusColors(listKey: string): Record<string, string> {
  const { data } = useCodeLists();
  const list = data?.lists?.[listKey] ?? [];
  const map: Record<string, string> = {};
  for (const v of list) {
    const color = (v.meta as { color?: string } | undefined)?.color;
    if (color) map[v.code] = color;
  }
  return map;
}

/* ---------------- Parties ---------------- */
export function useParties(params: { q?: string; role?: string }) {
  return useQuery({
    queryKey: ['parties', params],
    queryFn: () => api<PartiesResponse>(`/api/parties${qs(params)}`),
  });
}

export function useParty(id: string | undefined) {
  return useQuery({
    queryKey: ['party', id],
    queryFn: () => api<PartyDetail>(`/api/parties/${id}`),
    enabled: !!id,
  });
}

export function useCreateParty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      legalName: string; shortName?: string; kind: string; country?: string; roles: string[];
      identifiers?: Record<string, string>; details?: Record<string, unknown>;
    }) => api<{ id: string; reference: string }>('/api/parties', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['parties'] }),
  });
}

/* ---------------- Treaties ---------------- */
export function useTreaties(params: { status?: string; kind?: string; cedentId?: string; brokerId?: string }) {
  return useQuery({
    queryKey: ['treaties', params],
    queryFn: () => api<TreatiesResponse>(`/api/treaties${qs(params)}`),
  });
}

export function useTreaty(id: string | undefined) {
  return useQuery({
    queryKey: ['treaty', id],
    queryFn: () => api<TreatyDetail>(`/api/treaties/${id}`),
    enabled: !!id,
  });
}

export function useCreateTreaty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ id: string; reference: string; status: string }>('/api/treaties', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['treaties'] }),
  });
}

export function useTransitionTreaty(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (to: string) =>
      api<TransitionResponse>(`/api/treaties/${id}/transition`, { body: { to } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['treaty', id] });
      qc.invalidateQueries({ queryKey: ['treaties'] });
      qc.invalidateQueries({ queryKey: ['financial-events', id] });
      qc.invalidateQueries({ queryKey: ['statement', id] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useFinancialEvents(id: string | undefined) {
  return useQuery({
    queryKey: ['financial-events', id],
    queryFn: () => api<FinancialEventsResponse>(`/api/treaties/${id}/financial-events`),
    enabled: !!id,
  });
}

export function useStatement(id: string | undefined) {
  return useQuery({
    queryKey: ['statement', id],
    queryFn: () => api<StatementResponse>(`/api/treaties/${id}/statement`),
    enabled: !!id,
  });
}

export function usePostToGl(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<PostResponse>(`/api/treaties/${id}/post`, { body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statement', id] }),
  });
}

/* ---------------- Claims ---------------- */
export function useClaims(params: { status?: string; contractId?: string }) {
  return useQuery({
    queryKey: ['claims', params],
    queryFn: () => api<ClaimsResponse>(`/api/claims${qs(params)}`),
  });
}

export function useClaim(id: string | undefined) {
  return useQuery({
    queryKey: ['claim', id],
    queryFn: () => api<ClaimDetail>(`/api/claims/${id}`),
    enabled: !!id,
  });
}

export function useCreateClaim() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { contractId: string; description?: string; lossDate?: string; currency: string; grossLoss: number; catEventId?: string; details?: Record<string, unknown> }) =>
      api<{ id: string; reference: string }>('/api/claims', { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['claims'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useReserveMovement(claimId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      movementType: 'OPEN' | 'INCREASE' | 'DECREASE' | 'PAYMENT' | 'CLOSE';
      outstandingDelta: number; paidDelta: number; reason?: string;
    }) => api(`/api/claims/${claimId}/reserve-movement`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['claim', claimId] });
      qc.invalidateQueries({ queryKey: ['claims'] });
    },
  });
}

/* ---------------- User Preferences ---------------- */

/**
 * Per-user, per-page preference store backed by /api/preferences/:key.
 * Typical use: persist last-used filter settings so users return to the same
 * view they left. The preference is loaded once (staleTime: Infinity) and
 * updated on mutation.
 *
 * Usage:
 *   const { value, save } = usePreference('filters:treaties', { kind: '' });
 */
export function usePreference<T>(key: string, defaultValue: T) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['preference', key],
    queryFn: async () => {
      const res = await api<{ value: T | null }>(`/api/preferences/${encodeURIComponent(key)}`);
      return (res.value ?? defaultValue) as T;
    },
    // Treat preferences as stable within a session; they only change via mutation.
    staleTime: Infinity,
    // A 404 means the preference has never been saved — treat it as the default.
    retry: (count, err: unknown) => {
      if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 404) return false;
      return count < 2;
    },
  });
  const mutation = useMutation({
    mutationFn: (value: T) =>
      api(`/api/preferences/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['preference', key] }),
  });
  return {
    value: query.data ?? defaultValue,
    save: mutation.mutateAsync,
    isLoading: query.isLoading,
  };
}

/* ---------------- SOA Entries (P3-B) ---------------- */
export function useSoaEntries(contractId: string | undefined) {
  return useQuery({
    queryKey: ['soa-entries', contractId],
    queryFn: () => api<SoaEntriesResponse>(`/api/statements/${contractId}/entries`),
    enabled: !!contractId,
  });
}

export function useAddPremiumEntry(contractId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ id: string }>('/api/statements/entries/premium', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['soa-entries', contractId] }),
  });
}

export function useAddClaimEntry(contractId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ id: string }>('/api/statements/entries/claim', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['soa-entries', contractId] }),
  });
}

/* ---------------- Assistant ---------------- */
export function useAssistant() {
  return useMutation({
    mutationFn: (message: string) => api<AssistantReply>('/api/assistant', { body: { message } }),
  });
}

export function useAssistantConfirm() {
  return useMutation({
    mutationFn: (body: { kind: string; preview: Record<string, unknown> }) =>
      api<{ ok: boolean; kind: string; id: string }>('/api/assistant/confirm', { body }),
  });
}
