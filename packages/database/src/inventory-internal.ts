import 'server-only';
import { uuid } from '@programita/security';
import { createAdminClient } from './admin';

// Trusted job/webhook boundary only. Future callers MUST authenticate the job or
// verify provider signature, amount, currency and order attribution before this.
// This domain transition does not prove payment and does not issue tickets.
export async function confirmReservedOrder(organizationId: string, orderId: string) {
  const { data, error } = await createAdminClient().rpc('confirm_reserved_order', {
    p_organization_id: uuid(organizationId), p_order_id: uuid(orderId),
  });
  if (error) throw new Error(`Confirmation rejected (${error.code})`);
  return data;
}

export async function expireReservations() {
  // Database supplies time and bounded batch size; no browser-provided clock.
  const { data, error } = await createAdminClient().rpc('expire_reservations', {});
  if (error) throw new Error(`Expiration rejected (${error.code})`);
  return data;
}
