import 'server-only';
import crypto from 'node:crypto';
const secret = () => process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
export function issuePaymentCapability(orderId: string, expiresAt: string) {
  const payload = Buffer.from(JSON.stringify({ orderId, expiresAt })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return payload + '.' + sig;
}
export function verifyPaymentCapability(token: string, orderId: string) {
  const [payload, sig] = token.split('.'); if (!payload || !sig || !secret()) return false;
  const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { orderId?: string; expiresAt?: string }; return data.orderId === orderId && !!data.expiresAt && Date.parse(data.expiresAt) > Date.now(); } catch { return false; }
}
