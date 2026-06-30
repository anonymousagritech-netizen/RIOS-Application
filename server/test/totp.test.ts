/**
 * TOTP (RFC 6238) conformance tests. Uses the RFC 6238 Appendix B test vectors
 * (SHA-1, 8 digits, seed "12345678901234567890") to prove correctness, plus
 * round-trip, window, and base32 checks. Pure - no DB, no network.
 */

import { describe, it, expect } from 'vitest';
import {
  base32Encode,
  base32Decode,
  generateSecret,
  totp,
  verifyTotp,
  otpauthUri,
} from '../src/auth/totp.js';

// RFC 6238 Appendix B seed (ASCII "12345678901234567890") as base32.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const b = Buffer.from('hello reinsurance', 'utf8');
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });
  it('generates secrets of the requested length', () => {
    expect(base32Decode(generateSecret(20)).length).toBe(20);
  });
});

describe('TOTP RFC 6238 test vectors (SHA-1, 8 digits)', () => {
  const opts = { digits: 8, period: 30, algorithm: 'sha1' as const };
  const cases: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ];
  it.each(cases)('t=%i → %s', (seconds, expected) => {
    expect(totp(RFC_SECRET, seconds * 1000, opts)).toBe(expected);
  });
});

describe('verifyTotp', () => {
  it('accepts the current code and rejects a wrong one', () => {
    const secret = generateSecret();
    const now = 1_700_000_000_000;
    const code = totp(secret, now);
    expect(verifyTotp(secret, code, now)).toBe(true);
    expect(verifyTotp(secret, '000000', now)).toBe(false);
  });

  it('tolerates one step of clock skew within the window', () => {
    const secret = generateSecret();
    const now = 1_700_000_000_000;
    const prevStepCode = totp(secret, now - 30_000);
    expect(verifyTotp(secret, prevStepCode, now, 1)).toBe(true);
    // Two steps away is outside the default ±1 window.
    const twoStepsAgo = totp(secret, now - 60_000);
    expect(verifyTotp(secret, twoStepsAgo, now, 1)).toBe(false);
  });
});

describe('otpauth URI', () => {
  it('builds a scannable otpauth:// URI', () => {
    const uri = otpauthUri({ secret: RFC_SECRET, account: 'admin@demo.rios', issuer: 'RIOS' });
    expect(uri).toMatch(/^otpauth:\/\/totp\/RIOS:admin%40demo\.rios\?/);
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain('issuer=RIOS');
    expect(uri).toContain('digits=6');
  });
});
