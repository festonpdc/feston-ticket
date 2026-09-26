import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertIsolatedDestructiveTarget } from './remote-guard';
import { availability, historicalOrder, inventoryDB, reserve, seedInventory, type InventoryDB, type InventoryFixture } from './inventory-support';

function suite(name: string, url?: string) {
  describe(name, () => {
    let db: InventoryDB; let close: () => Promise<void>; let f: InventoryFixture;
    beforeAll(async () => { if (url) assertIsolatedDestructiveTarget(); ({ db, close } = await inventoryDB(url)); });
    afterAll(async () => { if (close) await close(); });
    beforeEach(async () => { await db.exec('begin'); f = await seedInventory(db); });
    afterEach(async () => { await db.exec('rollback'); });
    async function reject(work: () => Promise<unknown>, code?: string) {
      await db.exec('savepoint expected_failure');
      try {
        if (code) await expect(work()).rejects.toMatchObject({ code });
        else await expect(work()).rejects.toThrow();
      } finally { await db.exec('rollback to savepoint expected_failure'); }
    }
    async function available() { return Number((await availability(db,f)).find(r => r.ticket_type_id===f.type)!.available_quantity); }
    async function command(name: 'cancel_reservation'|'confirm_reserved_order', id: string, org = f.org) {
      return db.query(`select public.${name}($1,$2)`,[org,id]);
    }
    it('A: capacity 100 - sold 20 - live reserved 10 = 70', async () => {
      await historicalOrder(db,f,20,'paid',false);
      await reserve(db,f,10);
      expect(await available()).toBe(70);
      const counts = (await db.query('select * from private.inventory_counts($1,$2,clock_timestamp())',[f.org,f.event])).rows;
      expect(Number(counts[0]!.sold)).toBe(20);
      expect(Number(counts[0]!.reserved)).toBe(10);
    });
    it('B: expired pending reservations immediately stop consuming, without a job', async () => {
      await historicalOrder(db,f,10,'pending_payment',true);
      expect(await available()).toBe(100);
    });
    it('C: paid keeps consuming after deadline; refunded conservatively does too', async () => {
      await historicalOrder(db,f,20,'paid',false);
      await historicalOrder(db,f,5,'refunded',false);
      const result = (await db.query("select * from private.inventory_counts($1,$2,clock_timestamp()+interval '2 days')",[f.org,f.event])).rows[0]!;
      expect(Number(result.sold)).toBe(25);
      expect(Number(result.reserved)).toBe(0);
    });
    it('D: cancellation releases inventory and is idempotent', async () => {
      const order = await reserve(db,f,3);
      expect(await available()).toBe(97);
      await command('cancel_reservation',order.order_id);
      await command('cancel_reservation',order.order_id);
      expect(await available()).toBe(100);
      expect((await db.query("select * from public.audit_logs where entity_id=$1 and event_type='reservation_cancelled'",[order.order_id])).rows).toHaveLength(1);
    });
    it('E: rejects types/customers/events from another tenant, and wrong event in same tenant', async () => {
      const other = await seedInventory(db);
      await reject(() => reserve(db,{...f,type:other.type}), '22023');
      await reject(() => reserve(db,{...f,customer:other.customer}), '22023');
      await reject(() => reserve(db,{...f,event:other.event}), '22023');
      await db.query(`insert into public.events(organization_id,location_id,name,slug,starts_at,ends_at,timezone,status)
        select organization_id,location_id,'Other','other',starts_at,ends_at,timezone,'published' from public.events where id=$1`,[f.event]);
      const otherEvent = (await db.query("select id from public.events where organization_id=$1 and slug='other'",[f.org])).rows[0]!.id as string;
      await reject(() => reserve(db,{...f,event:otherEvent}), '22023');
      expect((await db.query('select * from public.orders where organization_id=$1',[f.org])).rows).toHaveLength(0);
    });
    it.each([0,-1,11,2147483648,0.5])('rejects invalid or above-default quantity %s atomically', async q => {
      await reject(() => reserve(db,f,q));
      expect((await db.query('select * from public.orders where organization_id=$1',[f.org])).rows).toHaveLength(0);
      expect((await db.query('select * from public.order_items')).rows).toHaveLength(0);
      expect((await db.query('select * from public.audit_logs')).rows).toHaveLength(0);
    });
    it('rejects empty, duplicate, malformed lines and client prices', async () => {
      for (const input of [[],{},[{}],[{ ticket_type_id:f.type,quantity:1,price:0 }], [{ ticket_type_id:f.type,quantity:'1' }],
        [{ ticket_type_id:f.type,quantity:1 },{ ticket_type_id:f.type.toUpperCase(),quantity:1 }]]) {
        await reject(() => reserve(db,f,1,input));
      }
      await reject(() => reserve(db,f,1,[{ticket_type_id:f.type,quantity:6},{ticket_type_id:f.secondType,quantity:5}]),'22023');
    });
    it('reserves multiple types with DB prices and frozen totals', async () => {
      const result = await reserve(db,f,1,[{ ticket_type_id:f.type,quantity:2 },{ ticket_type_id:f.secondType,quantity:3 }]);
      expect(result.total).toBe(10500); expect(result.subtotal).toBe(10500); expect(result.currency).toBe('USD');
      await db.query('update public.ticket_types set price=9999 where id=$1',[f.type]);
      expect((await db.query('select unit_price::text from public.order_items where order_id=$1 and ticket_type_id=$2',[result.order_id,f.type])).rows).toEqual([{ unit_price:'1500' }]);
      expect(await available()).toBe(98);
      const delta = (await db.query('select extract(epoch from reserved_until-created_at) as seconds from public.orders where id=$1',[result.order_id])).rows[0]!.seconds;
      expect(Number(delta)).toBeGreaterThanOrEqual(900); expect(Number(delta)).toBeLessThan(905);
    });
    it('central settings change TTL/max; amount overflow and mixed currencies reject', async () => {
      await db.exec('update private.inventory_settings set online_reservation_seconds=120,max_tickets_per_order=2');
      await reject(() => reserve(db,f,3), '22023');
      const order = await reserve(db,f,2);
      const seconds = Number((await db.query('select extract(epoch from reserved_until-created_at) as seconds from public.orders where id=$1',[order.order_id])).rows[0]!.seconds);
      expect(seconds).toBeGreaterThanOrEqual(120); expect(seconds).toBeLessThan(125);
      await db.query("update public.ticket_types set currency='ARS' where id=$1",[f.secondType]);
      await reject(() => reserve(db,f,1,[{ ticket_type_id:f.type,quantity:1 },{ ticket_type_id:f.secondType,quantity:1 }]),'22023');
      await db.query('update public.ticket_types set price=9007199254740991 where id=$1',[f.type]);
      await reject(() => reserve(db,f,2),'22003');
    });
    it.each(['draft','sales_closed','completed','cancelled'])('rejects event status %s and returns no private draft details', async state => {
      await db.query('update public.events set status=$2::public.event_status where id=$1',[f.event,state]);
      await reject(() => reserve(db,f),'23514');
      const rows = await availability(db,f);
      if (state==='sales_closed') expect(rows.every(r=>!r.sales_open)).toBe(true);
      else expect(rows).toHaveLength(0);
    });
    it.each(['draft','paused','sold_out','archived'])('rejects inactive type %s', async state => {
      await db.query('update public.ticket_types set status=$2::public.ticket_type_status where id=$1',[f.type,state]);
      await reject(() => reserve(db,f),'23514');
    });
    it.each(['events','ticket_types'])('validates future/open/closed sale windows in %s', async table => {
      const target = table==='events' ? f.event : f.type;
      await db.query(`update public.${table} set sales_start=now()+interval '1 hour' where id=$1`,[target]);
      await reject(() => reserve(db,f),'23514');
      expect((await availability(db,f)).find(r=>r.ticket_type_id===f.type)!.sales_open).toBe(false);
      await db.query(`update public.${table} set sales_start=now()-interval '2 hours',sales_end=now()-interval '1 hour' where id=$1`,[target]);
      await reject(() => reserve(db,f),'23514');
      await db.query(`update public.${table} set sales_end=now()+interval '1 hour' where id=$1`,[target]);
      await reserve(db,f);
    });
    it('sold-out type rejects entire multi-type order without partial writes', async () => {
      await db.query('update public.ticket_types set capacity=0 where id=$1',[f.secondType]);
      await reject(() => reserve(db,f,1,[{ ticket_type_id:f.type,quantity:2 },{ ticket_type_id:f.secondType,quantity:1 }]),'23514');
      expect((await db.query('select * from public.orders where organization_id=$1',[f.org])).rows).toHaveLength(0);
      expect((await db.query('select * from public.order_items')).rows).toHaveLength(0);
      expect((await db.query('select * from public.audit_logs')).rows).toHaveLength(0);
    });
    it('event capacity limits reservations across different types and prevents unsafe capacity edits', async () => {
      await db.query('update public.events set capacity=2 where id=$1',[f.event]);
      await reserve(db,f,2);
      await reject(() => reserve(db,{...f,type:f.secondType}),'23514');
      expect((await availability(db,f)).every(r=>Number(r.available_quantity)===0)).toBe(true);
      await reject(() => db.query('update public.events set capacity=1 where id=$1',[f.event]),'23514');
      await reject(() => db.query('update public.ticket_types set capacity=1 where id=$1',[f.type]),'23514');
    });
    it('confirmation is idempotent, preserves totals and issues no payments/tickets', async () => {
      const order = await reserve(db,f,2);
      await command('confirm_reserved_order',order.order_id);
      await command('confirm_reserved_order',order.order_id);
      await reject(() => command('cancel_reservation',order.order_id),'23514');
      expect(await available()).toBe(98);
      expect((await db.query('select total::text,status from public.orders where id=$1',[order.order_id])).rows).toEqual([{total:'3000',status:'paid'}]);
      for (const table of ['payments','tickets']) expect((await db.query(`select * from public.${table}`)).rows).toHaveLength(0);
      expect((await db.query("select * from public.audit_logs where event_type='order_confirmed'")).rows).toHaveLength(1);
    });
    it('expiration is idempotent, bounded, respects cutoff and never expires paid', async () => {
      const old = await historicalOrder(db,f,3,'pending_payment',true);
      await historicalOrder(db,f,2,'paid',false);
      await reserve(db,f,1);
      await reject(() => command('confirm_reserved_order',old),'23514');
      await reject(() => db.exec("select public.expire_reservations(clock_timestamp()+interval '1 hour')"),'22023');
      expect(Number((await db.query('select public.expire_reservations() as count')).rows[0]!.count)).toBe(1);
      expect(Number((await db.query('select public.expire_reservations() as count')).rows[0]!.count)).toBe(0);
      expect((await db.query('select status from public.orders where id=$1',[old])).rows[0]!.status).toBe('expired');
      expect(await available()).toBe(97);
      expect((await db.query("select * from public.audit_logs where event_type='reservation_expired'")).rows).toHaveLength(1);
    });
    it('cross-organization cancellation/confirmation cannot touch orders', async () => {
      const order = await reserve(db,f); const other = await seedInventory(db);
      await reject(() => command('cancel_reservation',order.order_id,other.org),'22023');
      await reject(() => command('confirm_reserved_order',order.order_id,other.org),'22023');
    });
    it('expiration obeys batch bounds and older cutoff without freeing future reservations', async () => {
      await historicalOrder(db,f,2,'pending_payment',true);
      await historicalOrder(db,f,3,'pending_payment',true);
      await reserve(db,f,1);
      expect(Number((await db.query("select public.expire_reservations(clock_timestamp()-interval '2 hours',1) as count")).rows[0]!.count)).toBe(0);
      for(const expected of [1,1,0]) expect(Number((await db.query('select public.expire_reservations(clock_timestamp(),1) as count')).rows[0]!.count)).toBe(expected);
      await reject(()=>db.exec('select public.expire_reservations(clock_timestamp(),0)'),'22023');
      expect(await available()).toBe(99);
    });
    it('anonymous projection is narrow; anon/authenticated cannot execute mutation RPCs', async () => {
      const order = await reserve(db,f);
      for (const role of ['anon','authenticated']) {
        await db.exec(`set local role ${role}`);
        const rows = await availability(db,f);
        expect(Object.keys(rows[0]!).sort()).toEqual(['available_quantity','commercial_occupancy','currency','display_price_label','name','price','release_label','release_sequence','sales_open','status','ticket_type_id']);
        await reject(() => reserve(db,f),'42501');
        await reject(() => command('cancel_reservation',order.order_id),'42501');
        await reject(() => command('confirm_reserved_order',order.order_id),'42501');
        await reject(() => db.exec('select public.expire_reservations()'),'42501');
        await reject(() => db.exec('select * from private.inventory_settings'),'42501');
        await db.exec('reset role');
      }
    });
    it('service_role can execute commands but cannot directly insert financial rows', async () => {
      await db.exec('set local role service_role');
      const result = await reserve(db,f);
      await command('confirm_reserved_order',result.order_id);
      await reject(() => db.exec(`update public.orders set status='refunded' where organization_id='${f.org}'`),'42501');
      await db.exec('reset role');
    });
    it('complimentary is explicitly identified, zero-only, and blocked until issuance command exists', async () => {
      await reject(() => db.query(`insert into public.orders(organization_id,event_id,customer_id,public_code,currency,subtotal,total,order_kind)
        values($1,$2,$3,$4,'USD',1,1,'complimentary')`,[f.org,f.event,f.customer,`ORD_${'a'.repeat(32)}`]),'23514');
      const order = await reserve(db,f);
      await reject(() => db.query("update public.orders set order_kind='complimentary' where id=$1",[order.order_id]),'23514');
    });
    it('varied reserve/cancel/confirm/expire sequences never exceed capacity', async () => {
      await db.query('update public.ticket_types set capacity=8 where id=$1',[f.type]);
      for (let step=0; step<30; step++) {
        const free = await available();
        if (free>0) {
          const order = await reserve(db,f,Math.min(free,1+step%3));
          if (step%3===0) await command('confirm_reserved_order',order.order_id);
          else await command('cancel_reservation',order.order_id);
        }
        await db.exec('select public.expire_reservations()');
        const c = (await db.query('select * from private.inventory_counts($1,$2,clock_timestamp()) where ticket_type_id=$3',[f.org,f.event,f.type])).rows[0];
        const used = c ? Number(c.sold)+Number(c.reserved) : 0;
        expect(used).toBeLessThanOrEqual(8); expect(await available()).toBe(8-used);
      }
    });
  });
}
suite('Inventory PostgreSQL embedded');
if (process.env.TEST_DATABASE_URL) suite('Inventory Supabase local',process.env.TEST_DATABASE_URL);
else it.skip('Inventory Supabase local requires TEST_DATABASE_URL');
