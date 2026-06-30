import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { KpiCard } from '../components/KpiCard';
import { TextField } from '../components/Form';
import { Spinner } from '../components/Feedback';
import { ShieldCheck, KeyRound, Fingerprint, Smartphone } from 'lucide-react';
import styles from './SecurityPage.module.css';

interface MfaStatus { enabled: boolean; enrolled: boolean }
interface EnrollResponse { secret: string; otpauthUri: string }

export function SecurityPage() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['mfa-status'], queryFn: () => api<MfaStatus>('/api/auth/mfa/status') });
  const passkeys = useQuery({ queryKey: ['passkeys'], queryFn: () => api<{ credentials: Passkey[] }>('/api/auth/webauthn/credentials') });

  const [enroll, setEnroll] = useState<EnrollResponse | null>(null);
  const [code, setCode] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const beginEnroll = useMutation({
    mutationFn: () => api<EnrollResponse>('/api/auth/mfa/enroll', { body: {} }),
    onSuccess: (r) => setEnroll(r),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not start enrollment'),
  });
  const verify = useMutation({
    mutationFn: () => api('/api/auth/mfa/verify', { body: { code: code.trim() } }),
    onSuccess: () => { toast.success('Two-factor authentication enabled'); setEnroll(null); setCode(''); qc.invalidateQueries({ queryKey: ['mfa-status'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Verification failed'),
  });
  const disable = useMutation({
    mutationFn: () => api('/api/auth/mfa/disable', { body: { code: disableCode.trim() } }),
    onSuccess: () => { toast.success('Two-factor authentication disabled'); setDisableCode(''); qc.invalidateQueries({ queryKey: ['mfa-status'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not disable'),
  });

  const enabled = status.data?.enabled;

  const passkeyCount = passkeys.data?.credentials.length ?? 0;
  const strong = !!enabled || passkeyCount > 0;

  return (
    <>
      <PageHeader
        title="Security"
        description="Manage two-factor authentication and passkeys protecting your account."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Security' }]}
      />

      <div className={styles.kpiRow}>
        <KpiCard
          label="Account posture"
          value={strong ? 'Hardened' : 'Basic'}
          hint={strong ? 'A second factor is configured' : 'Add a second factor to harden sign-in'}
          icon={<ShieldCheck size={20} />}
          accent={strong ? 'var(--accent-emerald)' : 'var(--accent-orange)'}
          loading={status.isLoading}
        />
        <KpiCard
          label="Authenticator (TOTP)"
          value={enabled ? 'Enabled' : 'Disabled'}
          icon={<Smartphone size={20} />}
          accent="var(--primary)"
          loading={status.isLoading}
        />
        <KpiCard
          label="Registered passkeys"
          value={passkeyCount}
          icon={<Fingerprint size={20} />}
          accent="var(--accent-violet)"
          loading={passkeys.isLoading}
        />
      </div>

      <Card>
        <CardHeader
          title="Two-factor authentication (TOTP)"
          subtitle="Protect your account with a time-based one-time password from an authenticator app."
          actions={status.isLoading ? <Spinner /> : <Badge color={enabled ? 'green' : 'slate'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>}
        />
        <div className={styles.body}>
          {!enabled && !enroll && (
            <>
              <p className={styles.intro}>Use Google Authenticator, Authy, 1Password or any TOTP app. You'll be asked for a code at each sign-in.</p>
              <div className={styles.actions}><Button variant="primary" onClick={() => beginEnroll.mutate()} loading={beginEnroll.isPending}>Enable two-factor authentication</Button></div>
            </>
          )}

          {enroll && (
            <>
              <p className={styles.step}><span className={styles.stepNum}>1</span><span>Add this account to your authenticator app - scan the URI as a QR code, or enter the secret manually.</span></p>
              <TextField label="Account" value={`RIOS:${user?.email ?? ''}`} onChange={() => {}} />
              <TextField label="Secret (manual entry)" value={enroll.secret} onChange={() => {}} />
              <TextField label="otpauth URI" value={enroll.otpauthUri} onChange={() => {}} />
              <p className={styles.step}><span className={styles.stepNum}>2</span><span>Enter the 6-digit code your app shows to confirm.</span></p>
              <TextField label="Authentication code" value={code} onChange={setCode} placeholder="123456" />
              <div className={styles.actions}>
                <Button variant="primary" onClick={() => verify.mutate()} loading={verify.isPending} disabled={code.trim().length < 6}>Verify & enable</Button>
                <Button variant="ghost" onClick={() => { setEnroll(null); setCode(''); }}>Cancel</Button>
              </div>
            </>
          )}

          {enabled && (
            <>
              <p className={styles.intro}>Two-factor authentication is active on your account. To turn it off, confirm a current code.</p>
              <TextField label="Authentication code" value={disableCode} onChange={setDisableCode} placeholder="123456" />
              <div className={styles.actions}><Button variant="danger" onClick={() => disable.mutate()} loading={disable.isPending} disabled={disableCode.trim().length < 6}>Disable two-factor authentication</Button></div>
            </>
          )}
        </div>
      </Card>

      <PasskeysCard />
    </>
  );
}

interface Passkey { id: string; label?: string | null; signCount: number; createdAt: string }

function b64uToBuf(s: string): ArrayBuffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
function bufToB64u(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function PasskeysCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['passkeys'], queryFn: () => api<{ credentials: Passkey[] }>('/api/auth/webauthn/credentials') });
  const [busy, setBusy] = useState(false);

  const register = async () => {
    if (!('credentials' in navigator) || !window.PublicKeyCredential) { toast.error('This browser does not support passkeys.'); return; }
    setBusy(true);
    try {
      const opts = await api<{ challenge: string; rp: { name: string; id: string }; user: { id: string; name: string; displayName: string }; pubKeyCredParams: { type: string; alg: number }[] }>('/api/auth/webauthn/register/begin', { body: {} });
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: b64uToBuf(opts.challenge),
          rp: { name: opts.rp.name },
          user: { id: new TextEncoder().encode(opts.user.id), name: opts.user.name, displayName: opts.user.displayName },
          pubKeyCredParams: opts.pubKeyCredParams as PublicKeyCredentialParameters[],
          timeout: 60000, attestation: 'none',
        },
      }) as PublicKeyCredential | null;
      if (!cred) throw new Error('cancelled');
      const resp = cred.response as AuthenticatorAttestationResponse;
      await api('/api/auth/webauthn/register/finish', { body: { credentialId: bufToB64u(cred.rawId), publicKey: bufToB64u(resp.getPublicKey?.() ?? new ArrayBuffer(0)), label: 'Passkey' } });
      toast.success('Passkey registered'); qc.invalidateQueries({ queryKey: ['passkeys'] });
    } catch {
      toast.error('Passkey registration was cancelled or unavailable.');
    } finally {
      setBusy(false);
    }
  };
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/auth/webauthn/credentials/${id}`, { method: 'POST' }),
    onSuccess: () => { toast.success('Passkey removed'); qc.invalidateQueries({ queryKey: ['passkeys'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not remove'),
  });

  const creds = q.data?.credentials ?? [];

  return (
    <Card>
      <CardHeader title="Passkeys (WebAuthn)" subtitle="Sign in with a device passkey or security key." actions={<Badge color="violet">{creds.length}</Badge>} />
      <div className={styles.body}>
        {creds.length > 0 ? (
          <div className={styles.keyList}>
            {creds.map((c) => (
              <div key={c.id} className={styles.keyRow}>
                <span className={styles.keyIcon} aria-hidden><KeyRound size={18} /></span>
                <span className={styles.keyMeta}>
                  <span className={styles.keyName}>{c.label ?? 'Passkey'}</span>
                  <span className={styles.keySub}>Used {c.signCount} time{c.signCount === 1 ? '' : 's'}</span>
                </span>
                <Button variant="ghost" onClick={() => remove.mutate(c.id)} loading={remove.isPending}>Remove</Button>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.intro}>No passkeys registered yet. Add one to sign in with Face ID, Touch ID, Windows Hello or a hardware security key.</p>
        )}
        <div className={styles.actions}><Button variant="primary" onClick={register} loading={busy}>Register a passkey</Button></div>
      </div>
    </Card>
  );
}
