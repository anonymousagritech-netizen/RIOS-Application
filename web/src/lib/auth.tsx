import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import type { AuthUser, LoginResponse } from '@rios/shared';
import { api, getToken, setToken, onAuthEvent } from './api';
import type { MeResponse } from './types';

/** Login may complete directly, or require a TOTP second factor (brief §14.1). */
export type LoginOutcome = { status: 'authed' } | { status: 'mfa'; mfaToken: string };

interface AuthCtx {
  user: AuthUser | null;
  token: string | null;
  status: 'loading' | 'authed' | 'anon';
  login: (email: string, password: string, tenantCode: string) => Promise<LoginOutcome>;
  completeMfa: (mfaToken: string, code: string) => Promise<void>;
  applySession: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (perm: string) => boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setTok] = useState<string | null>(getToken());
  const [status, setStatus] = useState<'loading' | 'authed' | 'anon'>(
    getToken() ? 'loading' : 'anon',
  );

  const logout = useCallback(async () => {
    // Revoke the token server-side (records jti in token_revocation + clears cookie).
    // Fire-and-forget: even if the request fails, clear the local session.
    try {
      await api('/api/auth/logout', { method: 'POST', body: {} });
    } catch {
      // Ignore network errors — local session is cleared regardless.
    } finally {
      setToken(null);
      setTok(null);
      setUser(null);
      setStatus('anon');
    }
  }, []);

  // Hydrate the session from /me on first load if a token exists.
  useEffect(() => {
    if (!getToken()) { setStatus('anon'); return; }
    let cancelled = false;
    api<MeResponse>('/api/auth/me')
      .then((res) => {
        if (cancelled) return;
        setUser(res.user);
        setStatus('authed');
      })
      .catch(() => { if (!cancelled) logout(); });
    return () => { cancelled = true; };
  }, [logout]);

  // Global 401 handling.
  useEffect(() => {
    const off = onAuthEvent((e) => { if (e === 'unauthorized') logout(); });
    return () => { off(); };
  }, [logout]);

  const sessionFrom = useCallback((res: LoginResponse) => {
    setToken(res.token);
    setTok(res.token);
    setUser(res.user);
    setStatus('authed');
  }, []);

  const login = useCallback(
    async (email: string, password: string, tenantCode: string): Promise<LoginOutcome> => {
      const res = await api<LoginResponse & { mfaRequired?: boolean; mfaToken?: string }>('/api/auth/login', {
        body: { email, password, tenantCode },
      });
      if (res.mfaRequired && res.mfaToken) return { status: 'mfa', mfaToken: res.mfaToken };
      sessionFrom(res);
      return { status: 'authed' };
    },
    [sessionFrom],
  );

  // Complete a two-factor login with the TOTP code.
  const completeMfa = useCallback(
    async (mfaToken: string, code: string) => {
      const res = await api<LoginResponse>('/api/auth/mfa/login', { body: { mfaToken, code } });
      sessionFrom(res);
    },
    [sessionFrom],
  );

  // Adopt a token obtained out-of-band (e.g. an SSO redirect) and hydrate /me.
  const applySession = useCallback(async (tok: string) => {
    setToken(tok);
    setTok(tok);
    const res = await api<MeResponse>('/api/auth/me');
    setUser(res.user);
    setStatus('authed');
  }, []);

  const hasPermission = useCallback(
    (perm: string) => {
      if (!user) return false;
      const perms = user.permissions ?? [];
      return perms.includes('admin:manage') || perms.includes(perm);
    },
    [user],
  );

  const value = useMemo<AuthCtx>(
    () => ({ user, token, status, login, completeMfa, applySession, logout, hasPermission }),
    [user, token, status, login, completeMfa, applySession, logout, hasPermission],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
