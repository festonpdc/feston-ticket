import { describe,expect,it } from 'vitest';
import { generateIdempotencyKey } from '../../packages/security/src/tokens';
import { idempotencyKey } from '../../packages/security/src/index';
describe('Opaque purchase-attempt keys',()=>{
  it('generates 256-bit keys with no collisions in 1000 samples',()=>{
    const keys=Array.from({length:1000},generateIdempotencyKey);
    expect(new Set(keys).size).toBe(1000);
    for(const key of keys) {expect(idempotencyKey(key)).toBe(key);expect(Buffer.from(key,'hex')).toHaveLength(32);}
  });
  it.each([null,undefined,42,'', 'x'.repeat(64),'A'.repeat(64),'a'.repeat(63)])('rejects invalid key %s',key=>{
    expect(()=>idempotencyKey(key)).toThrow();
  });
});
