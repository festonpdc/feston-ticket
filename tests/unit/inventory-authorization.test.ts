import { beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc, admin }=vi.hoisted(()=>{
  const rpc=vi.fn();
  return {rpc,admin:vi.fn(()=>({rpc}))};
});
vi.mock('../../packages/database/src/admin',()=>({createAdminClient:admin}));
import { cancelReservationForMember, reserveTicketsForMember } from '../../packages/database/src/inventory';

const org='10000000-0000-4000-8000-000000000001';
const user='00000000-0000-4000-8000-000000000001';
type UserClient=Parameters<typeof reserveTicketsForMember>[0];
function client(role:string|null, signedIn=true) {
  const query={select:vi.fn(),eq:vi.fn(),maybeSingle:vi.fn().mockResolvedValue({data:role?{role}:null,error:null})};
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
  return {client:{auth:{getUser:vi.fn().mockResolvedValue({data:{user:signedIn?{id:user}:null},error:null})},from:vi.fn(()=>query)} as unknown as UserClient,query};
}
const input={organizationId:org,eventId:org,customerId:org,idempotencyKey:'a'.repeat(64),items:[{ticket_type_id:org,quantity:1}]};
beforeEach(()=>{vi.clearAllMocks();rpc.mockResolvedValue({data:{status:'pending_payment'},error:null});});
describe('Server-only staff authorization',()=>{
  it.each([null,'door'])('rejects absent/insufficient membership %s before creating admin client',async role=>{
    const session=client(role);
    await expect(reserveTicketsForMember(session.client,input)).rejects.toThrow('Forbidden');
    await expect(cancelReservationForMember(session.client,org,org)).rejects.toThrow('Forbidden');
    expect(admin).not.toHaveBeenCalled();
    expect(session.query.eq).toHaveBeenCalledWith('organization_id',org);
    expect(session.query.eq).toHaveBeenCalledWith('user_id',user);
  });
  it('requires a verified Auth user',async()=>{
    await expect(reserveTicketsForMember(client('owner',false).client,input)).rejects.toThrow('Unauthenticated');
    expect(admin).not.toHaveBeenCalled();
  });
  it.each(['owner','manager'])('permits authorized %s without accepting browser prices',async role=>{
    const session=client(role).client;
    await expect(reserveTicketsForMember(session,{...input,items:[{ticket_type_id:org,quantity:1,price:0}]})).rejects.toThrow();
    expect(admin).not.toHaveBeenCalled();
    await reserveTicketsForMember(session,input);
    expect(rpc).toHaveBeenCalledWith('reserve_tickets',{p_organization_id:org,p_event_id:org,p_customer_id:org,p_items:input.items,p_idempotency_key:input.idempotencyKey});
  });
  it('does not expose raw database error details or PII',async()=>{
    rpc.mockResolvedValue({data:null,error:{code:'23514',message:'sensitive provider or customer detail'}});
    await expect(reserveTicketsForMember(client('owner').client,input)).rejects.toThrow('Reservation rejected (23514)');
  });
});
