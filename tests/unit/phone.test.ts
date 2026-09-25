import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../../apps/web/lib/phone';
describe('international phone normalization', () => {
  it('normalizes Mexican national numbers', () => expect(normalizePhone('984 165 0840', '+52')).toBe('+529841650840'));
  it('normalizes Argentina and US with explicit country', () => {
    expect(normalizePhone('11 5555 1234', '+54')).toBe('+541155551234');
    expect(normalizePhone('415 555 2671', '+1')).toBe('+14155552671');
  });
  it('rejects impossible input and never silently defaults country', () => {
    expect(normalizePhone('123', '+54')).toBe('');
    expect(normalizePhone('abc', '+1')).toBe('');
    expect(normalizePhone('4155552671', '+54')).toBe('+544155552671');
  });
});
