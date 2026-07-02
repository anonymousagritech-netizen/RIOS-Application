import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs } from './api';
import type {
  DashboardSummary, CodeListsResponse, CurrenciesResponse, PartiesResponse,
  PartyDetail, TreatiesResponse, TreatyDetail, FinancialEventsResponse,
  StatementResponse, PostResponse, ClaimsResponse, ClaimDetail,
  TransitionResponse, AssistantReply,
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
