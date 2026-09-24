export const memberRoles = ['owner', 'manager', 'door'] as const;
export type MemberRole = typeof memberRoles[number];
export function memberRole(value: unknown): MemberRole {
  if (typeof value !== 'string' || !memberRoles.includes(value as MemberRole)) throw new Error('Invalid role');
  return value as MemberRole;
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid UUID');
  return value;
}
// Defense in depth only. Database RLS remains authoritative.
export function canManageOrganization(membership: { organizationId: string; role: MemberRole }, target: string): boolean {
  return uuid(membership.organizationId) === uuid(target) && ['owner', 'manager'].includes(membership.role);
}
