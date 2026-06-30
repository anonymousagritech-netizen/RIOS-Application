/**
 * Time-based One-Time Password (TOTP) — RFC 6238 / RFC 4226 (HOTP).
 *
 * Dependency-free, standards-compliant MFA primitive used by the auth module.
 * Works with any authenticator app (Google Authenticator, Authy, 1Password, …)
 * via the otpauth:// URI. Pure and unit-testable — no clock is read except where
 * a timestamp is explicitly passed in, so generation/verification are
 * deterministic in tests.
 *
 * Brief §14.1 (MFA enforced by policy).
 */

import { createHmac, randomBytes } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Encode bytes as RFC 4648 base32 (no padding) — the format authenticator apps expect. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/,'').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Generate a new random base32 secret (default 20 bytes = 160 bits, per RFC 4226). */
export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export interface TotpOptions {
  digits?: number; // default 6
  period?: number; // seconds, default 30
  algorithm?: 'sha1' | 'sha256' | 'sha512'; // default sha1 (authenticator standard)
}

/** HOTP for a given counter (RFC 4226). */
function hotp(secret: Buffer, counter: number, opts: Required<TotpOptions>): string {
  const buf = Buffer.alloc(8);
  // counter is < 2^53; write as big-endian 64-bit.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);
  const hmac = createHmac(opts.algorithm, secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const otp = bin % 10 ** opts.digits;
  return otp.toString().padStart(opts.digits, '0');
}

function resolve(opts?: TotpOptions): Required<TotpOptions> {
  return { digits: opts?.digits ?? 6, period: opts?.period ?? 30, algorithm: opts?.algorithm ?? 'sha1' };
}

/** Current TOTP code for a base32 secret at a given epoch-ms (defaults to now at call sites only). */
export function totp(secretBase32: string, epochMs: number, opts?: TotpOptions): string {
  const o = resolve(opts);
  const counter = Math.floor(epochMs / 1000 / o.period);
  return hotp(base32Decode(secretBase32), counter, o);
}

/**
 * Verify a submitted code against the secret, allowing a small clock-skew
 * window (default ±1 step). Constant-time-ish compare on the candidate codes.
 */
export function verifyTotp(secretBase32: string, code: string, epochMs: number, window = 1, opts?: TotpOptions): boolean {
  const o = resolve(opts);
  const secret = base32Decode(secretBase32);
  const baseCounter = Math.floor(epochMs / 1000 / o.period);
  const submitted = code.trim();
  for (let w = -window; w <= window; w++) {
    if (timingSafeEqualStr(hotp(secret, baseCounter + w, o), submitted)) return true;
  }
  return false;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Build the otpauth:// URI an authenticator app scans as a QR code. */
export function otpauthUri(args: { secret: string; account: string; issuer?: string; opts?: TotpOptions }): string {
  const o = resolve(args.opts);
  const issuer = args.issuer ?? 'RIOS';
  // Label is "issuer:account" with each part percent-encoded but the separating
  // colon kept literal (otpauth URI convention).
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(args.account)}`;
  const params = new URLSearchParams({
    secret: args.secret,
    issuer,
    algorithm: o.algorithm.toUpperCase(),
    digits: String(o.digits),
    period: String(o.period),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
