import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertIsolatedDestructiveTarget } from './remote-guard';
import { availability, historicalOrder, inventoryDB, reserve, seedInventory, type InventoryDB, type InventoryFixture } from './inventory-support';

function suite(name:string,url?:string) {
  describe(name,()=>{
    let db:InventoryDB; let close:()=>Promise<void>; let f:InventoryFixture; let key:string;
    beforeAll(async()=>{if(url) assertIsolatedDestructiveTarget();({db,close}=await inventoryDB(url));});
    afterAll(async()=>{if(close)await close();});
    beforeEach(async()=>{await db.exec('begin');f=await seedInventory(db);key=randomBytes(32).toString('hex');});
    afterEach(async()=>{await db.exec('rollback');});
    async function reject(work:()=>Promise<unknown>,code:string) {
      await db.exec('savepoint expected_failure');
      try {await expect(work()).rejects.toMatchObject({code});}
      finally {await db.exec('rollback to savepoint expected_failure');}
    }
    async function cardPayment(orderId:string, providerPaymentId=`pi_${randomUUID().replaceAll('-','')}`) {
      await db.query(`insert into public.payments(organization_id,order_id,provider,provider_payment_id,method,status,amount,currency)
        select organization_id,id,'stripe',$2,'card','pending',total,currency from public.orders where id=$1`,[orderId,providerPaymentId]);
      const order=(await db.query<{reserved_until:string}>('select reserved_until from public.orders where id=$1',[orderId])).rows[0]!;
      const apply=async(eventId:string,eventCreatedAt:string,overrides:Record<string,unknown>={})=>{
        const values={providerPaymentId,eventType:'payment_intent.succeeded',amount:1500,currency:'USD',method:'card',...overrides};
        return (await db.query<{value:{status:string;reason?:string}}>(`select public.apply_stripe_payment_event(
          $1,$2,$3,$4,$5,$6,$7::timestamptz
        ) as value`,[eventId,values.providerPaymentId,values.eventType,values.amount,values.currency,values.method,eventCreatedAt])).rows[0]!.value;
      };
      return {providerPaymentId,reservedUntil:order.reserved_until,apply};
    }
    async function issuanceManifest(orderId:string) {
      const items=(await db.query<{id:string;quantity:number}>('select id,quantity from public.order_items where order_id=$1 order by id',[orderId])).rows;
      const tokens:string[]=[];
      const manifest=items.flatMap(item=>Array.from({length:Number(item.quantity)},(_,offset)=>{
        const id=randomUUID();const token=randomBytes(32).toString('base64url');tokens.push(token);
        return {id,order_item_id:item.id,unit_index:offset+1,public_code:`TKT_${randomBytes(16).toString('hex')}`,secure_token_hash:createHash('sha256').update(token).digest('hex')};
      }));
      return {manifest,tokens};
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
    it('has only the approved public RPCs with fixed search_path and minimal grants',async()=>{
      const protection=(await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='private.reservation_requests'::regclass")).rows[0]!;
      expect(protection).toEqual({relrowsecurity:true,relforcerowsecurity:true});
      const releaseProtection=(await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='public.pricing_releases'::regclass")).rows[0]!;
      expect(releaseProtection).toEqual({relrowsecurity:true,relforcerowsecurity:true});
      for(const role of ['anon','authenticated']) {
        expect((await db.query("select has_table_privilege($1,'public.pricing_releases','select') as read,has_table_privilege($1,'public.pricing_releases','insert') as write",[role])).rows[0]).toEqual({read:false,write:false});
      }
      const rows=(await db.query(`select p.proname,p.prosecdef,p.proconfig,
        pg_get_userbyid(p.proowner) as owner,
        has_function_privilege('anon',p.oid,'execute') as anon,
        has_function_privilege('authenticated',p.oid,'execute') as authenticated,
        has_function_privilege('service_role',p.oid,'execute') as service,
        exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) where grantee=0 and privilege_type='EXECUTE') as public_execute
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by p.proname`)).rows;
      expect(rows.map(r=>r.proname)).toEqual(['apply_stripe_payment_event','cancel_reservation','claim_order_ticket_email_delivery','claim_order_ticket_email_delivery_controlled','confirm_reserved_order','expire_reservations','finish_order_ticket_email_delivery','finish_order_ticket_email_delivery_controlled','issue_tickets_for_paid_order','reconcile_stripe_payment_provider_id','reserve_tickets','ticket_availability']);
      for(const fn of rows) {
        expect(fn.prosecdef).toBe(true);
        expect(fn.proconfig).toContain(['apply_stripe_payment_event','reconcile_stripe_payment_provider_id'].includes(String(fn.proname))?'search_path=pg_catalog':'search_path=""');
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
      expect(Object.keys(paid[0]!).sort()).toEqual(['available_quantity','commercial_occupancy','currency','display_price_label','name','price','release_label','release_sequence','sales_open','status','ticket_type_id']);
    });
    it('uses one release price for the whole reservation and advances only the next reservation',async()=>{
      await db.query('update public.ticket_types set capacity=null where id=$1',[f.type]);
      await db.query(`insert into public.pricing_releases(organization_id,event_id,ticket_type_id,sequence,label,threshold,charge_amount,charge_currency,display_label) values
        ($1,$2,$3,1,'FIRST',100,2500,'USD','$25'),($1,$2,$3,2,'SECOND',null,3500,'USD','$35')`,[f.org,f.event,f.type]);
      expect((await reserve(db,f,1)).total).toBe(2500);
      await db.exec('savepoint release_setup');await db.exec('rollback to savepoint release_setup');
      await historicalOrder(db,f,97,'paid',false);
      const crossing=await reserve(db,f,5);expect(crossing.total).toBe(12500);
      const item=(await db.query('select quantity,unit_price,subtotal from public.order_items where order_id=$1',[crossing.order_id])).rows[0]!;
      expect(item).toMatchObject({quantity:5,unit_price:2500,subtotal:12500});
      await db.query('update public.pricing_releases set charge_amount=9999 where organization_id=$1 and sequence=1',[f.org]);
      expect((await db.query('select unit_price,subtotal from public.order_items where order_id=$1',[crossing.order_id])).rows[0]).toEqual({unit_price:2500,subtotal:12500});
      expect((await reserve(db,f,1)).total).toBe(3500);
    });
    it('uses the fixed Fest-On women equivalence with no split or FX lookup',async()=>{
      await db.query("update public.ticket_types set capacity=null,price=2000,currency='MXN' where id=$1",[f.type]);
      await db.query(`insert into public.pricing_releases(organization_id,event_id,ticket_type_id,sequence,label,threshold,charge_amount,charge_currency,display_label) values
        ($1,$2,$3,1,'FIRST',100,1800,'MXN','USD $1'),($1,$2,$3,2,'REST',null,3600,'MXN','USD $2')`,[f.org,f.event,f.type]);
      for(let index=0;index<9;index++) await reserve(db,f,10);
      await reserve(db,f,8);
      const crossing=await reserve(db,f,5);
      expect(crossing).toMatchObject({total:9000,currency:'MXN'});
      expect((await db.query('select quantity,unit_price,subtotal,currency::text from public.order_items where order_id=$1',[crossing.order_id])).rows[0]).toEqual({quantity:5,unit_price:1800,subtotal:9000,currency:'MXN'});
      expect(await reserve(db,f,1)).toMatchObject({total:3600,currency:'MXN'});
    });
    it('loads the exact Fest-On commercial release amounts without dynamic FX',async()=>{
      const rows=(await db.query(`select t.name,r.sequence,r.threshold,r.charge_amount,r.charge_currency::text,r.display_label
        from public.pricing_releases r join public.ticket_types t on t.id=r.ticket_type_id
        where r.organization_id='f3000000-0000-4000-8000-000000000001' order by t.name,r.sequence`)).rows;
      expect(rows).toEqual([
        {name:'HOMBRES',sequence:1,threshold:100,charge_amount:25000,charge_currency:'MXN',display_label:'$250 MXN'},
        {name:'HOMBRES',sequence:2,threshold:200,charge_amount:35000,charge_currency:'MXN',display_label:'$350 MXN'},
        {name:'HOMBRES',sequence:3,threshold:300,charge_amount:45000,charge_currency:'MXN',display_label:'$450 MXN'},
        {name:'HOMBRES',sequence:4,threshold:null,charge_amount:50000,charge_currency:'MXN',display_label:'$500 MXN'},
        {name:'MUJERES',sequence:1,threshold:100,charge_amount:1800,charge_currency:'MXN',display_label:'USD $1'},
        {name:'MUJERES',sequence:2,threshold:null,charge_amount:3600,charge_currency:'MXN',display_label:'USD $2'}
      ]);
    });
    it('counts active and paid occupancy once, releases expired holds and ignores disabled releases',async()=>{
      await db.query('update public.ticket_types set capacity=null where id=$1',[f.type]);
      await db.query(`insert into public.pricing_releases(organization_id,event_id,ticket_type_id,sequence,label,threshold,charge_amount,charge_currency,display_label,enabled) values
        ($1,$2,$3,1,'DISABLED',100,1000,'USD','$10',false),($1,$2,$3,2,'FIRST',100,2500,'USD','$25',true),($1,$2,$3,3,'REST',null,3500,'USD','$35',true)`,[f.org,f.event,f.type]);
      const active=await historicalOrder(db,f,100,'pending_payment',false);expect((await reserve(db,f,1)).total).toBe(3500);
      await db.query("update public.orders set reserved_until=now()-interval '1 second' where id=$1",[active]);await db.exec('select public.expire_reservations()');
      expect((await reserve(db,f,1)).total).toBe(2500);
      const paid=await historicalOrder(db,f,99,'paid',false);expect((await reserve(db,f,1)).total).toBe(3500);
      expect((await db.query('select commercial_occupancy from public.ticket_availability($1,$2) where ticket_type_id=$3',[f.org,f.event,f.type])).rows[0]!.commercial_occupancy).toBe(102);
      expect((await db.query('select count(*)::int count from public.order_items where order_id=$1',[paid])).rows[0]!.count).toBe(1);
    });
    it('two different types still share the event cap, including reversed payload order',async()=>{
      await db.query('update public.events set capacity=3 where id=$1',[f.event]);
      await reserve(db,f,1,[{ticket_type_id:f.secondType,quantity:1},{ticket_type_id:f.type,quantity:1}],key);
      await reject(()=>reserve(db,f,1,[{ticket_type_id:f.type,quantity:1},{ticket_type_id:f.secondType,quantity:1}]),'23514');
      expect((await db.query('select sum(quantity)::text as count from public.order_items where organization_id=$1',[f.org])).rows[0]!.count).toBe('2');
    });
    it('applies Card success using verified event time before an active deadline',async()=>{
      const reservation=await reserve(db,f,1);
      const card=await cardPayment(reservation.order_id);
      const eventTime=(await db.query<{value:string}>("select ($1::timestamptz-interval '1 second')::text value",[card.reservedUntil])).rows[0]!.value;
      expect(await card.apply('evt_card_active',eventTime)).toMatchObject({status:'applied',payment_status:'paid'});
      expect((await db.query('select status from public.orders where id=$1',[reservation.order_id])).rows[0]!.status).toBe('paid');
    });
    it('applies a pre-expiry Card event after delivery expiry and keeps retries idempotent',async()=>{
      const order=await historicalOrder(db,f,1,'pending_payment',true);
      const card=await cardPayment(order);
      const eventTime=(await db.query<{value:string}>("select ($1::timestamptz-interval '1 minute')::text value",[card.reservedUntil])).rows[0]!.value;
      expect(await card.apply('evt_card_late_delivery',eventTime)).toMatchObject({status:'applied',payment_status:'paid'});
      expect(await card.apply('evt_card_late_delivery',eventTime)).toMatchObject({status:'duplicate'});
      const stored=(await db.query('select status,provider_event_id,provider_event_created_at from public.payments where order_id=$1',[order])).rows[0]!;
      expect(stored).toMatchObject({status:'paid',provider_event_id:'evt_card_late_delivery'});
      expect((await db.query('select provider_event_created_at=$2::timestamptz matches from public.payments where order_id=$1',[order,eventTime])).rows[0]!.matches).toBe(true);
    });
    it('records reconciliation when Stripe success happened after the reservation deadline',async()=>{
      const order=await historicalOrder(db,f,1,'pending_payment',true);
      const card=await cardPayment(order);
      const eventTime=(await db.query<{value:string}>("select ($1::timestamptz+interval '1 second')::text value",[card.reservedUntil])).rows[0]!.value;
      expect(await card.apply('evt_card_after_expiry',eventTime)).toMatchObject({status:'reconciliation_required',reason:'event_after_reservation_expiry'});
      expect((await db.query('select status,provider_event_id from public.payments where order_id=$1',[order])).rows[0]).toMatchObject({status:'pending',provider_event_id:'evt_card_after_expiry'});
      expect((await db.query('select status from public.orders where id=$1',[order])).rows[0]!.status).toBe('pending_payment');
    });
    it.each(['expired','cancelled'] as const)('never resurrects an already %s order',async state=>{
      const order=await historicalOrder(db,f,1,state==='expired'?'pending_payment':'cancelled',true);
      if(state==='expired') await db.exec('select public.expire_reservations()');
      const card=await cardPayment(order);
      const eventTime=(await db.query<{value:string}>("select ($1::timestamptz-interval '1 minute')::text value",[card.reservedUntil])).rows[0]!.value;
      expect(await card.apply(`evt_card_${state}`,eventTime)).toMatchObject({status:'reconciliation_required',reason:'order_state'});
      expect((await db.query('select status from public.orders where id=$1',[order])).rows[0]!.status).toBe(state);
    });
    it('completes late Card success when limited capacity remains available',async()=>{
      await db.query('update public.events set capacity=1 where id=$1',[f.event]);
      await db.query('update public.ticket_types set capacity=1 where id=$1',[f.type]);
      const order=await historicalOrder(db,f,1,'pending_payment',true);
      const card=await cardPayment(order);
      const eventTime=(await db.query<{value:string}>("select ($1::timestamptz-interval '1 minute')::text value",[card.reservedUntil])).rows[0]!.value;
      expect(await card.apply('evt_card_capacity_available',eventTime)).toMatchObject({status:'applied'});
      expect((await db.query('select status from public.orders where id=$1',[order])).rows[0]!.status).toBe('paid');
    });
    it('records reconciliation without overbooking when late Card capacity was resold',async()=>{
      await db.query('update public.events set capacity=1 where id=$1',[f.event]);
      await db.query('update public.ticket_types set capacity=1 where id=$1',[f.type]);
      const oldOrder=await historicalOrder(db,f,1,'pending_payment',true);
      const card=await cardPayment(oldOrder);
      const replacement=await reserve(db,f,1);
      await db.query('select public.confirm_reserved_order($1,$2)',[f.org,replacement.order_id]);
      const eventTime=(await db.query<{value:string}>("select ($1::timestamptz-interval '1 minute')::text value",[card.reservedUntil])).rows[0]!.value;
      expect(await card.apply('evt_card_capacity_conflict',eventTime)).toMatchObject({status:'reconciliation_required',reason:'capacity_conflict'});
      expect((await db.query('select status from public.orders where id=$1',[oldOrder])).rows[0]!.status).toBe('pending_payment');
      expect((await db.query("select coalesce(sum(i.quantity),0)::text used from public.order_items i join public.orders o on o.id=i.order_id where o.event_id=$1 and o.status='paid'",[f.event])).rows[0]!.used).toBe('1');
    });
    it('preserves OXXO voucher processing and later success',async()=>{
      const reservation=await reserve(db,f,1);
      const provider=`pi_${randomUUID().replaceAll('-','')}`;
      await db.query(`insert into public.payments(organization_id,order_id,provider,provider_payment_id,method,status,amount,currency)
        select organization_id,id,'stripe',$2,'oxxo','pending',total,currency from public.orders where id=$1`,[reservation.order_id,provider]);
      const processing=(await db.query<{value:{status:string}}>(`select public.apply_stripe_payment_event(
        'evt_oxxo_processing',$1,'payment_intent.processing',1500,'USD','oxxo',now(),now()+interval '1 day','https://pay.example.invalid/voucher'
      ) value`,[provider])).rows[0]!.value;
      expect(processing.status).toBe('applied');
      const success=(await db.query<{value:{status:string;payment_status:string}}>(`select public.apply_stripe_payment_event(
        'evt_oxxo_success',$1,'payment_intent.succeeded',1500,'USD','oxxo',now()+interval '1 hour'
      ) value`,[provider])).rows[0]!.value;
      expect(success).toMatchObject({status:'applied',payment_status:'paid'});
      expect((await db.query('select status from public.orders where id=$1',[reservation.order_id])).rows[0]!.status).toBe('paid');
    });
    it('rejects ticket issuance for an unpaid order',async()=>{
      const reservation=await reserve(db,f,1);
      const {manifest}=await issuanceManifest(reservation.order_id);
      const result=(await db.query<{value:{status:string;reason:string}}>('select public.issue_tickets_for_paid_order($1,$2,$3::jsonb) value',[f.org,reservation.order_id,JSON.stringify(manifest)])).rows[0]!.value;
      expect(result).toEqual({status:'rejected',reason:'order_not_paid'});
      expect((await db.query('select id from public.tickets where order_id=$1',[reservation.order_id])).rows).toHaveLength(0);
    });
    it('issues exactly one secure ticket per paid unit and remains idempotent',async()=>{
      const reservation=await reserve(db,f,1,[{ticket_type_id:f.type,quantity:1},{ticket_type_id:f.secondType,quantity:2}]);
      await db.query('select public.confirm_reserved_order($1,$2)',[f.org,reservation.order_id]);
      await db.query(`insert into public.payments(organization_id,order_id,provider,provider_payment_id,method,status,amount,currency)
        values($1,$2,'stripe',$3,'card','paid',6500,'USD')`,[f.org,reservation.order_id,`pi_${randomUUID().replaceAll('-','')}`]);
      const first=await issuanceManifest(reservation.order_id);
      const issue=async(manifest:unknown)=>(await db.query<{value:{status:string;quantity:number;tickets:Array<Record<string,unknown>>}}>('select public.issue_tickets_for_paid_order($1,$2,$3::jsonb) value',[f.org,reservation.order_id,JSON.stringify(manifest)])).rows[0]!.value;
      expect(await issue(first.manifest)).toMatchObject({status:'issued',quantity:3});
      const retry=await issuanceManifest(reservation.order_id);
      expect(await issue(retry.manifest)).toMatchObject({status:'issued',quantity:3});
      const stored=(await db.query('select order_item_id,unit_index,public_code,secure_token_hash from public.tickets where order_id=$1 order by order_item_id,unit_index',[reservation.order_id])).rows;
      expect(stored).toHaveLength(3);
      expect(new Set(stored.map(row=>row.public_code)).size).toBe(3);
      expect(new Set(stored.map(row=>row.secure_token_hash)).size).toBe(3);
      expect(stored.filter(row=>row.unit_index===1)).toHaveLength(2);
      expect(stored.filter(row=>row.unit_index===2)).toHaveLength(1);
      const serialized=JSON.stringify(stored);
      for(const token of [...first.tokens,...retry.tokens])expect(serialized).not.toContain(token);
      expect((await db.query('select id from public.tickets where secure_token_hash=$1',[createHash('sha256').update(first.tokens[0]!).digest('hex')])).rows).toHaveLength(1);
    });
    it('rejects email delivery until payment and the complete ticket manifest exist',async()=>{
      const reservation=await reserve(db,f,1);
      const claim=async()=>(await db.query<{value:{status:string;reason:string}}>('select public.claim_order_ticket_email_delivery($1,$2) value',[f.org,reservation.order_id])).rows[0]!.value;
      expect(await claim()).toEqual({status:'rejected',reason:'order_not_paid'});
      await db.query('select public.confirm_reserved_order($1,$2)',[f.org,reservation.order_id]);
      await db.query(`insert into public.payments(organization_id,order_id,provider,provider_payment_id,method,status,amount,currency)
        values($1,$2,'stripe',$3,'card','paid',1500,'USD')`,[f.org,reservation.order_id,`pi_${randomUUID().replaceAll('-','')}`]);
      expect(await claim()).toEqual({status:'rejected',reason:'tickets_incomplete'});
    });
    it('claims one initial email delivery, persists sanitized failure and retries without financial mutation',async()=>{
      const reservation=await reserve(db,f,1);
      await db.query('select public.confirm_reserved_order($1,$2)',[f.org,reservation.order_id]);
      await db.query(`insert into public.payments(organization_id,order_id,provider,provider_payment_id,method,status,amount,currency)
        values($1,$2,'stripe',$3,'card','paid',1500,'USD')`,[f.org,reservation.order_id,`pi_${randomUUID().replaceAll('-','')}`]);
      const manifest=await issuanceManifest(reservation.order_id);
      await db.query('select public.issue_tickets_for_paid_order($1,$2,$3::jsonb)',[f.org,reservation.order_id,JSON.stringify(manifest.manifest)]);
      const claim=async()=>(await db.query<{value:{status:string;delivery_id:string;attempt_count?:number}}>('select public.claim_order_ticket_email_delivery($1,$2) value',[f.org,reservation.order_id])).rows[0]!.value;
      const first=await claim();expect(first).toMatchObject({status:'claimed',attempt_count:1});
      expect(await claim()).toMatchObject({status:'busy',delivery_id:first.delivery_id});
      await db.query("select public.finish_order_ticket_email_delivery($1,false,null,'UPSTREAM SECRET DETAIL')",[first.delivery_id]);
      const failed=(await db.query('select status,error_code from public.deliveries where id=$1',[first.delivery_id])).rows[0]!;
      expect(failed).toEqual({status:'failed',error_code:'provider_error'});
      const retry=await claim();expect(retry).toMatchObject({status:'claimed',delivery_id:first.delivery_id,attempt_count:2});
      await db.query("select public.finish_order_ticket_email_delivery($1,true,'resend_message_1',null)",[first.delivery_id]);
      expect(await claim()).toMatchObject({status:'already_sent',delivery_id:first.delivery_id});
      expect((await db.query('select count(*)::int count from public.deliveries where order_id=$1',[reservation.order_id])).rows[0]!.count).toBe(1);
      expect((await db.query('select status from public.orders where id=$1',[reservation.order_id])).rows[0]!.status).toBe('paid');
      expect((await db.query('select status from public.payments where order_id=$1',[reservation.order_id])).rows[0]!.status).toBe('paid');
      expect((await db.query('select status from public.tickets where order_id=$1',[reservation.order_id])).rows[0]!.status).toBe('valid');
    });
    it('creates an idempotent manual resend without mutating the initial delivery or financial state',async()=>{
      const reservation=await reserve(db,f,1);
      await db.query('select public.confirm_reserved_order($1,$2)',[f.org,reservation.order_id]);
      await db.query(`insert into public.payments(organization_id,order_id,provider,provider_payment_id,method,status,amount,currency)
        values($1,$2,'stripe',$3,'card','paid',1500,'USD')`,[f.org,reservation.order_id,`pi_${randomUUID().replaceAll('-','')}`]);
      const manifest=await issuanceManifest(reservation.order_id);
      await db.query('select public.issue_tickets_for_paid_order($1,$2,$3::jsonb)',[f.org,reservation.order_id,JSON.stringify(manifest.manifest)]);
      const claim=async(purpose:string,sequence:number)=>(await db.query<{value:{status:string;delivery_id:string;attempt_count?:number}}>('select public.claim_order_ticket_email_delivery_controlled($1,$2,$3,$4) value',[f.org,reservation.order_id,purpose,sequence])).rows[0]!.value;
      const initial=await claim('tickets_initial',1);expect(initial).toMatchObject({status:'claimed'});
      await db.query("select public.finish_order_ticket_email_delivery_controlled($1,true,'resend_initial',null)",[initial.delivery_id]);
      const initialBefore=(await db.query('select status,provider_message_id,attempt_count from public.deliveries where id=$1',[initial.delivery_id])).rows[0]!;
      const manual=await claim('tickets_manual',1);expect(manual).toMatchObject({status:'claimed',attempt_count:1});
      await db.query("select public.finish_order_ticket_email_delivery_controlled($1,true,'resend_manual_1',null)",[manual.delivery_id]);
      expect(await claim('tickets_manual',1)).toMatchObject({status:'already_sent',delivery_id:manual.delivery_id});
      expect((await db.query('select status,provider_message_id,attempt_count from public.deliveries where id=$1',[initial.delivery_id])).rows[0]).toEqual(initialBefore);
      const identities=(await db.query('select purpose,sequence,status from public.deliveries where order_id=$1 order by purpose,sequence',[reservation.order_id])).rows;
      expect(identities).toEqual([{purpose:'tickets_initial',sequence:1,status:'sent'},{purpose:'tickets_manual',sequence:1,status:'sent'}]);
      expect((await db.query('select status from public.orders where id=$1',[reservation.order_id])).rows[0]!.status).toBe('paid');
      expect((await db.query('select status from public.payments where order_id=$1',[reservation.order_id])).rows[0]!.status).toBe('paid');
      expect((await db.query('select count(*)::int count from public.tickets where order_id=$1',[reservation.order_id])).rows[0]!.count).toBe(1);
      await expect(db.query("select public.claim_order_ticket_email_delivery_controlled($1,$2,'tickets_initial',2)",[f.org,reservation.order_id])).rejects.toThrow();
    });
  });
}
suite('Inventory hardening PostgreSQL embedded');
if(process.env.TEST_DATABASE_URL)suite('Inventory hardening Supabase local',process.env.TEST_DATABASE_URL);
else it.skip('Inventory hardening Supabase local requires TEST_DATABASE_URL');
