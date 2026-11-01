import { randomBytes, randomInt, timingSafeEqual, pbkdf2 } from 'node:crypto';
import type { Request, Response } from 'express';

const encoder = new TextEncoder();
export const millis = () => Date.now();
export const token = (bytes = 32): string => randomBytes(bytes).toString('hex');
export const pin = (): string => String(randomInt(10_000_000, 100_000_000));
export const normalizedEmail = (value: unknown): string => typeof value === 'string' ? value.trim().toLowerCase() : '';
export const normalizedString = (value: unknown, max: number): string =>
  typeof value === 'string' && value.length <= max ? value.trim() : '';

export function isAdult(dob: unknown): dob is string {
  if (typeof dob !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return false;
  const date = new Date(dob + 'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dob || date.getUTCFullYear() < 1900) return false;
  const now = new Date(); let age = now.getUTCFullYear() - date.getUTCFullYear();
  if (now.getUTCMonth() < date.getUTCMonth() || (now.getUTCMonth() === date.getUTCMonth() && now.getUTCDate() < date.getUTCDate())) age--;
  return age >= 18 && age <= 120;
}

export async function digest(value: string): Promise<string> {
  const raw = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Buffer.from(raw).toString('hex');
}
export const PASSWORD_SCHEME = 'pbkdf2-sha256-chain6x100k-v1';
export async function passwordDigest(pw: string, salt: string): Promise<string> {
  // workerd enforces <= 100,000 iterations per individual PBKDF2 operation.
  // Chain six domain-separated PBKDF2-HMAC-SHA256 operations for a total of
  // 600,000 KDF iterations, without weakening to one 100k-iteration call.
  // This is a versioned composed KDF, NOT interoperable with legacy single
  // PBKDF2-150k hashes; legacy migration must be handled explicitly.
  let input: string | Buffer = pw;
  for (let round = 0; round < 6; round++) {
    const roundSalt = salt + ':anichan:pbkdf2chain:v1:' + round;
    input = await new Promise<Buffer>((resolve, reject) => {
      pbkdf2(input, roundSalt, 100_000, 32, 'sha256', (err, output) => {
        if (err) reject(err);
        else resolve(output);
      });
    });
  }
  return input.toString('hex');
}
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export async function otpDigest(code: string, secret: string): Promise<string> {
  if (secret.length < 32) throw new Error('OTP secret not configured');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(code));
  return Buffer.from(signature).toString('hex');
}
export function bearer(req: Request): string {
  const auth = req.get('Authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}
export function cookieValue(req: Request): string | null {
  const m = (req.get('Cookie') || '').match(/(?:^|;\s*)anichan_session=([a-f0-9]{64})(?:;|$)/);
  return m?.[1] || null;
}
export function setSessionCookie(res: Response, value: string, maxAge = 14 * 86400): void {
  res.setHeader('Set-Cookie', 'anichan_session=' + value + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAge);
}
export function originAllowed(req: Request): boolean {
  const origin = req.get('Origin');
  const host = req.get('Host');
  if (origin && host && origin !== 'https://' + host) return false;
  const site = req.get('Sec-Fetch-Site');
  if (site && !['same-origin','none'].includes(site)) return false;
  return (req.get('Content-Type') || '').toLowerCase().startsWith('application/json');
}
export function waid(value: unknown): value is string {
  return typeof value === 'string' && /^\d{7,17}@s\.whatsapp\.net$/.test(value);
}
