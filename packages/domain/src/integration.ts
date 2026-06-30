/**
 * Integration helpers (brief §12): pure validation for connector configuration
 * and secret redaction. The server persists connectors and outbox messages; this
 * module decides whether a connector's config is well-formed for its kind and
 * how to present secrets safely. No I/O.
 */

export type ConnectorKind = 'rest' | 'sftp' | 'kafka' | 'webhook';

export interface ConnectorIssue {
  field: string;
  message: string;
}

const REQUIRED: Record<ConnectorKind, string[]> = {
  rest: ['baseUrl'],
  sftp: ['host', 'username'],
  kafka: ['brokers', 'topic'],
  webhook: ['url'],
};

/** Validate a connector config for its kind. Returns all missing/invalid fields. */
export function validateConnectorConfig(kind: ConnectorKind, config: Record<string, unknown>): ConnectorIssue[] {
  const issues: ConnectorIssue[] = [];
  const required = REQUIRED[kind];
  if (!required) {
    issues.push({ field: 'kind', message: `Unknown connector kind "${kind}".` });
    return issues;
  }
  const cfg = config ?? {};
  for (const f of required) {
    const v = cfg[f];
    if (v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)) {
      issues.push({ field: f, message: `${f} is required for a ${kind} connector.` });
    }
  }
  if ((kind === 'rest' || kind === 'webhook') && typeof cfg[kind === 'rest' ? 'baseUrl' : 'url'] === 'string') {
    const url = String(cfg[kind === 'rest' ? 'baseUrl' : 'url']);
    if (!/^https?:\/\//.test(url)) issues.push({ field: kind === 'rest' ? 'baseUrl' : 'url', message: 'URL must start with http:// or https://.' });
  }
  return issues;
}

/** Keys whose values are sensitive and must never be returned in clear. */
const SECRET_KEYS = ['password', 'secret', 'token', 'apiKey', 'privateKey'];

/** Return a copy of a config with secret values masked. */
export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config ?? {})) {
    out[k] = SECRET_KEYS.some((s) => k.toLowerCase().includes(s.toLowerCase())) && v ? '••••••' : v;
  }
  return out;
}
