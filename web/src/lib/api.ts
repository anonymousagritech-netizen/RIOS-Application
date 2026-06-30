/** Thin fetch wrapper that adds bearer auth and normalises errors. */

const TOKEN_KEY = 'rios.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Listeners notified on auth-relevant failures so the app shell can react. */
type AuthEvent = 'unauthorized' | 'forbidden';
const authListeners = new Set<(e: AuthEvent, detail?: string) => void>();
export function onAuthEvent(fn: (e: AuthEvent, detail?: string) => void) {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}
function emitAuth(e: AuthEvent, detail?: string) {
  authListeners.forEach((fn) => fn(e, detail));
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Origin of the API. Empty in dev (Vite proxies '/api' → the server). In a
 * production build set VITE_API_URL to the backend origin (e.g. the Render URL)
 * so the static SPA on Vercel calls the right host. CORS is enabled server-side.
 */
export const API_BASE: string = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

/** Resolve a request path against the API base, defaulting bare names to /api/. */
export function apiUrl(path: string): string {
  return API_BASE + (path.startsWith('/') ? path : `/api/${path}`);
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(apiUrl(path), {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body,
    signal: opts.signal,
  });

  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }

  if (!res.ok) {
    const message =
      (payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : null) ?? res.statusText ?? 'Request failed';
    if (res.status === 401) emitAuth('unauthorized');
    if (res.status === 403) emitAuth('forbidden', message);
    throw new ApiError(res.status, message, payload);
  }

  return payload as T;
}

/** Build a query string from a record, skipping empty values. */
export function qs(params: Record<string, string | undefined | null>): string {
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== '');
  if (!entries.length) return '';
  const sp = new URLSearchParams();
  entries.forEach(([k, v]) => sp.set(k, String(v)));
  return `?${sp.toString()}`;
}
