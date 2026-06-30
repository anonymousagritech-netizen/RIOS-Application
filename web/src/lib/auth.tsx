import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import type { AuthUser, LoginResponse } from '@rios/shared';
import { api, getToken, setToken, onAuthEvent } from './api';
import type { MeResponse } from './types';

interface AuthCtx {
  user: AuthUser | null;
  token: string | null;
  status: 'loading' | 'authed' | 'anon';
  login: (email: string, password: string, tenantCode: string) => Promise<void>;
  logout: () => void;
  hasPermission: (perm: string) => boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setTok] = useState<string | null>(getToken());
  const [status, setStatus] = useState<'loading' | 'authed' | 'anon'>(
    getToken() ? 'loading' : 'anon',
  );

  const logout = useCallback(() => {
    setToken(null);
    setTok(null);
    setUser(null);
    setStatus('anon');
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

  const login = useCallback(async (email: string, password: string, tenantCode: string) => {
    const res = await api<LoginResponse>('/api/auth/login', {
      body: { email, password, tenantCode },
    });
    setToken(res.token);
    setTok(res.token);
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
    () => ({ user, token, status, login, logout, hasPermission }),
    [user, token, status, login, logout, hasPermission],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
