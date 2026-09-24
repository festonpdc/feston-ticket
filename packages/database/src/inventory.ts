import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { idempotencyKey, uuid } from '@programita/security';
import { reservationItems } from '@programita/ticketing/inventory';
import type { Database } from './database.types';
import { createAdminClient } from './admin';

// No server action / HTTP route exposes these commands. The user-scoped client
// must carry the request's verified session, never a service_role credential.
async function requireStaff(client: SupabaseClient<Database>, organizationId: string) {
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Error('Unauthenticated');
  const membership = await client.from('organization_members').select('role')
    .eq('organization_id', organizationId).eq('user_id', data.user.id).maybeSingle();
  if (membership.error || !membership.data || !['owner','manager'].includes(membership.data.role)) throw new Error('Forbidden');
  return data.user.id;
}

export async function reserveTicketsForMember(client: SupabaseClient<Database>, input: {
  organizationId: string; eventId: string; customerId: string; items: unknown; idempotencyKey: string;
}) {
  const organizationId = uuid(input.organizationId);
  const eventId = uuid(input.eventId);
  const customerId = uuid(input.customerId);
  const items = reservationItems(input.items);
  const key = idempotencyKey(input.idempotencyKey);
  await requireStaff(client, organizationId);
  const { data, error } = await createAdminClient().rpc('reserve_tickets', {
    p_organization_id: organizationId, p_event_id: eventId, p_customer_id: customerId, p_items: items, p_idempotency_key: key,
  });
  if (error) throw new Error(`Reservation rejected (${error.code})`);
  return data;
}

export async function cancelReservationForMember(client: SupabaseClient<Database>, organizationId: string, orderId: string) {
  const org = uuid(organizationId);
  const order = uuid(orderId);
  await requireStaff(client, org);
  const { data, error } = await createAdminClient().rpc('cancel_reservation', { p_organization_id: org, p_order_id: order });
  if (error) throw new Error(`Cancellation rejected (${error.code})`);
  return data;
}

export async function ticketAvailability(client: SupabaseClient<Database>, organizationId: string, eventId: string) {
  const { data, error } = await client.rpc('ticket_availability', { p_organization_id: uuid(organizationId), p_event_id: uuid(eventId) });
  if (error) throw new Error(`Availability unavailable (${error.code})`);
  return data;
}
