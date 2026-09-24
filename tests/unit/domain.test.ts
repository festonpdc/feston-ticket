import { describe, expect, it } from 'vitest';
import { assertOrderTransition, currency, lineSubtotal, minorUnits, orderStatus, orderTotal, quantity } from '../../packages/ticketing/src/index';
import { canManageOrganization, memberRole, uuid } from '../../packages/security/src/index';
import { generateToken, hashToken, publicCode, verifyToken } from '../../packages/security/src/tokens';

describe('money and input validation', () => {
  it('calculates exact integer snapshots', () => {
    expect(lineSubtotal(101, 3)).toBe(303);
    expect(orderTotal([{ unitPrice: 101, quantity: 3, currency: 'USD' }, { unitPrice: 0, quantity: 1, currency: 'USD' }]))
      .toEqual({ subtotal: 303, total: 303, currency: 'USD' });
  });
  it.each([0, -1, 1.5, NaN, Infinity, '2', null, 2147483648])('rejects quantity %s', value => {
    expect(() => quantity(value)).toThrow();
  });
  it.each([-1, 0.1, NaN, Infinity, '100', Number.MAX_SAFE_INTEGER + 1])('rejects money %s', value => {
    expect(() => minorUnits(value)).toThrow();
  });
  it('rejects overflow, mixed currencies and empty orders', () => {
    expect(() => lineSubtotal(Number.MAX_SAFE_INTEGER, 2)).toThrow();
    expect(() => orderTotal([{ unitPrice: Number.MAX_SAFE_INTEGER, quantity: 1, currency: 'USD' }, { unitPrice: 1, quantity: 1, currency: 'USD' }])).toThrow();
    expect(() => orderTotal([{ unitPrice: 1, quantity: 1, currency: 'USD' }, { unitPrice: 1, quantity: 1, currency: 'ARS' }])).toThrow();
    expect(() => orderTotal([])).toThrow();
    expect(() => currency('usd')).toThrow();
  });
  it('validates controlled states and transitions', () => {
    expect(orderStatus('paid')).toBe('paid');
    expect(() => assertOrderTransition('draft', 'pending_payment')).not.toThrow();
    expect(() => orderStatus('arbitrary')).toThrow();
    expect(() => assertOrderTransition('draft', 'paid')).toThrow();
    expect(() => assertOrderTransition('refunded', 'paid')).toThrow();
  });
});
describe('cryptographic identifiers', () => {
  it('generates 10,000 distinct public codes per kind with the expected format', () => {
    for (const kind of ['order', 'ticket'] as const) {
      const codes = Array.from({ length: 10_000 }, () => publicCode(kind));
      expect(new Set(codes).size).toBe(10_000);
      expect(codes.every(c => /^(ORD|TKT)_[a-f0-9]{32}$/.test(c))).toBe(true);
    }
  });
  it('generates 256-bit tokens, keeps only SHA-256, rejects wrong tokens', () => {
    const generated = Array.from({ length: 1000 }, generateToken);
    expect(new Set(generated.map(v => v.token)).size).toBe(1000);
    const { token, hash } = generated[0]!;
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(token)).toBe(hash);
    expect(verifyToken(token, hash)).toBe(true);
    expect(verifyToken(generated[1]!.token, hash)).toBe(false);
    expect(verifyToken('', hash)).toBe(false);
    expect(verifyToken(token, 'invalid')).toBe(false);
    expect(() => hashToken('short')).toThrow();
  });
});
describe('tenant boundary defense in depth', () => {
  const a = '10000000-0000-4000-8000-000000000001';
  const b = '10000000-0000-4000-8000-000000000002';
  it('requires both correct organization and staff role', () => {
    expect(canManageOrganization({ organizationId: a, role: 'owner' }, a)).toBe(true);
    expect(canManageOrganization({ organizationId: a, role: 'manager' }, b)).toBe(false);
    expect(canManageOrganization({ organizationId: a, role: 'door' }, a)).toBe(false);
    expect(() => memberRole('admin')).toThrow();
    expect(() => uuid('1')).toThrow();
  });
});
