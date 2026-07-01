import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileText, ShieldAlert, BookOpen, BarChart3, Users, PiggyBank,
  Scale, Workflow, Boxes, Calculator, Network, UserRound,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Button } from '../components/Button';
import { TextField } from '../components/Form';
import { ThemeToggle } from '../components/ThemeToggle';
import { ApiError } from '../lib/api';
import styles from './LoginPage.module.css';

const DEMO_ACCOUNTS = [
  { email: 'admin@demo.rios', label: 'Administrator', note: 'All permissions' },
  { email: 'uw@demo.rios', label: 'Underwriter', note: 'Treaty management' },
  { email: 'acct@demo.rios', label: 'Accountant', note: 'Accounting & posting' },
  { email: 'claims@demo.rios', label: 'Claims handler', note: 'Claims' },
];

const MODULES = [
  { icon: FileText, label: 'Treaties' },
  { icon: Calculator, label: 'Pricing' },
  { icon: ShieldAlert, label: 'Claims' },
  { icon: BookOpen, label: 'Accounting' },
  { icon: PiggyBank, label: 'Treasury' },
  { icon: BarChart3, label: 'Analytics' },
  { icon: Scale, label: 'Regulatory' },
  { icon: Workflow, label: 'Workflow' },
  { icon: Users, label: 'Parties' },
  { icon: Boxes, label: 'Products' },
  { icon: UserRound, label: 'HRMS' },
  { icon: Network, label: 'Integration' },
];

export function LoginPage() {
  const { login, completeMfa, applySession } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('admin@demo.rios');
  const [password, setPassword] = useState('demo1234');
  const [tenantCode, setTenantCode] = useState('demo');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [view, setView] = useState<'signin' | 'reset'>('signin');
  const [resetSent, setResetSent] = useState(false);

  // Adopt an SSO token handed back via the redirect fragment (#sso_token=…).
  useEffect(() => {
    const m = window.location.hash.match(/sso_token=([^&]+)/);
    if (!m) return;
    window.history.replaceState(null, '', window.location.pathname);
    applySession(decodeURIComponent(m[1]!))
      .then(() => navigate('/home', { replace: true }))
      .catch(() => setError('SSO sign-in could not be completed.'));
  }, [applySession, navigate]);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const outcome = await login(email, password, tenantCode);
      if (outcome.status === 'mfa') {
        setMfaToken(outcome.mfaToken);
      } else {
        navigate('/home', { replace: true });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in. Check your credentials.');
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!mfaToken) return;
    setError(null);
    setBusy(true);
    try {
      await completeMfa(mfaToken, code.trim());
      navigate('/home', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid authentication code.');
    } finally {
      setBusy(false);
    }
  };

  const quickFill = (e: string) => {
    setEmail(e);
    setPassword('demo1234');
    setTenantCode('demo');
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.themeToggle}><ThemeToggle /></div>

      <aside className={styles.brandPanel}>
        <div className={styles.brandTop}>
          <span className={styles.logo} aria-hidden>R</span>
          <span className={styles.brandName}>RIOS</span>
        </div>
        <div className={styles.brandBody}>
          <h1 className={styles.tagline}>The reinsurance operating system for modern carriers.</h1>
          <p className={styles.blurb}>
            Treaty lifecycle, claims, accounting and configurable workflows - unified in one
            confident, auditable platform.
          </p>
          <div className={styles.modulesHead}>
            <span className={styles.modulesCount}>40+</span>
            <span>Integrated modules across the reinsurance lifecycle</span>
          </div>
          <div className={styles.modulesGrid}>
            {MODULES.map((m) => (
              <div key={m.label} className={styles.module}>
                <span className={styles.moduleIcon}><m.icon size={16} /></span>
                {m.label}
              </div>
            ))}
          </div>
        </div>
        <p className={styles.brandFoot}>Reinsurance Intelligent Operating System</p>
      </aside>

      <main className={styles.formPanel}>
        {mfaToken ? (
          <form className={styles.card} onSubmit={submitMfa}>
            <h2 className={styles.title}>Two-factor authentication</h2>
            <p className={styles.subtitle}>Enter the 6-digit code from your authenticator app.</p>
            <div className={styles.fields}>
              <TextField label="Authentication code" value={code} onChange={setCode} required />
            </div>
            {error && <p className={styles.error} role="alert">{error}</p>}
            <Button type="submit" variant="primary" size="lg" loading={busy} className={styles.submit}>
              Verify & sign in
            </Button>
            <button type="button" className={styles.linkBtn} onClick={() => { setMfaToken(null); setCode(''); setError(null); }}>
              ← Back to sign in
            </button>
          </form>
        ) : view === 'reset' ? (
          <div className={styles.card}>
            <h2 className={styles.title}>Reset password</h2>
            <p className={styles.subtitle}>
              Enter your email and we&apos;ll notify your workspace administrator to reset it.
            </p>
            {resetSent ? (
              <p className={styles.resetOk} role="status">
                If an account exists for <strong>{email}</strong>, your administrator has been
                notified and will help you reset your password.
              </p>
            ) : (
              <>
                <div className={styles.fields}>
                  <TextField label="Email" type="email" value={email} onChange={setEmail} required />
                  <TextField label="Tenant code" value={tenantCode} onChange={setTenantCode} required />
                </div>
                <Button
                  type="button"
                  variant="primary"
                  size="lg"
                  className={styles.submit}
                  disabled={!email.trim()}
                  onClick={() => setResetSent(true)}
                >
                  Request password reset
                </Button>
              </>
            )}
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => { setView('signin'); setResetSent(false); setError(null); }}
            >
              ← Back to sign in
            </button>
          </div>
        ) : (
        <form className={styles.card} onSubmit={submit}>
          <h2 className={styles.title}>Sign in</h2>
          <p className={styles.subtitle}>Use a demo account below or enter your credentials.</p>

          <div className={styles.fields}>
            <TextField label="Email" type="email" value={email} onChange={setEmail} required />
            <TextField label="Password" type="password" value={password} onChange={setPassword} required />
            <TextField label="Tenant code" value={tenantCode} onChange={setTenantCode} required />
          </div>

          <button type="button" className={styles.forgot} onClick={() => { setView('reset'); setError(null); }}>
            Forgot password?
          </button>

          {error && <p className={styles.error} role="alert">{error}</p>}

          <Button type="submit" variant="primary" size="lg" loading={busy} className={styles.submit}>
            Sign in
          </Button>

          <div className={styles.divider}><span>Quick-fill demo accounts</span></div>

          <div className={styles.demoGrid}>
            {DEMO_ACCOUNTS.map((a) => (
              <button
                type="button"
                key={a.email}
                className={`${styles.demo} ${email === a.email ? styles.demoActive : ''}`}
                onClick={() => quickFill(a.email)}
              >
                <strong>{a.label}</strong>
                <span className={styles.demoEmail}>{a.email}</span>
                <span className={styles.demoNote}>{a.note}</span>
              </button>
            ))}
          </div>
          <p className={styles.hint}>All demo passwords are <code>demo1234</code>, tenant <code>demo</code>.</p>
        </form>
        )}
      </main>
    </div>
  );
}
