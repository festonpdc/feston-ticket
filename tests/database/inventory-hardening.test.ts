import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { availability, historicalOrder, inventoryDB, reserve, seedInventory, type InventoryDB, type InventoryFixture } from './inventory-support';

function suite(name:string,url?:string) {
  describe(name,()=>{
    let db:InventoryDB; let close:()=>Promise<void>; let f:InventoryFixture; let key:string;
    beforeAll(async()=>{({db,close}=await inventoryDB(url));});
    afterAll(async()=>{if(close)await close();});
    beforeEach(async()=>{await db.exec('begin');f=await seedInventory(db);key=randomBytes(32).toString('hex');});
    afterEach(async()=>{await db.exec('rollback');});
    async function reject(work:()=>Promise<unknown>,code:string) {
      await db.exec('savepoint expected_failure');
      try {await expect(work()).rejects.toMatchObject({code});}
      finally {await db.exec('rollback to savepoint expected_failure');}
    }
    it('same key/payload returns one reservation, one audit and consumes once',async()=>{
      const first=await reserve(db,f,2,undefined,key);
      for(let attempt=0;attempt<5;attempt++) expect(await reserve(db,f,2,undefined,key)).toEqual(first);
      expect((await db.query('select * from public.orders where organization_id=$1',[f.org])).rows).toHaveLength(1);
      expect((await db.query('select * from public.order_items where organization_id=$1',[f.org])).rows).toHaveLength(1);
      expect((await db.query('select * from public.audit_logs where organization_id=$1',[f.org])).rows).toHaveLength(1);
      expect(Number((await availability(db,f)).find(r=>r.ticket_type_id===f.type)!.available_quantity)).toBe(98);
    });
    it('uses persisted state across commits, not transaction-local or process cache',async()=>{
      // A second embedded DB is owned exclusively by this test; no fixtures leak
      // into a configured Supabase database or into other cases.
      const isolated=await inventoryDB();
      try {
        await isolated.db.exec('begin'); const context=await seedInventory(isolated.db);
        const first=await reserve(isolated.db,context,1,undefined,key); await isolated.db.exec('commit');
        await isolated.db.exec('begin');
        expect(await reserve(isolated.db,context,1,undefined,key)).toEqual(first);
        await isolated.db.exec('commit');
        expect((await isolated.db.query('select * from private.reservation_requests')).rows).toHaveLength(1);
      } finally {await isolated.close();}
    });
    it('normalizes type ordering, UUID casing and JSON property order',async()=>{
      const lines=[{ticket_type_id:f.type,quantity:2},{ticket_type_id:f.secondType,quantity:3}];
      const first=await reserve(db,f,1,lines,key);
      const reordered=[...lines].reverse().map(l=>({quantity:l.quantity,ticket_type_id:l.ticket_type_id.toUpperCase()}));
      expect(await reserve(db,{...f,org:f.org.toUpperCase()},1,reordered,key)).toEqual(first);
    });
    it.each(['quantity','type','customer','event','organization'])('same key with changed %s is a conflict',async field=>{
      await reserve(db,f,1,undefined,key);
      const changed={...f}; let quantity=1;
      if(field==='quantity')quantity=2;
      if(field==='type')changed.type=f.secondType;
      if(field==='customer')changed.customer=randomUUID();
      if(field==='event')changed.event=randomUUID();
      if(field==='organization')changed.org=randomUUID();
      await reject(()=>reserve(db,changed,quantity,undefined,key),'PT409');
      expect((await db.query('select * from public.orders where organization_id=$1',[f.org])).rows).toHaveLength(1);
      expect((await db.query('select r.* from private.reservation_requests r join public.orders o on o.id=r.order_id where o.organization_id=$1',[f.org])).rows).toHaveLength(1);
    });
    it('different keys create independent reservations',async()=>{
      const first=await reserve(db,f,2,undefined,key);
      const second=await reserve(db,f,2,undefined,randomBytes(32).toString('hex'));
      expect(first.order_id).not.toBe(second.order_id);
      expect(Number((await availability(db,f)).find(r=>r.ticket_type_id===f.type)!.available_quantity)).toBe(96);
    });
    it('retrieves original prices/deadline after catalog, limits and sales change',async()=>{
      const first=await reserve(db,f,2,undefined,key);
      await db.query('update public.ticket_types set price=9999 where id=$1',[f.type]);
      await db.query("update public.events set status='sales_closed' where id=$1",[f.event]);
      await db.exec('update private.inventory_settings set max_tickets_per_order=1,online_reservation_seconds=60');
      expect(await reserve(db,f,2,undefined,key)).toEqual(first);
    });
    it.each(['cancelled','paid'])('replay returns current %s state without creating or renewing stock',async state=>{
      const first=await reserve(db,f,2,undefined,key);
      const rpc=state==='paid'?'confirm_reserved_order':'cancel_reservation';
      await db.query(`select public.${rpc}($1,$2)`,[f.org,first.order_id]);
      const replay=await reserve(db,f,2,undefined,key);
      expect(replay.order_id).toBe(first.order_id);
      expect(replay.reserved_until).toBe(first.reserved_until);
      expect(replay.reservation_active).toBe(false);
      expect(replay.status).toBe(state);
      expect((await db.query('select * from public.orders where organization_id=$1',[f.org])).rows).toHaveLength(1);
      expect((await db.query('select * from public.audit_logs where organization_id=$1',[f.org])).rows).toHaveLength(2);
    });
    it('failed reservation rolls back key mapping and can retry after capacity changes',async()=>{
      await db.query('update public.ticket_types set capacity=0 where id=$1',[f.type]);
      await reject(()=>reserve(db,f,1,undefined,key),'23514');
      expect((await db.query('select r.* from private.reservation_requests r join public.orders o on o.id=r.order_id where o.organization_id=$1',[f.org])).rows).toHaveLength(0);
      await db.query('update public.ticket_types set capacity=1 where id=$1',[f.type]);
      await reserve(db,f,1,undefined,key);
      expect((await db.query('select r.* from private.reservation_requests r join public.orders o on o.id=r.order_id where o.organization_id=$1',[f.org])).rows).toHaveLength(1);
    });
    it('expired historical reservation replays without renewal before and after expiration job',async()=>{
      // Keep the engine's canonical digest, then load an expired historical
      // fixture; no clocks, integrity triggers or production settings are mocked.
      await db.exec('savepoint digest_fixture');
      await reserve(db,f,1,undefined,key);
      const digest=(await db.query('select r.key_hash,r.payload_hash from private.reservation_requests r join public.orders o on o.id=r.order_id where o.organization_id=$1',[f.org])).rows[0]!;
      await db.exec('rollback to savepoint digest_fixture');
      const orderId=await historicalOrder(db,f,1,'pending_payment',true);
      await db.query('insert into private.reservation_requests(key_hash,payload_hash,order_id) values($1,$2,$3)',[digest.key_hash,digest.payload_hash,orderId]);
      const beforeJob=await reserve(db,f,1,undefined,key);
      expect(beforeJob.order_id).toBe(orderId);
      expect(beforeJob.reservation_active).toBe(false);
      expect(beforeJob.status).toBe('pending_payment');
      await db.exec('select public.expire_reservations()');
      const afterJob=await reserve(db,f,1,undefined,key);
      expect(afterJob.order_id).toBe(orderId);
      expect(afterJob.status).toBe('expired');
      expect(afterJob.reservation_active).toBe(false);
      expect(afterJob.reserved_until).toBe(beforeJob.reserved_until);
      expect((await db.query('select * from public.orders where organization_id=$1',[f.org])).rows).toHaveLength(1);
      expect(Number((await availability(db,f)).find(r=>r.ticket_type_id===f.type)!.available_quantity)).toBe(100);
    });
    it('stores only key/payload hashes with unique, immutable mapping',async()=>{
      const first=await reserve(db,f,1,undefined,key);
      const stored=(await db.query('select r.* from private.reservation_requests r join public.orders o on o.id=r.order_id where o.organization_id=$1',[f.org])).rows[0]!;
      expect(stored.key_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(stored.payload_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(stored)).not.toContain(key);
      await reject(()=>db.query('insert into private.reservation_requests(key_hash,payload_hash,order_id) values($1,$2,$3)',[stored.key_hash,stored.payload_hash,first.order_id]),'23505');
      await reject(()=>db.exec('delete from private.reservation_requests'),'23514');
      await reject(()=>db.exec("update private.reservation_requests set payload_hash=repeat('a',64)"),'23514');
    });
    it.each(['','short','A'.repeat(64),'a'.repeat(63),'a'.repeat(65)])('rejects invalid key format %s',async invalid=>{
      await reject(()=>reserve(db,f,1,undefined,invalid),'22023');
    });
    it('has only five public RPCs with fixed search_path and minimal grants',async()=>{
      const protection=(await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='private.reservation_requests'::regclass")).rows[0]!;
      expect(protection).toEqual({relrowsecurity:true,relforcerowsecurity:true});
      const rows=(await db.query(`select p.proname,p.prosecdef,p.proconfig,
        pg_get_userbyid(p.proowner) as owner,
        has_function_privilege('anon',p.oid,'execute') as anon,
        has_function_privilege('authenticated',p.oid,'execute') as authenticated,
        has_function_privilege('service_role',p.oid,'execute') as service,
        exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) where grantee=0 and privilege_type='EXECUTE') as public_execute
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by p.proname`)).rows;
      expect(rows.map(r=>r.proname)).toEqual(['cancel_reservation','confirm_reserved_order','expire_reservations','reserve_tickets','ticket_availability']);
      for(const fn of rows) {
        expect(fn.prosecdef).toBe(true);expect(fn.proconfig).toContain('search_path=""');
        expect(['anon','authenticated','service_role']).not.toContain(fn.owner);
        expect(fn.anon).toBe(fn.proname==='ticket_availability');
        expect(fn.authenticated).toBe(fn.proname==='ticket_availability');
        expect(fn.service).toBe(true);expect(fn.public_execute).toBe(false);
      }
      expect((await db.query("select to_regprocedure('public.reserve_tickets(uuid,uuid,uuid,jsonb)') as legacy")).rows[0]!.legacy).toBeNull();
      for(const role of ['anon','authenticated','service_role']) {
        expect((await db.query("select has_function_privilege($1,'private.reserve_tickets(uuid,uuid,uuid,jsonb)','execute') as allowed",[role])).rows[0]!.allowed).toBe(false);
        await db.exec(`set local role ${role}`);
        await reject(()=>db.exec('select * from private.reservation_requests'),'42501');
        await db.exec('reset role');
      }
    });
    it('public availability is identical across different buyers and paid vs pending',async()=>{
      const first=await reserve(db,f,1,undefined,key);
      await db.exec('set local role anon');const pending=await availability(db,f);await db.exec('reset role');
      await db.query('select public.confirm_reserved_order($1,$2)',[f.org,first.order_id]);
      await db.query("update public.customers set full_name='Private new name',email='private@example.invalid',phone='+521234567890' where id=$1",[f.customer]);
      await db.exec('set local role anon');
      const paid=await availability(db,f);
      expect(paid).toEqual(pending);
      const payload=JSON.stringify(paid);
      for(const secret of [key,f.customer,first.order_id,'private@example.invalid','Private new name','+521234567890']) expect(payload).not.toContain(secret);
      expect(Object.keys(paid[0]!).sort()).toEqual(['available_quantity','currency','name','price','sales_open','status','ticket_type_id']);
    });
    it('two different types still share the event cap, including reversed payload order',async()=>{
      await db.query('update public.events set capacity=3 where id=$1',[f.event]);
      await reserve(db,f,1,[{ticket_type_id:f.secondType,quantity:1},{ticket_type_id:f.type,quantity:1}],key);
      await reject(()=>reserve(db,f,1,[{ticket_type_id:f.type,quantity:1},{ticket_type_id:f.secondType,quantity:1}]),'23514');
      expect((await db.query('select sum(quantity)::text as count from public.order_items where organization_id=$1',[f.org])).rows[0]!.count).toBe('2');
    });
  });
}
suite('Inventory hardening PostgreSQL embedded');
if(process.env.TEST_DATABASE_URL)suite('Inventory hardening Supabase local',process.env.TEST_DATABASE_URL);
else it.skip('Inventory hardening Supabase local requires TEST_DATABASE_URL');
