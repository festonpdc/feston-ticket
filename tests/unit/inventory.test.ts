import { describe, expect, it } from 'vitest';
import { inventoryBreakdown, reservationItems, type InventoryState } from '../../packages/ticketing/src/inventory';

const at=new Date('2026-10-31T20:00:00Z');
const future=new Date('2026-10-31T20:15:00Z');
const expired=new Date('2026-10-31T19:59:59Z');
const type='10000000-0000-4000-8000-000000000001';
describe('Inventory domain calculations (SQL remains authoritative)',()=>{
  it('derives capacity = sold + active reserved + available',()=>{
    expect(inventoryBreakdown(100,[
      {quantity:20,status:'paid',reservedUntil:expired},
      {quantity:10,status:'pending_payment',reservedUntil:future},
      {quantity:5,status:'pending_payment',reservedUntil:expired},
    ],at)).toEqual({capacity:100,sold:20,reserved:10,available:70});
  });
  it('expiration boundary is exclusive, cancelled frees and refunded retains capacity',()=>{
    expect(inventoryBreakdown(10,[
      {quantity:2,status:'pending_payment',reservedUntil:at},
      {quantity:3,status:'cancelled',reservedUntil:future},
      {quantity:4,status:'refunded',reservedUntil:expired},
    ],at)).toEqual({capacity:10,sold:4,reserved:0,available:6});
  });
  it('zero available is valid; overselling and malformed dates are rejected',()=>{
    expect(inventoryBreakdown(2,[{quantity:2,status:'paid',reservedUntil:null}],at).available).toBe(0);
    expect(()=>inventoryBreakdown(1,[{quantity:2,status:'paid',reservedUntil:null}],at)).toThrow();
    expect(()=>inventoryBreakdown(2,[{quantity:1,status:'pending_payment',reservedUntil:null}],at)).toThrow();
    expect(()=>inventoryBreakdown(-1,[],at)).toThrow();
    expect(()=>inventoryBreakdown(1,[],new Date('invalid'))).toThrow();
  });
  it('represents an uncapped ticket type explicitly without dropping accounting',()=>{
    expect(inventoryBreakdown(null,[{quantity:4,status:'paid',reservedUntil:null},{quantity:2,status:'pending_payment',reservedUntil:future}],at))
      .toEqual({capacity:null,sold:4,reserved:2,available:null});
  });
  it('validates shapes without accepting a browser price',()=>{
    expect(reservationItems([{ticket_type_id:type,quantity:2}])).toEqual([{ticket_type_id:type,quantity:2}]);
    for(const value of [[],null,[{}],[{ticket_type_id:type,quantity:0}],[{ticket_type_id:type,quantity:-1}],
      [{ticket_type_id:type,quantity:1,price:0}],[{ticket_type_id:type,quantity:1},{ticket_type_id:type,quantity:1}]]) {
      expect(()=>reservationItems(value)).toThrow();
    }
  });
  it('exhaustively checks small valid state combinations without dependencies',()=>{
    const states:InventoryState[]=['draft','pending_payment','paid','expired','cancelled','refunded'];
    for(const first of states) for(const second of states) for(let a=1;a<=3;a++) for(let b=1;b<=3;b++) {
      const result=inventoryBreakdown(6,[{quantity:a,status:first,reservedUntil:future},{quantity:b,status:second,reservedUntil:expired}],at);
      expect(result.available!).toBeGreaterThanOrEqual(0);
      expect(result.sold+result.reserved).toBeLessThanOrEqual(result.capacity!);
      expect(result.sold+result.reserved+result.available!).toBe(result.capacity!);
    }
  });
});
