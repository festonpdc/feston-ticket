import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
export function publicCode(kind: 'order' | 'ticket'): string {
  return `${kind === 'order' ? 'ORD' : 'TKT'}_${randomBytes(16).toString('hex')}`;
}
export function hashToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid token');
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
export function generateToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
export function verifyToken(token: string, hash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(hash) || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  return timingSafeEqual(Buffer.from(hashToken(token), 'hex'), Buffer.from(hash, 'hex'));
}
